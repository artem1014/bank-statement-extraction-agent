import { Buffer } from 'node:buffer';
import OpenAI, { toFile } from 'openai';
import type { Config } from '../config.js';
import { ExtractionFailedError, LlmUnavailableError } from '../domain/errors.js';
import { logger } from '../utils/logger.js';
import {
  PERIOD_EXTRACT_SCHEMA,
  PERIOD_MARKER_SCHEMA,
  TRANSACTIONS_ONLY_SCHEMA,
} from './openai-schemas.js';

export interface PeriodMarker {
  chunk_start_page: number;
  chunk_end_page: number;
  continues_before_chunk: boolean;
  continues_past_chunk: boolean;
  start_date: string | null;
  end_date: string | null;
  account_last4: string | null;
  bank: string | null;
}

export interface RawLlmExtraction {
  account: {
    bank: string | null;
    account_last4: string | null;
    period: { start: string; end: string };
  };
  summary: {
    beginning_balance: number;
    ending_balance: number;
    deposits_total: number;
    deposits_count: number;
    withdrawals_total: number;
    withdrawals_count: number;
  };
  transactions: Array<{
    date: string;
    description: string;
    deposit: number | null;
    withdrawal: number | null;
    source_span: { page: number | null; char_start: number | null; char_end: number | null };
  }>;
  extraction: { warnings: string[] };
}

export interface TransactionRow {
  date: string;
  description: string;
  deposit: number | null;
  withdrawal: number | null;
  source_span: { page: number | null; char_start: number | null; char_end: number | null };
}

export interface RawTransactionsOnly {
  transactions: TransactionRow[];
  warnings: string[];
}

export interface PeriodHint {
  start_date: string | null;
  end_date: string | null;
  account_last4: string | null;
  bank: string | null;
}

export interface OpenAIPipelineClient {
  readonly model: string;
  indexPeriods(pdfChunk: Uint8Array, chunkLabel: string): Promise<PeriodMarker[]>;
  extractPeriod(
    pdfChunk: Uint8Array,
    chunkLabel: string,
    hint: PeriodHint,
  ): Promise<RawLlmExtraction>;
  extractTransactionRows(
    pdfChunk: Uint8Array,
    chunkLabel: string,
    hint: PeriodHint,
    pageWindow: { startInPeriod: number; endInPeriod: number },
  ): Promise<RawTransactionsOnly>;
}

const INDEX_SYSTEM_PROMPT = `You are a careful document analyst. You will receive a PDF chunk that is part of a larger multi-statement document. Each chunk may contain one or more bank-statement periods, possibly continuing from the previous chunk or into the next one.

Your job is to enumerate every statement period that has any page in this chunk. A "statement period" is a single bank-statement document — it begins where a new cover/header page is printed (look for repeated section markers like "Statement Date", "Statement Period", "For the period", "Account Activity", or a fresh address block / new "Beginning Balance") and ends at the next such marker or at the end of the chunk.

CRITICAL granularity rule:
- Emit ONE marker per discrete printed statement header you see, NEVER glue two consecutive monthly statements into one even if they share the same account number. If you see two "Statement Date" headers (one for April, one for May), that is TWO markers, not one with start_date=April-1 / end_date=May-31.
- Even if the same account appears in 4 different months in this chunk, that is 4 separate markers.
- If two distinct headers exist on the same chunk pages with DIFFERENT account_last4 values, that is also two markers (do not merge them).

For each marker, report:
- chunk_start_page / chunk_end_page: 1-indexed page range INSIDE THIS CHUNK ONLY (page 1 = first page of the chunk).
- continues_before_chunk: true iff this period's cover page is NOT in the chunk (i.e. it started in an earlier chunk).
- continues_past_chunk: true iff the period extends past the last page of this chunk (no "Ending Balance" / closing section visible inside the chunk).
- start_date, end_date: ISO YYYY-MM-DD, or null if not printed in this chunk.
- account_last4: trailing 4 digits of the account number, exactly 4 ASCII digits, or null. If the printed last-4 differs between cover page and transaction header within the same period, report what the cover page shows.
- bank: bank name as printed, or null.

If a value is not visible IN THIS CHUNK, return null. Never guess or copy from a neighbouring marker.`;

const TX_ONLY_SYSTEM_PROMPT = `You are a bank-statement transaction extractor. You will receive a PDF slice (typically 1-3 pages) that is a fragment of a larger single-period bank statement. Your only job is to enumerate the transaction-detail rows printed on these pages and return them in the supplied JSON schema.

# Hard rules

1. **Emit every transaction row visible on these pages.** Do NOT abbreviate, do NOT write "..." or "omitted for brevity". The slice is small precisely so you can be exhaustive. If you see 47 rows, return 47 entries. If you see 2 rows, return 2.

2. **Exclusions** — do NOT emit these as transactions (they are summary/header lines):
   - "BEGINNING BALANCE", "ENDING BALANCE", "OPENING BALANCE", "CLOSING BALANCE"
   - "DAILY ENDING BALANCE" rows
   - "TOTAL DEPOSITS", "TOTAL WITHDRAWALS", "TOTAL CREDITS", "TOTAL DEBITS"
   - "SUBTOTAL", section subtotals, running-total / running-balance rows
   - Page-header / page-footer banner lines, statement-period header lines, account-info blocks

3. **Direction**: each row has exactly ONE of {deposit, withdrawal} non-null. The other is null. ONLY IF a row's direction is genuinely ambiguous in the printed source, set both to null AND add a warning "ambiguous-direction: <date> '<description>'".

4. **Amounts**: positive numbers, decimal point only, no commas, no currency symbols.

5. **Dates**: ISO YYYY-MM-DD. If the year is implied by the statement period header (e.g. only "04-15" is printed), use the period's year.

6. **Multi-line descriptions**: join continuation lines into the SAME row's description, separated by a single space. A multi-line description still counts as ONE transaction.

7. **Order**: preserve the printed order.

8. **source_span.page**: 1-indexed relative to the SUPPLIED slice (not the original document).

# Output

If the slice contains no transaction-detail rows (e.g. it's a cover page or summary page only), return transactions=[] and an explanatory warning.`;

const EXTRACT_SYSTEM_PROMPT = `You are a bank-statement extraction engine. You will receive a PDF containing exactly ONE statement period. Read every printed transaction row and emit a complete structured representation via the supplied JSON schema.

# Hard requirements (violations are extraction failures)

1. **Emit every single transaction line printed in the statement.** The "Transactions" array MUST contain one entry per printed row. Do NOT summarise, do NOT abbreviate, do NOT write "..." or "list omitted for brevity". If the printed summary says deposits_count=237, emit 237 deposit rows. If withdrawals_count=120, emit 120 withdrawal rows. Length-matching is mandatory:
   transactions.filter(t => t.deposit  !== null).length === summary.deposits_count
   transactions.filter(t => t.withdrawal !== null).length === summary.withdrawals_count

   **Exclusions**: do NOT emit "BEGINNING BALANCE", "ENDING BALANCE", "TOTAL DEPOSITS", "TOTAL WITHDRAWALS", "DAILY ENDING BALANCE", page-header / page-footer banner lines, or any "subtotal" / "running total" rows. Those belong to summary, not to transactions. Transactions are ONLY the line items inside the chronological "Transaction Detail" / "Account Activity" / "Deposits and Other Credits" / "Withdrawals, Checks and Other Debits" tables.

   **Pre-submit self-check**: after composing transactions, count deposit-rows (deposit !== null) and withdrawal-rows (withdrawal !== null). If those counts do NOT match summary.deposits_count and summary.withdrawals_count, re-scan the document for missed rows. Multi-line descriptions count as ONE row.

2. **Document-grounded only.** Every value MUST come from printed text in the PDF. Never invent dates, amounts, account numbers, or descriptions. If a value is not present or unreadable, emit null and append a warning to extraction.warnings — never guess.

3. **account.account_last4**: trailing 4 digits of the account number, as a string of exactly 4 ASCII digits (e.g. "4664"), or null. If multiple last-4 candidates appear, prefer the one printed on the statement cover page / header block.

4. **Dates**: ISO YYYY-MM-DD. Calendar dates only.

5. **Amounts**: positive numbers. The column (deposit vs withdrawal) conveys the sign. No commas, no currency symbols, no thousands separators. Decimal point only.

6. **Direction rule**: per row, exactly ONE of {deposit, withdrawal} is non-null. The other is null. ONLY IF the row's direction is genuinely ambiguous in the printed source, set BOTH to null AND add a warning of the form "ambiguous-direction: <date> '<description>' p.<page>".

7. **summary.\\*** MUST equal the bank's printed aggregates from the statement's "Account Activity" / "Summary" section. Use the bank's printed numbers verbatim — do not recompute. The server computes reconciliation separately.

8. **Order**: emit transactions in the order they appear in the statement (chronological as printed). Do not deduplicate, sort, or filter.

9. **source_span.page**: 1-indexed relative to the SUPPLIED PDF (not the original document). char_start / char_end may be null if you cannot pinpoint a character offset.

# Output policy

- Do NOT omit transactions to save tokens. The schema and downstream consumer require the full list.
- If you genuinely cannot read certain rows, still emit them with description="<unreadable>" and deposit/withdrawal=null AND attach a per-row warning.
- A response with transactions=[] but summary.deposits_count > 0 OR summary.withdrawals_count > 0 is INVALID and will be rejected.`;

export function createOpenAIClient(config: Config): OpenAIPipelineClient {
  const client = new OpenAI({ apiKey: config.OPENAI_API_KEY });

  async function uploadChunk(pdfChunk: Uint8Array, label: string): Promise<string> {
    try {
      const file = await client.files.create({
        file: await toFile(Buffer.from(pdfChunk), `${label}.pdf`, {
          type: 'application/pdf',
        }),
        purpose: 'user_data',
      });
      return file.id;
    } catch (err) {
      throw new LlmUnavailableError(undefined, err);
    }
  }

  async function deleteFile(fileId: string): Promise<void> {
    try {
      await client.files.del(fileId);
    } catch (err) {
      logger.warn({ fileId, err }, 'failed-to-delete-uploaded-file');
    }
  }

  async function callResponses(args: {
    fileId: string;
    schemaName: string;
    schema: object;
    systemPrompt: string;
    userPrompt: string;
    maxOutputTokens: number;
  }): Promise<unknown> {
    try {
      const resp = await client.responses.create({
        model: config.OPENAI_MODEL,
        temperature: 0,
        max_output_tokens: args.maxOutputTokens,
        input: [
          { role: 'system', content: args.systemPrompt },
          {
            role: 'user',
            content: [
              { type: 'input_file', file_id: args.fileId },
              { type: 'input_text', text: args.userPrompt },
            ],
          },
        ],
        text: {
          format: {
            type: 'json_schema',
            name: args.schemaName,
            schema: args.schema as Record<string, unknown>,
            strict: true,
          },
        },
      });
      const text = resp.output_text;
      if (!text) {
        throw new ExtractionFailedError(
          'LLM returned no output_text; possibly hit max_output_tokens or a refusal.',
        );
      }
      try {
        return JSON.parse(text);
      } catch (e) {
        throw new ExtractionFailedError('LLM output was not valid JSON.', e);
      }
    } catch (err) {
      if (err instanceof OpenAI.APIError) {
        if (err.status >= 500 || err.status === 429) {
          throw new LlmUnavailableError(undefined, err);
        }
        throw new ExtractionFailedError(`OpenAI error: ${err.message}`, err);
      }
      if (err instanceof ExtractionFailedError || err instanceof LlmUnavailableError) {
        throw err;
      }
      throw new LlmUnavailableError(undefined, err);
    }
  }

  return {
    model: config.OPENAI_MODEL,

    async indexPeriods(pdfChunk, chunkLabel) {
      const fileId = await uploadChunk(pdfChunk, chunkLabel);
      try {
        const raw = await callResponses({
          fileId,
          schemaName: 'list_periods',
          schema: PERIOD_MARKER_SCHEMA as unknown as object,
          systemPrompt: INDEX_SYSTEM_PROMPT,
          userPrompt: `Enumerate every statement period visible in this PDF chunk (${chunkLabel}). Use chunk-local 1-indexed page numbers. Return ONLY the JSON object — no prose.`,
          maxOutputTokens: 4096,
        });
        return (raw as { periods: PeriodMarker[] }).periods;
      } finally {
        await deleteFile(fileId);
      }
    },

    async extractTransactionRows(pdfChunk, chunkLabel, hint, pageWindow) {
      const fileId = await uploadChunk(pdfChunk, chunkLabel);
      try {
        const hintBlock = [
          hint.bank ? `Bank: ${hint.bank}` : null,
          hint.account_last4 ? `Account: •••• ${hint.account_last4}` : null,
          hint.start_date && hint.end_date
            ? `Statement period: ${hint.start_date} to ${hint.end_date}`
            : null,
          `These are pages ${pageWindow.startInPeriod}-${pageWindow.endInPeriod} of the full period PDF.`,
        ]
          .filter(Boolean)
          .join('\n');

        const raw = await callResponses({
          fileId,
          schemaName: 'list_transactions',
          schema: TRANSACTIONS_ONLY_SCHEMA as unknown as object,
          systemPrompt: TX_ONLY_SYSTEM_PROMPT,
          userPrompt: `${hintBlock}\n\nEnumerate every transaction-detail row printed on these pages. Be exhaustive — the slice is intentionally small. Return ONLY the JSON object.`,
          maxOutputTokens: 16_384,
        });
        return raw as RawTransactionsOnly;
      } finally {
        await deleteFile(fileId);
      }
    },

    async extractPeriod(pdfChunk, chunkLabel, hint) {
      const fileId = await uploadChunk(pdfChunk, chunkLabel);
      try {
        const hintBlock =
          [
            hint.bank ? `Expected bank: ${hint.bank}` : null,
            hint.account_last4 ? `Expected account_last4: ${hint.account_last4}` : null,
            hint.start_date && hint.end_date
              ? `Expected period: ${hint.start_date} to ${hint.end_date}`
              : null,
          ]
            .filter(Boolean)
            .join('\n') || '(no hints — extract whatever single period is in this PDF)';

        const raw = await callResponses({
          fileId,
          schemaName: 'submit_extraction',
          schema: PERIOD_EXTRACT_SCHEMA as unknown as object,
          systemPrompt: EXTRACT_SYSTEM_PROMPT,
          userPrompt: `${hintBlock}\n\nExtract the bank statement period contained in this PDF. Emit EVERY transaction row printed in the document — do not abbreviate. The transactions array length MUST equal summary.deposits_count + summary.withdrawals_count + (any ambiguous-direction rows). Return ONLY the JSON object that matches the schema.`,
          maxOutputTokens: 32_768,
        });
        return raw as RawLlmExtraction;
      } finally {
        await deleteFile(fileId);
      }
    },
  };
}

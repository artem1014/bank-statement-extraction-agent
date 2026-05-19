import { Buffer } from 'node:buffer';
import { ExtractResultSchema } from '@app/contracts';
import { ExtractionFailedError, OcrSidecarInvalidError } from '../domain/errors.js';
import type { ExtractResult, Transaction } from '../domain/types.js';
import { mapWithConcurrency } from '../utils/concurrency.js';
import { withCorrelation } from '../utils/logger.js';
import type { ExtractProgressEvent } from './extract.js';
import { type OcrSidecar, type ParsedPeriodSpan, parseOcrSidecar } from './ocr-sidecar.js';
import type { ParsedSummary } from './ocr-summary-parser.js';
import { parseSummaryBlock } from './ocr-summary-parser.js';
import { parseTransactionsForPeriod } from './ocr-tx-parser.js';
import type { OpenAIPipelineClient, RawLlmExtraction } from './openai-client.js';
import { countPages, splitPdf } from './pdf-splitter.js';
import { buildSummary, reconcile } from './reconcile.js';

const OCR_PARSE_CONCURRENCY = 5;
const LLM_FALLBACK_CONCURRENCY = 3;
const PROMPT_VERSION_OCR = 'ocr-parser-v1';

export type ExtractionMode = 'ocr-first' | 'ocr-only';

export interface ExtractWithOcrFirstInput {
  pdfBytes: Uint8Array;
  ocrText: string;
  client: OpenAIPipelineClient;
  mode: ExtractionMode;
  promptVersion: string;
  chunkBudgetBytes: number;
  requestId: string;
  onProgress?: (event: ExtractProgressEvent) => void | Promise<void>;
}

interface PeriodWorkRecord {
  spec: ParsedPeriodSpan;
  summary: ParsedSummary;
  transactions: Transaction[];
  warnings: string[];
  llmFiredForSummary: boolean;
  llmFiredForTransactions: boolean;
}

export async function extractWithOcrFirst(
  input: ExtractWithOcrFirstInput,
): Promise<ExtractResult[]> {
  const log = withCorrelation(input.requestId);
  const emit = async (e: ExtractProgressEvent): Promise<void> => {
    if (input.onProgress) await input.onProgress(e);
  };

  await emit({ stage: 'parse', status: 'active', detail: 'parsing OCR sidecar' });
  const totalPdfPages = await countPages(input.pdfBytes);
  const sidecar = parseOcrSidecar(input.ocrText, totalPdfPages);

  if (sidecar.periods.length === 0) {
    throw new OcrSidecarInvalidError('OCR sidecar contained no recognisable statement periods.');
  }
  if (sidecar.periods.length > 100) {
    throw new OcrSidecarInvalidError(
      `OCR sidecar period count (${sidecar.periods.length}) is implausible.`,
    );
  }

  const mismatchWarning = detectSidecarPdfMismatch(sidecar, input.pdfBytes);
  log.info(
    {
      periodCount: sidecar.periods.length,
      tableCount: sidecar.tableBlocks.length,
      mode: input.mode,
      mismatch: mismatchWarning !== null,
    },
    'ocr-sidecar-parsed',
  );
  await emit({
    stage: 'parse',
    status: 'done',
    detail: `${sidecar.periods.length} periods, ${sidecar.tableBlocks.length} tables`,
  });

  await emit({
    stage: 'extract',
    status: 'active',
    detail: `mode=${input.mode}: parsing ${sidecar.periods.length} periods`,
  });

  const records = await mapWithConcurrency(
    sidecar.periods,
    OCR_PARSE_CONCURRENCY,
    async (period) => {
      const summary = parseSummaryBlock(sidecar, period);
      const txResult = parseTransactionsForPeriod(sidecar, period);
      return {
        spec: period,
        summary,
        transactions: txResult.transactions,
        warnings: txResult.warnings,
        llmFiredForSummary: false,
        llmFiredForTransactions: false,
      } as PeriodWorkRecord;
    },
  );

  if (input.mode === 'ocr-first') {
    await runLlmFallback(records, input, sidecar, emit, log);
  } else {
    for (const r of records) {
      const missing = collectMissingSummaryFields(r.summary);
      if (missing.length > 0) {
        for (const f of missing) r.warnings.push(`ocr-only-missing: summary.${f}`);
      }
      if (r.transactions.length === 0) {
        r.warnings.push('ocr-only-missing: transactions');
      }
    }
  }

  if (mismatchWarning) {
    for (const r of records) r.warnings.push(mismatchWarning);
  }

  await emit({ stage: 'extract', status: 'done', detail: 'per-period extraction done' });

  await emit({ stage: 'reconcile', status: 'active' });
  const sorted = [...records].sort((a, b) => a.spec.ocrLineStart - b.spec.ocrLineStart);
  const results = sorted.map((r) =>
    reduceToExtractResult(r, input.client.model, input.promptVersion),
  );
  await emit({ stage: 'reconcile', status: 'done' });

  return results;
}

function detectSidecarPdfMismatch(sidecar: OcrSidecar, pdfBytes: Uint8Array): string | null {
  const sidecarLast4 = new Set<string>();
  for (const p of sidecar.periods) {
    if (p.account_last4) sidecarLast4.add(p.account_last4);
  }
  if (sidecarLast4.size === 0) return null;
  const sample = Buffer.from(pdfBytes.subarray(0, Math.min(pdfBytes.length, 5_000_000))).toString(
    'binary',
  );
  const hasAnyFourDigits = /\b\d{4}\b/.test(sample);
  if (!hasAnyFourDigits) return null;
  for (const last4 of sidecarLast4) {
    if (sample.includes(last4)) return null;
  }
  return 'sidecar-pdf-mismatch: no sidecar account_last4 found in PDF byte sample';
}

function collectMissingSummaryFields(s: ParsedSummary): string[] {
  const fields: Array<keyof ParsedSummary> = [
    'beginning_balance',
    'ending_balance',
    'deposits_total',
    'deposits_count',
    'withdrawals_total',
    'withdrawals_count',
  ];
  return fields.filter((f) => s[f] === null);
}

async function runLlmFallback(
  records: PeriodWorkRecord[],
  input: ExtractWithOcrFirstInput,
  _sidecar: OcrSidecar,
  emit: (e: ExtractProgressEvent) => Promise<void>,
  log: ReturnType<typeof withCorrelation>,
): Promise<void> {
  const fallbackTasks = records
    .map((r, idx) => {
      const missing = collectMissingSummaryFields(r.summary);
      const needsTx = r.transactions.length === 0;
      return missing.length > 0 || needsTx ? { idx, missing, needsTx, record: r } : null;
    })
    .filter(
      (t): t is { idx: number; missing: string[]; needsTx: boolean; record: PeriodWorkRecord } =>
        t !== null,
    );

  if (fallbackTasks.length === 0) {
    log.info('ocr-first: zero LLM fallbacks needed');
    return;
  }
  log.info(
    { fallbackCount: fallbackTasks.length, total: records.length },
    'ocr-first-llm-fallback-triggered',
  );
  await emit({
    stage: 'extract',
    status: 'active',
    detail: `LLM fallback for ${fallbackTasks.length}/${records.length} periods`,
  });

  await mapWithConcurrency(fallbackTasks, LLM_FALLBACK_CONCURRENCY, async (task) => {
    const r = task.record;
    const label = `period-${r.spec.start_date}-fallback`;
    const pdfBytes =
      r.spec.absoluteStartPage > 0 && r.spec.absoluteEndPage >= r.spec.absoluteStartPage
        ? await sliceAbsolutePages(
            input.pdfBytes,
            r.spec.absoluteStartPage,
            r.spec.absoluteEndPage,
            input.chunkBudgetBytes,
          )
        : input.pdfBytes;
    try {
      const llm = await input.client.extractPeriod(pdfBytes, label, {
        start_date: r.spec.start_date,
        end_date: r.spec.end_date,
        account_last4: r.spec.account_last4,
        bank: r.spec.bank,
      });
      mergeLlmIntoRecord(r, llm, task.missing, task.needsTx);
      if (task.missing.length > 0) {
        r.llmFiredForSummary = true;
        for (const f of task.missing) r.warnings.push(`recovered-via-llm: summary.${f}`);
      }
      if (task.needsTx) {
        r.llmFiredForTransactions = true;
        r.warnings.push('recovered-via-llm: transactions');
      }
    } catch (err) {
      log.warn({ err, period: r.spec.start_date }, 'llm-fallback-failed');
      r.warnings.push(
        `ocr-only-missing: ${task.missing.map((f) => `summary.${f}`).join(',')}${task.needsTx ? (task.missing.length ? ',transactions' : 'transactions') : ''}`,
      );
    }
  });
}

function mergeLlmIntoRecord(
  r: PeriodWorkRecord,
  llm: RawLlmExtraction,
  missing: string[],
  needsTx: boolean,
): void {
  for (const f of missing) {
    const key = f as keyof ParsedSummary;
    const llmVal = (llm.summary as unknown as Record<string, number | null>)[f as string];
    if (llmVal !== undefined && llmVal !== null) {
      (r.summary as unknown as Record<string, number>)[key as string] = llmVal;
    }
  }
  if (r.summary.bank === null && llm.account?.bank) r.summary.bank = llm.account.bank;
  if (r.summary.account_last4 === null && llm.account?.account_last4)
    r.summary.account_last4 = llm.account.account_last4;
  if (needsTx) {
    const llmTx = (llm.transactions ?? []).map(
      (t): Transaction => ({
        date: t.date,
        description: t.description,
        deposit: t.deposit,
        withdrawal: t.withdrawal,
        source_span: {
          page: t.source_span?.page ?? null,
          char_start: null,
          char_end: null,
        },
      }),
    );
    r.transactions = llmTx;
  }
}

async function sliceAbsolutePages(
  source: Uint8Array,
  startPage: number,
  endPage: number,
  byteBudget: number,
): Promise<Uint8Array> {
  const total = endPage - startPage + 1;
  const chunks = await splitPdf(source, {
    maxBytesPerChunk: byteBudget,
    maxPagesPerChunk: total,
  });
  for (const c of chunks) {
    if (c.startPage <= startPage && c.endPage >= endPage) {
      if (c.startPage === startPage && c.endPage === endPage) return c.bytes;
    }
  }
  const { PDFDocument } = await import('pdf-lib');
  const src = await PDFDocument.load(source);
  const sub = await PDFDocument.create();
  const indices = Array.from({ length: total }, (_, i) => startPage - 1 + i);
  const pages = await sub.copyPages(src, indices);
  for (const p of pages) sub.addPage(p);
  return sub.save({ useObjectStreams: true });
}

function reduceToExtractResult(
  r: PeriodWorkRecord,
  model: string,
  legacyPromptVersion: string,
): ExtractResult {
  const account = {
    bank: r.summary.bank,
    account_last4: r.summary.account_last4,
    period: { start: r.summary.period.start, end: r.summary.period.end },
  };

  const beginning_balance = r.summary.beginning_balance ?? 0;
  const ending_balance = r.summary.ending_balance ?? 0;
  const deposits_total = r.summary.deposits_total ?? 0;
  const deposits_count = r.summary.deposits_count ?? 0;
  const withdrawals_total = r.summary.withdrawals_total ?? 0;
  const withdrawals_count = r.summary.withdrawals_count ?? 0;

  const reconcileResult = reconcile({
    beginning_balance,
    ending_balance,
    deposits_total,
    deposits_count,
    withdrawals_total,
    withdrawals_count,
    transactions: r.transactions,
  });

  const summary = buildSummary(
    {
      beginning_balance,
      ending_balance,
      deposits_total,
      deposits_count,
      withdrawals_total,
      withdrawals_count,
      transactions: r.transactions,
    },
    reconcileResult.reconciliation,
  );

  const usedLlm = r.llmFiredForSummary || r.llmFiredForTransactions;
  const candidate = {
    account,
    summary,
    transactions: r.transactions,
    extraction: {
      model: usedLlm ? `ocr+${model}` : 'ocr-deterministic',
      prompt_version: usedLlm ? `${PROMPT_VERSION_OCR}+${legacyPromptVersion}` : PROMPT_VERSION_OCR,
      duration_ms: 0,
      warnings: [...r.warnings, ...reconcileResult.warnings],
    },
  };

  const parsed = ExtractResultSchema.safeParse(candidate);
  if (!parsed.success) {
    throw new ExtractionFailedError(
      `OCR-first assembled extraction failed Zod validation: ${parsed.error.issues
        .map((i) => `${i.path.join('.')}: ${i.message}`)
        .slice(0, 6)
        .join('; ')}`,
    );
  }
  return parsed.data;
}

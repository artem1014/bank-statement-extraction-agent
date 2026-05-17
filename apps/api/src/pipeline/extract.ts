import { ExtractResultSchema } from '@app/contracts';
import { ExtractionFailedError } from '../domain/errors.js';
import type { ExtractResult, Transaction } from '../domain/types.js';
import { logger } from '../utils/logger.js';
import type {
  OpenAIPipelineClient,
  PeriodHint,
  PeriodMarker,
  RawLlmExtraction,
  TransactionRow,
} from './openai-client.js';
import { type PdfChunk, splitPdf } from './pdf-splitter.js';
import { buildSummary, reconcile } from './reconcile.js';

const TX_PAGE_WINDOW = 2;

export interface ExtractProgressEvent {
  stage: 'parse' | 'extract' | 'reconcile';
  status: 'active' | 'done' | 'error';
  detail?: string;
}

export interface ExtractInput {
  pdfBytes: Uint8Array;
  client: OpenAIPipelineClient;
  promptVersion: string;
  chunkBudgetBytes: number;
  chunkPageBudget: number;
  onProgress?: (e: ExtractProgressEvent) => void | Promise<void>;
}

interface IndexedPeriod {
  key: string;
  bank: string | null;
  account_last4: string | null;
  start_date: string;
  end_date: string;
  absoluteStartPage: number;
  absoluteEndPage: number;
}

export async function extractPdf(input: ExtractInput): Promise<ExtractResult[]> {
  const emit = async (e: ExtractProgressEvent): Promise<void> => {
    if (input.onProgress) await input.onProgress(e);
  };

  await emit({ stage: 'parse', status: 'active' });
  const chunks = await splitPdf(input.pdfBytes, {
    maxBytesPerChunk: input.chunkBudgetBytes,
    maxPagesPerChunk: input.chunkPageBudget,
  });
  logger.info(
    { totalChunks: chunks.length, totalPages: chunks.at(-1)?.endPage ?? 0 },
    'pdf-split-done',
  );
  await emit({ stage: 'parse', status: 'done', detail: `${chunks.length} chunks` });

  await emit({ stage: 'extract', status: 'active', detail: 'indexing periods' });
  const indexed = await indexAllPeriods(chunks, input.client);
  logger.info({ periods: indexed.length }, 'index-done');
  await emit({
    stage: 'extract',
    status: 'active',
    detail: `${indexed.length} periods found; extracting each`,
  });

  const results: ExtractResult[] = [];
  for (const [i, period] of indexed.entries()) {
    await emit({
      stage: 'extract',
      status: 'active',
      detail: `period ${i + 1}/${indexed.length}: ${period.start_date}…${period.end_date} (•••• ${period.account_last4 ?? '????'})`,
    });
    const periodPdf = await sliceAbsolutePages(
      input.pdfBytes,
      period.absoluteStartPage,
      period.absoluteEndPage,
      input.chunkBudgetBytes,
    );

    const summaryRaw = await extractWithRetry(input.client, periodPdf, period);
    const chunkedTxs = await extractAllTransactionsInWindows(
      input.client,
      periodPdf,
      period,
      input.chunkBudgetBytes,
    );

    const merged = mergeTransactionPool(summaryRaw.transactions, chunkedTxs);
    summaryRaw.transactions = merged;
    const result = assembleResult(summaryRaw, period, input.client.model, input.promptVersion);
    results.push(result);
  }
  await emit({ stage: 'extract', status: 'done' });

  await emit({ stage: 'reconcile', status: 'active' });
  await emit({ stage: 'reconcile', status: 'done' });

  return results;
}

async function indexAllPeriods(
  chunks: PdfChunk[],
  client: OpenAIPipelineClient,
): Promise<IndexedPeriod[]> {
  const allMarkers: Array<{ marker: PeriodMarker; chunk: PdfChunk }> = [];
  for (const chunk of chunks) {
    const label = `chunk-${chunk.index + 1}-pages-${chunk.startPage}-${chunk.endPage}`;
    const markers = await client.indexPeriods(chunk.bytes, label);
    for (const m of markers) allMarkers.push({ marker: m, chunk });
  }

  type Bucket = {
    bank: string | null;
    account_last4: string | null;
    start_date: string | null;
    end_date: string | null;
    minAbs: number;
    maxAbs: number;
  };
  const buckets: Bucket[] = [];

  for (const { marker, chunk } of allMarkers) {
    const absoluteStart = chunk.startPage + marker.chunk_start_page - 1;
    const absoluteEnd = chunk.startPage + marker.chunk_end_page - 1;
    const key = bucketKey(marker.start_date, marker.end_date, marker.account_last4);

    const existing = buckets.find(
      (b) => bucketKey(b.start_date, b.end_date, b.account_last4) === key && key !== ':',
    );

    if (existing) {
      existing.minAbs = Math.min(existing.minAbs, absoluteStart);
      existing.maxAbs = Math.max(existing.maxAbs, absoluteEnd);
      existing.bank ??= marker.bank;
      existing.account_last4 ??= marker.account_last4;
      existing.start_date ??= marker.start_date;
      existing.end_date ??= marker.end_date;
    } else if (marker.continues_before_chunk && buckets.length > 0 && key === ':') {
      const tail = buckets[buckets.length - 1] as Bucket;
      tail.maxAbs = Math.max(tail.maxAbs, absoluteEnd);
    } else {
      buckets.push({
        bank: marker.bank,
        account_last4: marker.account_last4,
        start_date: marker.start_date,
        end_date: marker.end_date,
        minAbs: absoluteStart,
        maxAbs: absoluteEnd,
      });
    }
  }

  buckets.sort((a, b) => a.minAbs - b.minAbs);

  return buckets
    .filter((b) => b.start_date && b.end_date)
    .map((b, i) => ({
      key: `${b.start_date}_${b.end_date}_${b.account_last4 ?? 'unknown'}_${i}`,
      bank: b.bank,
      account_last4: b.account_last4,
      start_date: b.start_date as string,
      end_date: b.end_date as string,
      absoluteStartPage: b.minAbs,
      absoluteEndPage: b.maxAbs,
    }));
}

function bucketKey(start: string | null, end: string | null, last4: string | null): string {
  return `${start ?? ''}:${end ?? ''}:${last4 ?? ''}`;
}

async function sliceAbsolutePages(
  source: Uint8Array,
  startPage: number,
  endPage: number,
  byteBudget: number,
): Promise<Uint8Array> {
  const totalNeeded = endPage - startPage + 1;
  const allChunks = await splitPdf(source, {
    maxBytesPerChunk: byteBudget,
    maxPagesPerChunk: totalNeeded,
  });
  for (const c of allChunks) {
    if (c.startPage <= startPage && c.endPage >= endPage) {
      const offsetStart = startPage - c.startPage + 1;
      const offsetEnd = endPage - c.startPage + 1;
      if (offsetStart === 1 && offsetEnd === c.endPage - c.startPage + 1) {
        return c.bytes;
      }
      const sliced = await splitPdf(c.bytes, {
        maxBytesPerChunk: byteBudget,
        maxPagesPerChunk: offsetEnd - offsetStart + 1,
      });
      const match = sliced.find((s) => s.startPage === offsetStart && s.endPage === offsetEnd);
      if (match) return match.bytes;
    }
  }
  const sliced = await splitPdfPreciseRange(source, startPage, endPage);
  return sliced;
}

async function splitPdfPreciseRange(
  source: Uint8Array,
  startPage: number,
  endPage: number,
): Promise<Uint8Array> {
  const { PDFDocument } = await import('pdf-lib');
  const src = await PDFDocument.load(source);
  const sub = await PDFDocument.create();
  const indices = Array.from({ length: endPage - startPage + 1 }, (_, i) => startPage - 1 + i);
  const pages = await sub.copyPages(src, indices);
  for (const p of pages) sub.addPage(p);
  return sub.save({ useObjectStreams: true });
}

async function extractAllTransactionsInWindows(
  client: OpenAIPipelineClient,
  periodPdf: Uint8Array,
  period: IndexedPeriod,
  byteBudget: number,
): Promise<TransactionRow[]> {
  const slices = await splitPdf(periodPdf, {
    maxBytesPerChunk: byteBudget,
    maxPagesPerChunk: TX_PAGE_WINDOW,
  });
  const hint: PeriodHint = {
    start_date: period.start_date,
    end_date: period.end_date,
    account_last4: period.account_last4,
    bank: period.bank,
  };
  const all: TransactionRow[] = [];
  for (const s of slices) {
    const label = `period-${period.start_date}-tx-${s.startPage}-${s.endPage}`;
    try {
      const part = await client.extractTransactionRows(s.bytes, label, hint, {
        startInPeriod: s.startPage,
        endInPeriod: s.endPage,
      });
      for (const t of part.transactions) {
        all.push({
          ...t,
          source_span: {
            ...t.source_span,
            page: t.source_span?.page != null ? t.source_span.page + s.startPage - 1 : null,
          },
        });
      }
    } catch (e) {
      logger.warn({ err: e, period: period.key, slice: label }, 'tx-window-failed');
    }
  }
  return all;
}

function mergeTransactionPool(
  fromSummaryCall: TransactionRow[],
  fromWindowCalls: TransactionRow[],
): TransactionRow[] {
  const dedupKey = (t: TransactionRow): string =>
    `${t.date}|${t.description.trim().toLowerCase().replace(/\s+/g, ' ')}|${t.deposit ?? 'n'}|${t.withdrawal ?? 'n'}`;

  const seen = new Set<string>();
  const out: TransactionRow[] = [];
  for (const t of fromWindowCalls) {
    const k = dedupKey(t);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(t);
  }
  for (const t of fromSummaryCall) {
    const k = dedupKey(t);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(t);
  }
  return out;
}

async function extractWithRetry(
  client: OpenAIPipelineClient,
  pdfBytes: Uint8Array,
  period: IndexedPeriod,
): Promise<RawLlmExtraction> {
  const label = `period-${period.start_date}-${period.end_date}`;
  const hint = {
    start_date: period.start_date,
    end_date: period.end_date,
    account_last4: period.account_last4,
    bank: period.bank,
  };
  let first: RawLlmExtraction;
  try {
    first = await client.extractPeriod(pdfBytes, label, hint);
  } catch (e) {
    logger.warn({ err: e, period: period.key }, 'extract-retry-after-error');
    return client.extractPeriod(pdfBytes, `${label}-retry`, hint);
  }

  const declaredCount =
    (first.summary?.deposits_count ?? 0) + (first.summary?.withdrawals_count ?? 0);
  const emittedCount = first.transactions?.length ?? 0;
  const tooFew = declaredCount > 0 && emittedCount < Math.max(1, Math.floor(declaredCount * 0.5));

  if (tooFew) {
    logger.warn(
      {
        period: period.key,
        declaredCount,
        emittedCount,
        firstWarning: first.extraction?.warnings?.[0],
      },
      'extract-retry-insufficient-transactions',
    );
    try {
      const second = await client.extractPeriod(pdfBytes, `${label}-retry`, hint);
      const secondEmitted = second.transactions?.length ?? 0;
      return secondEmitted >= emittedCount ? second : first;
    } catch (e) {
      logger.warn({ err: e, period: period.key }, 'retry-failed-keeping-first');
      return first;
    }
  }

  return first;
}

function assembleResult(
  raw: RawLlmExtraction,
  period: IndexedPeriod,
  model: string,
  promptVersion: string,
): ExtractResult {
  const account = {
    bank: raw.account?.bank ?? period.bank ?? null,
    account_last4: raw.account?.account_last4 ?? period.account_last4 ?? null,
    period: {
      start: raw.account?.period?.start ?? period.start_date,
      end: raw.account?.period?.end ?? period.end_date,
    },
  };

  const BOUNDARY_DESCRIPTIONS =
    /^(beginning|ending|opening|closing)\s+balance$|^(daily\s+)?(ending|opening|closing)\s+balance$|^total\s+(deposits|withdrawals|credits|debits)$/i;
  const filteredOut: string[] = [];
  const transactions: Transaction[] = (raw.transactions ?? [])
    .filter((t) => {
      const isBoundary =
        t.deposit === null &&
        t.withdrawal === null &&
        BOUNDARY_DESCRIPTIONS.test(t.description.trim());
      if (isBoundary) filteredOut.push(t.description.trim());
      return !isBoundary;
    })
    .map((t) => ({
      date: t.date,
      description: t.description,
      deposit: t.deposit,
      withdrawal: t.withdrawal,
      source_span: {
        page: t.source_span?.page ?? null,
        char_start: t.source_span?.char_start ?? null,
        char_end: t.source_span?.char_end ?? null,
      },
    }));
  if (filteredOut.length > 0) {
    logger.info(
      { period: period.key, filtered: filteredOut.length, sample: filteredOut.slice(0, 3) },
      'filtered-boundary-rows',
    );
  }

  const reconcileResult = reconcile({
    beginning_balance: raw.summary.beginning_balance,
    ending_balance: raw.summary.ending_balance,
    deposits_total: raw.summary.deposits_total,
    deposits_count: raw.summary.deposits_count,
    withdrawals_total: raw.summary.withdrawals_total,
    withdrawals_count: raw.summary.withdrawals_count,
    transactions,
  });

  const summary = buildSummary(
    {
      beginning_balance: raw.summary.beginning_balance,
      ending_balance: raw.summary.ending_balance,
      deposits_total: raw.summary.deposits_total,
      deposits_count: raw.summary.deposits_count,
      withdrawals_total: raw.summary.withdrawals_total,
      withdrawals_count: raw.summary.withdrawals_count,
      transactions,
    },
    reconcileResult.reconciliation,
  );

  const candidate = {
    account,
    summary,
    transactions,
    extraction: {
      model,
      prompt_version: promptVersion,
      duration_ms: 0,
      warnings: [...(raw.extraction?.warnings ?? []), ...reconcileResult.warnings],
    },
  };

  const parsed = ExtractResultSchema.safeParse(candidate);
  if (!parsed.success) {
    throw new ExtractionFailedError(
      `Assembled extraction failed Zod validation: ${parsed.error.issues
        .map((i) => `${i.path.join('.')}: ${i.message}`)
        .slice(0, 6)
        .join('; ')}`,
    );
  }
  return parsed.data;
}

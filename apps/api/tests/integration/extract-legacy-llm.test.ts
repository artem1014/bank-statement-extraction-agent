import { PDFDocument } from 'pdf-lib';
import { describe, expect, it } from 'vitest';
import { extractDispatch } from '../../src/pipeline/extract.js';
import type {
  OpenAIPipelineClient,
  PeriodHint,
  PeriodMarker,
  RawLlmExtraction,
  RawTransactionsOnly,
} from '../../src/pipeline/openai-client.js';

async function makeOnePagePdf(): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const page = doc.addPage([300, 400]);
  page.drawText('Bank statement Apr 2025', { x: 20, y: 200, size: 12 });
  return doc.save({ useObjectStreams: false });
}

function makeLegacyClient(calls: { count: number }): OpenAIPipelineClient {
  return {
    model: 'gpt-4.1-stub',
    async indexPeriods(): Promise<PeriodMarker[]> {
      calls.count += 1;
      return [
        {
          chunk_start_page: 1,
          chunk_end_page: 1,
          continues_before_chunk: false,
          continues_past_chunk: false,
          start_date: '2025-04-01',
          end_date: '2025-04-30',
          account_last4: '1234',
          bank: 'Test Bank',
        },
      ];
    },
    async extractPeriod(_b: Uint8Array, _l: string, h: PeriodHint): Promise<RawLlmExtraction> {
      calls.count += 1;
      return {
        account: {
          bank: h.bank,
          account_last4: h.account_last4,
          period: { start: '2025-04-01', end: '2025-04-30' },
        },
        summary: {
          beginning_balance: 100,
          ending_balance: 150,
          deposits_total: 100,
          deposits_count: 1,
          withdrawals_total: 50,
          withdrawals_count: 1,
        },
        transactions: [
          {
            date: '2025-04-10',
            description: 'DEP',
            deposit: 100,
            withdrawal: null,
            source_span: { page: 1, char_start: null, char_end: null },
          },
          {
            date: '2025-04-20',
            description: 'WD',
            deposit: null,
            withdrawal: 50,
            source_span: { page: 1, char_start: null, char_end: null },
          },
        ],
        extraction: { warnings: [] },
      };
    },
    async extractTransactionRows(): Promise<RawTransactionsOnly> {
      calls.count += 1;
      return { transactions: [], warnings: [] };
    },
  };
}

describe('extractDispatch legacy LLM-only path', () => {
  it('runs the legacy pipeline when no sidecar is provided', async () => {
    const pdfBytes = await makeOnePagePdf();
    const calls = { count: 0 };
    const results = await extractDispatch({
      pdfBytes,
      client: makeLegacyClient(calls),
      promptVersion: 'v2.1.0',
      chunkBudgetBytes: 28 * 1024 * 1024,
      chunkPageBudget: 20,
      mode: 'ocr-first',
      requestId: 'test-legacy',
    });
    expect(results.length).toBe(1);
    const result = results[0];
    if (!result) return;
    expect(result.extraction.model).toBe('gpt-4.1-stub');
    expect(result.extraction.warnings.filter((w) => w.startsWith('recovered-via-llm:'))).toEqual(
      [],
    );
    expect(calls.count).toBeGreaterThan(0);
  });

  it('ignores the sidecar when EXTRACTION_MODE=llm-only', async () => {
    const pdfBytes = await makeOnePagePdf();
    const calls = { count: 0 };
    const results = await extractDispatch({
      pdfBytes,
      ocrText:
        '=== Document Text ===\nBeginning Balance as of 04/01/2025\nEnding Balance as of 04/30/2025',
      client: makeLegacyClient(calls),
      promptVersion: 'v2.1.0',
      chunkBudgetBytes: 28 * 1024 * 1024,
      chunkPageBudget: 20,
      mode: 'llm-only',
      requestId: 'test-llm-only',
    });
    expect(results.length).toBe(1);
    const result = results[0];
    if (!result) return;
    expect(result.extraction.warnings).toContain('llm-only-mode-ignored-sidecar');
    expect(calls.count).toBeGreaterThan(0);
  });
});

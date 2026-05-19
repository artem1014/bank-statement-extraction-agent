import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { extractDispatch } from '../../src/pipeline/extract.js';
import type {
  OpenAIPipelineClient,
  PeriodHint,
  RawLlmExtraction,
} from '../../src/pipeline/openai-client.js';

const PDF = resolve(import.meta.dirname, '..', '..', '..', '..', 'Binder2_Redacted.pdf');
const RTF = resolve(import.meta.dirname, '..', '..', '..', '..', 'Bank Statement.rtf');

function deleteMayBlock(rtf: string): string {
  const beginIdx = rtf.indexOf('Beginning Balance as of 05/01/2025');
  const endMarkerIdx = rtf.indexOf('Beginning Balance as of 06/01/2024');
  if (beginIdx < 0 || endMarkerIdx < 0 || beginIdx > endMarkerIdx) return rtf;
  return `${rtf.slice(0, beginIdx)}${rtf.slice(endMarkerIdx)}`;
}

function makeStubClient(calls: { count: number }): OpenAIPipelineClient {
  return {
    model: 'gpt-4.1-stub',
    async indexPeriods(): Promise<never> {
      throw new Error('indexPeriods MUST NOT be called when sidecar is present');
    },
    async extractPeriod(_b: Uint8Array, _l: string, h: PeriodHint): Promise<RawLlmExtraction> {
      calls.count += 1;
      return {
        account: {
          bank: h.bank,
          account_last4: h.account_last4,
          period: {
            start: h.start_date ?? '2025-05-01',
            end: h.end_date ?? '2025-05-31',
          },
        },
        summary: {
          beginning_balance: 1000,
          ending_balance: 1100,
          deposits_total: 200,
          deposits_count: 1,
          withdrawals_total: 100,
          withdrawals_count: 1,
        },
        transactions: [
          {
            date: '2025-05-15',
            description: 'STUB DEPOSIT',
            deposit: 200,
            withdrawal: null,
            source_span: { page: 1, char_start: null, char_end: null },
          },
          {
            date: '2025-05-20',
            description: 'STUB WITHDRAWAL',
            deposit: null,
            withdrawal: 100,
            source_span: { page: 1, char_start: null, char_end: null },
          },
        ],
        extraction: { warnings: [] },
      };
    },
    async extractTransactionRows(): Promise<never> {
      throw new Error('extractTransactionRows MUST NOT be called from fallback path');
    },
  };
}

describe('extractDispatch ocr-first partial sidecar', () => {
  it.runIf(existsSync(PDF) && existsSync(RTF))(
    'falls back to LLM for the period missing its block, leaves others OCR-deterministic',
    async () => {
      const pdfBytes = new Uint8Array(readFileSync(PDF));
      const baseRtf = readFileSync(RTF, 'utf8');
      const partialRtf = deleteMayBlock(baseRtf);
      const calls = { count: 0 };
      const client = makeStubClient(calls);
      const results = await extractDispatch({
        pdfBytes,
        ocrText: partialRtf,
        client,
        promptVersion: 'v2.1.0',
        chunkBudgetBytes: 28 * 1024 * 1024,
        chunkPageBudget: 20,
        mode: 'ocr-first',
        requestId: 'test-partial',
      });

      const mayPeriods = results.filter((r) => r.account.period.start === '2025-05-01');
      const otherPeriods = results.filter((r) => r.account.period.start !== '2025-05-01');

      expect(mayPeriods.length).toBe(0);
      expect(otherPeriods.length).toBe(9);
      for (const r of otherPeriods) {
        expect(r.extraction.model).toBe('ocr-deterministic');
        const llm = r.extraction.warnings.filter((w) => w.startsWith('recovered-via-llm:'));
        expect(llm).toEqual([]);
      }
      expect(calls.count).toBe(0);
    },
    60_000,
  );
});

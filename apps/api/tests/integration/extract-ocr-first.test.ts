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

function makeThrowingClient(): OpenAIPipelineClient {
  return {
    model: 'test-stub-gpt',
    async indexPeriods(): Promise<never> {
      throw new Error('indexPeriods MUST NOT be called on the OCR-first happy path');
    },
    async extractPeriod(_b: Uint8Array, _l: string, _h: PeriodHint): Promise<RawLlmExtraction> {
      throw new Error('extractPeriod MUST NOT be called on the OCR-first happy path');
    },
    async extractTransactionRows(): Promise<never> {
      throw new Error('extractTransactionRows MUST NOT be called on the OCR-first happy path');
    },
  };
}

describe('extractDispatch ocr-first happy path', () => {
  it.runIf(existsSync(PDF) && existsSync(RTF))(
    'completes in < 30s with 10 periods and zero LLM calls',
    async () => {
      const pdfBytes = new Uint8Array(readFileSync(PDF));
      const ocrText = readFileSync(RTF, 'utf8');
      const client = makeThrowingClient();
      const t0 = Date.now();
      const results = await extractDispatch({
        pdfBytes,
        ocrText,
        client,
        promptVersion: 'v2.1.0',
        chunkBudgetBytes: 28 * 1024 * 1024,
        chunkPageBudget: 20,
        mode: 'ocr-first',
        requestId: 'test-ocr-first',
      });
      const elapsed = Date.now() - t0;
      expect(results.length).toBe(10);
      for (const r of results) {
        expect(r.extraction.model).toBe('ocr-deterministic');
        const llmWarnings = r.extraction.warnings.filter((w) => w.startsWith('recovered-via-llm:'));
        expect(llmWarnings).toEqual([]);
      }
      expect(elapsed).toBeLessThan(30_000);
    },
    60_000,
  );

  it.runIf(existsSync(PDF) && existsSync(RTF))(
    'April 2025 headline numbers match the human reference',
    async () => {
      const pdfBytes = new Uint8Array(readFileSync(PDF));
      const ocrText = readFileSync(RTF, 'utf8');
      const client = makeThrowingClient();
      const results = await extractDispatch({
        pdfBytes,
        ocrText,
        client,
        promptVersion: 'v2.1.0',
        chunkBudgetBytes: 28 * 1024 * 1024,
        chunkPageBudget: 20,
        mode: 'ocr-first',
        requestId: 'test-april',
      });
      const april = results.find((r) => r.account.period.start === '2025-04-01');
      expect(april).toBeDefined();
      if (!april) return;
      expect(april.summary.beginning_balance).toBeCloseTo(597068.7, 2);
      expect(april.summary.ending_balance).toBeCloseTo(509121.59, 2);
      expect(april.summary.deposits_total).toBeCloseTo(1214254.05, 2);
      expect(april.summary.deposits_count).toBe(81);
      expect(april.summary.withdrawals_total).toBeCloseTo(1302201.16, 2);
      expect(april.summary.withdrawals_count).toBe(111);
    },
    60_000,
  );
});

import { PDFDocument } from 'pdf-lib';
import { describe, expect, it } from 'vitest';
import { extractWithOcrFirst } from '../../src/pipeline/ocr-orchestrator.js';
import type { OpenAIPipelineClient } from '../../src/pipeline/openai-client.js';

function makeStubClient(): OpenAIPipelineClient {
  return {
    model: 'gpt-4.1-stub',
    async indexPeriods(): Promise<never> {
      throw new Error('indexPeriods MUST NOT be called');
    },
    async extractPeriod(): Promise<never> {
      throw new Error('extractPeriod MUST NOT be called in this test');
    },
    async extractTransactionRows(): Promise<never> {
      throw new Error('extractTransactionRows MUST NOT be called');
    },
  };
}

async function makeMinimalPdfBytes(): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const page = doc.addPage([300, 400]);
  page.drawText('Account 1234 not 9999', { x: 20, y: 200, size: 12 });
  return doc.save({ useObjectStreams: false });
}

const SIDECAR = [
  '=== Document Text ===',
  'Account Number XXXX9999',
  'Beginning Balance as of 04/01/2025',
  '$100.00',
  '+ Deposits and Credits (1)',
  '$50.00',
  '- Withdrawals and Debits (1)',
  '$40.00',
  'Ending Balance as of 04/30/2025',
  '$110.00',
].join('\n');

describe('extractWithOcrFirst sidecar-pdf mismatch', () => {
  it('attaches sidecar-pdf-mismatch warning when account_last4 not present in PDF', async () => {
    const pdfBytes = await makeMinimalPdfBytes();
    const results = await extractWithOcrFirst({
      pdfBytes,
      ocrText: SIDECAR,
      client: makeStubClient(),
      mode: 'ocr-only',
      promptVersion: 'v2.1.0',
      chunkBudgetBytes: 28 * 1024 * 1024,
      requestId: 'test-mismatch',
    });
    expect(results.length).toBe(1);
    const result = results[0];
    if (!result) return;
    const mismatch = result.extraction.warnings.find((w) => w.startsWith('sidecar-pdf-mismatch'));
    expect(mismatch).toBeDefined();
  });
});

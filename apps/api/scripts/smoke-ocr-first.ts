import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { config as loadEnvFromDotenv } from 'dotenv';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(SCRIPT_DIR, '..', '..', '..');

if (existsSync(resolve(REPO_ROOT, '.env'))) {
  loadEnvFromDotenv({ path: resolve(REPO_ROOT, '.env') });
}

const { config } = await import('../src/config.js');
const { extractWithOcrFirst } = await import('../src/pipeline/ocr-orchestrator.js');
const { createOpenAIClient } = await import('../src/pipeline/openai-client.js');

async function main(): Promise<void> {
  const pdfPath = resolve(REPO_ROOT, 'Binder2_Redacted.pdf');
  const rtfPath = resolve(REPO_ROOT, 'Bank Statement.rtf');
  if (!existsSync(pdfPath) || !existsSync(rtfPath)) {
    console.error(`fixture missing — expected ${pdfPath} and ${rtfPath}`);
    process.exit(2);
  }
  const pdfBytes = new Uint8Array(readFileSync(pdfPath));
  const ocrText = readFileSync(rtfPath, 'utf8');

  const t0 = Date.now();
  const results = await extractWithOcrFirst({
    pdfBytes,
    ocrText,
    client: createOpenAIClient(config),
    mode: 'ocr-first',
    promptVersion: 'v2.1.0',
    chunkBudgetBytes: config.OPENAI_CHUNK_BUDGET_BYTES,
    requestId: 'smoke',
  });
  const elapsed = Date.now() - t0;

  const rows = results.map((r) => {
    const llm = r.extraction.warnings.filter((w) => w.startsWith('recovered-via-llm:')).length;
    return {
      period: `${r.account.period.start}…${r.account.period.end}`,
      last4: r.account.account_last4 ?? '????',
      model: r.extraction.model,
      tx: r.transactions.length,
      'declared tx': r.summary.deposits_count + r.summary.withdrawals_count,
      reconciled: r.summary.reconciliation.ok ? '✓' : `× Δ=${r.summary.reconciliation.delta}`,
      'llm warnings': llm,
    };
  });
  console.error(`\n[smoke-ocr-first] wall-clock: ${elapsed} ms\n`);
  console.table(rows);
}

main().catch((err) => {
  console.error('smoke-ocr-first failed:', err);
  process.exit(1);
});

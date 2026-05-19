import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { config as loadEnvFromDotenv } from 'dotenv';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(SCRIPT_DIR, '..', '..', '..');

if (existsSync(resolve(REPO_ROOT, '.env'))) {
  loadEnvFromDotenv({ path: resolve(REPO_ROOT, '.env') });
}

const { config, ExtractionModeSchema } = await import('../src/config.js');
const { extractDispatch } = await import('../src/pipeline/extract.js');
const { createOpenAIClient } = await import('../src/pipeline/openai-client.js');

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.length === 0) {
    console.error(
      'usage: pnpm -F @app/api extract:cli <path/to.pdf> [--ocr <path.txt|rtf>] [--out result.json] [--mode ocr-first|ocr-only|llm-only]',
    );
    process.exit(2);
  }
  const pdfPath = resolve(process.cwd(), args[0] as string);
  const outIdx = args.indexOf('--out');
  const ocrIdx = args.indexOf('--ocr');
  const modeIdx = args.indexOf('--mode');
  const outPath =
    outIdx >= 0 && args[outIdx + 1]
      ? resolve(process.cwd(), args[outIdx + 1] as string)
      : resolve(REPO_ROOT, 'out', `${basename(pdfPath, '.pdf')}.extracted.json`);
  const ocrPath =
    ocrIdx >= 0 && args[ocrIdx + 1] ? resolve(process.cwd(), args[ocrIdx + 1] as string) : null;
  const modeRaw = modeIdx >= 0 && args[modeIdx + 1] ? (args[modeIdx + 1] as string) : null;
  const modeParsed = modeRaw ? ExtractionModeSchema.safeParse(modeRaw) : null;
  if (modeRaw && (!modeParsed || !modeParsed.success)) {
    console.error(`Invalid --mode "${modeRaw}". Allowed: ocr-first | ocr-only | llm-only.`);
    process.exit(64);
  }
  const mode = modeParsed?.success ? modeParsed.data : config.EXTRACTION_MODE;

  if (!existsSync(pdfPath)) {
    console.error(`PDF not found: ${pdfPath}`);
    process.exit(2);
  }
  if (ocrPath && !existsSync(ocrPath)) {
    console.error(`OCR file not found: ${ocrPath}`);
    process.exit(2);
  }
  mkdirSync(dirname(outPath), { recursive: true });

  const pdfBytes = new Uint8Array(readFileSync(pdfPath));
  const ocrText = ocrPath ? readFileSync(ocrPath, 'utf8') : undefined;
  console.error(`[extract-cli] PDF: ${pdfPath} (${pdfBytes.length.toLocaleString()} bytes)`);
  if (ocrPath)
    console.error(
      `[extract-cli] OCR sidecar: ${ocrPath} (${ocrText?.length.toLocaleString()} chars)`,
    );
  console.error(`[extract-cli] model: ${config.OPENAI_MODEL}`);
  console.error(`[extract-cli] mode: ${mode}${ocrPath ? '' : ' (no OCR sidecar)'}`);
  console.error(
    `[extract-cli] chunk budget: ${config.OPENAI_CHUNK_BUDGET_BYTES.toLocaleString()} bytes, ` +
      `${config.OPENAI_CHUNK_PAGE_BUDGET} pages`,
  );

  const t0 = Date.now();
  const client = createOpenAIClient(config);
  const results = await extractDispatch({
    pdfBytes,
    client,
    promptVersion: 'v2.1.0',
    chunkBudgetBytes: config.OPENAI_CHUNK_BUDGET_BYTES,
    chunkPageBudget: config.OPENAI_CHUNK_PAGE_BUDGET,
    ocrText,
    mode,
    requestId: 'cli',
    onProgress: async (e) => {
      const t = ((Date.now() - t0) / 1000).toFixed(1);
      console.error(`[${t}s] ${e.stage}/${e.status}${e.detail ? ` — ${e.detail}` : ''}`);
    },
  });
  const totalMs = Date.now() - t0;
  for (const r of results) r.extraction.duration_ms = Math.round(totalMs / results.length);

  writeFileSync(outPath, `${JSON.stringify(results, null, 2)}\n`, 'utf8');
  console.error(`[extract-cli] wrote ${outPath}`);

  const rows = results.map((r) => {
    const declared = r.summary.deposits_count + r.summary.withdrawals_count;
    const emitted = r.transactions.length;
    return {
      period: `${r.account.period.start}…${r.account.period.end}`,
      last4: r.account.account_last4 ?? '????',
      bank: r.account.bank ?? '?',
      deposits$: r.summary.deposits_total.toFixed(2),
      'dep#': r.summary.deposits_count,
      withdrawals$: r.summary.withdrawals_total.toFixed(2),
      'wd#': r.summary.withdrawals_count,
      'tx (emitted/declared)': `${emitted}/${declared}${emitted === declared ? ' ✓' : ' ✗'}`,
      reconciled: r.summary.reconciliation.ok ? '✓' : `× Δ=${r.summary.reconciliation.delta}`,
    };
  });
  console.error('\nSummary:');
  console.table(rows);
}

main().catch((err) => {
  console.error('extract-cli failed:', err);
  process.exit(1);
});

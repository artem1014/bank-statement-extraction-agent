import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { config as dotenv } from 'dotenv';
import { PDFDocument } from 'pdf-lib';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..', '..', '..');
dotenv({ path: resolve(REPO_ROOT, '.env') });

const { createOpenAIClient } = await import('../src/pipeline/openai-client.js');
const { splitPdf } = await import('../src/pipeline/pdf-splitter.js');
const { config } = await import('../src/config.js');

const buf = readFileSync(resolve(REPO_ROOT, 'Binder2_Redacted.pdf'));
const src = await PDFDocument.load(buf);

const sub = await PDFDocument.create();
const pages = await sub.copyPages(
  src,
  Array.from({ length: 8 }, (_, i) => i),
);
for (const p of pages) sub.addPage(p);
const periodPdf = await sub.save({ useObjectStreams: true });
console.error(`Apr 2025 period PDF: ${(periodPdf.length / 1024 / 1024).toFixed(1)} MB, 8 pages`);

const slices = await splitPdf(periodPdf, {
  maxBytesPerChunk: config.OPENAI_CHUNK_BUDGET_BYTES,
  maxPagesPerChunk: 2,
});
console.error(
  `split into ${slices.length} 2-page windows:`,
  slices.map((s) => `${s.startPage}-${s.endPage}`).join(', '),
);

const client = createOpenAIClient(config);
const t0 = Date.now();
const hint = {
  bank: 'Ixonia Bank',
  account_last4: '4664',
  start_date: '2025-04-01',
  end_date: '2025-04-30',
};
const allTx: Array<{
  date: string;
  description: string;
  deposit: number | null;
  withdrawal: number | null;
  window: string;
}> = [];
for (const s of slices) {
  const tw0 = Date.now();
  const part = await client.extractTransactionRows(
    s.bytes,
    `apr-tx-${s.startPage}-${s.endPage}`,
    hint,
    {
      startInPeriod: s.startPage,
      endInPeriod: s.endPage,
    },
  );
  console.error(
    `  window ${s.startPage}-${s.endPage}: ${part.transactions.length} tx in ${((Date.now() - tw0) / 1000).toFixed(1)}s${part.warnings.length ? `, warnings=${JSON.stringify(part.warnings)}` : ''}`,
  );
  for (const t of part.transactions) allTx.push({ ...t, window: `${s.startPage}-${s.endPage}` });
}
console.error(`\nTotal: ${allTx.length} tx in ${((Date.now() - t0) / 1000).toFixed(1)}s`);

const seenKeys = new Set<string>();
const dedup = allTx.filter((t) => {
  const k = `${t.date}|${t.description.trim().toLowerCase().replace(/\s+/g, ' ')}|${t.deposit ?? 'n'}|${t.withdrawal ?? 'n'}`;
  if (seenKeys.has(k)) return false;
  seenKeys.add(k);
  return true;
});
console.error(`After dedup: ${dedup.length} unique tx`);
const dep = dedup.filter((t) => t.deposit !== null).length;
const wd = dedup.filter((t) => t.withdrawal !== null).length;
console.error(`deposits: ${dep} (expected 81), withdrawals: ${wd} (expected 111)`);

writeFileSync(resolve(REPO_ROOT, 'out', 'smoke-chunked-apr.json'), JSON.stringify(dedup, null, 2));

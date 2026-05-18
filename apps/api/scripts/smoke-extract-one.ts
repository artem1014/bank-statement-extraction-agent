import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { config as dotenv } from 'dotenv';
import { PDFDocument } from 'pdf-lib';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..', '..', '..');
dotenv({ path: resolve(REPO_ROOT, '.env') });

const { createOpenAIClient } = await import('../src/pipeline/openai-client.js');
const { config } = await import('../src/config.js');

const buf = readFileSync(resolve(REPO_ROOT, 'Binder2_Redacted.pdf'));
const src = await PDFDocument.load(buf);

const sub = await PDFDocument.create();
const pages = await sub.copyPages(
  src,
  Array.from({ length: 8 }, (_, i) => i),
);
for (const p of pages) sub.addPage(p);
const chunk = await sub.save({ useObjectStreams: true });
console.error(`pages 1-8: ${(chunk.length / 1024 / 1024).toFixed(1)} MB`);

const client = createOpenAIClient(config);
const t0 = Date.now();
const raw = await client.extractPeriod(chunk, 'apr-2025-smoke', {
  bank: 'Ixonia Bank',
  account_last4: '4664',
  start_date: '2025-04-01',
  end_date: '2025-04-30',
});
const ms = Date.now() - t0;

console.error(`\nLLM returned in ${(ms / 1000).toFixed(1)}s`);
console.error('account:', raw.account);
console.error('summary:', raw.summary);
console.error('declared total:', raw.summary.deposits_count + raw.summary.withdrawals_count);
console.error('emitted transactions:', raw.transactions.length);
console.error('first 3 tx:', JSON.stringify(raw.transactions.slice(0, 3), null, 2));
console.error('last 2 tx:', JSON.stringify(raw.transactions.slice(-2), null, 2));
console.error('warnings:', raw.extraction.warnings);

writeFileSync(
  resolve(REPO_ROOT, 'out', 'smoke-extract-apr-2025.json'),
  JSON.stringify(raw, null, 2),
);

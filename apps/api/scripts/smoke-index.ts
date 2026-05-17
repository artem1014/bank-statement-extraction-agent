import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { config as dotenv } from 'dotenv';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..', '..', '..');
dotenv({ path: resolve(REPO_ROOT, '.env') });

const { splitPdf } = await import('../src/pipeline/pdf-splitter.js');
const { createOpenAIClient } = await import('../src/pipeline/openai-client.js');
const { config } = await import('../src/config.js');

const buf = new Uint8Array(readFileSync(resolve(REPO_ROOT, 'Binder2_Redacted.pdf')));
console.error('PDF bytes:', buf.length.toLocaleString());

const chunks = await splitPdf(buf, {
  maxBytesPerChunk: config.OPENAI_CHUNK_BUDGET_BYTES,
  maxPagesPerChunk: config.OPENAI_CHUNK_PAGE_BUDGET,
});
console.error(
  `split into ${chunks.length} chunks:`,
  chunks
    .map((c) => `${c.startPage}-${c.endPage} (${(c.bytes.length / 1024 / 1024).toFixed(1)} MB)`)
    .join(', '),
);

const client = createOpenAIClient(config);
const firstChunk = chunks[0];
if (!firstChunk) throw new Error('no chunks');
console.error(
  `\nIndexing chunk 1 (pages ${firstChunk.startPage}-${firstChunk.endPage}) with model ${config.OPENAI_MODEL}...`,
);

const t0 = Date.now();
const markers = await client.indexPeriods(firstChunk.bytes, 'smoke-chunk-1');
console.error(`done in ${((Date.now() - t0) / 1000).toFixed(1)}s\n`);
console.error('markers:', JSON.stringify(markers, null, 2));

writeFileSync(
  resolve(REPO_ROOT, 'out', 'smoke-index-chunk1.json'),
  JSON.stringify(markers, null, 2),
);

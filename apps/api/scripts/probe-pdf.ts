import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PDFDocument } from 'pdf-lib';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..', '..', '..');
const buf = readFileSync(resolve(REPO_ROOT, 'Binder2_Redacted.pdf'));
const src = await PDFDocument.load(buf);
console.error('total pages:', src.getPageCount(), 'bytes:', buf.length.toLocaleString());

async function chunk(n: number): Promise<number> {
  const sub = await PDFDocument.create();
  const pages = await sub.copyPages(
    src,
    Array.from({ length: n }, (_, i) => i),
  );
  for (const p of pages) sub.addPage(p);
  const b = await sub.save({ useObjectStreams: true });
  return b.length;
}

for (const n of [1, 5, 10, 15, 20, 25, 30]) {
  console.error(`${n}-page chunk:`, (await chunk(n)).toLocaleString(), 'bytes');
}

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PDFDocument } from 'pdf-lib';
import { mapOcrPeriodsToPageRanges, parseOcrPeriods } from '../src/pipeline/ocr-indexer.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..', '..', '..');

const ocr = readFileSync(resolve(REPO_ROOT, 'Bank Statement.rtf'), 'utf8');
const pdfBytes = readFileSync(resolve(REPO_ROOT, 'Binder2_Redacted.pdf'));
const pdf = await PDFDocument.load(pdfBytes);
const totalPages = pdf.getPageCount();
console.error(`PDF total pages: ${totalPages}`);

const periods = parseOcrPeriods(ocr);
console.error(`\nOCR parsed ${periods.length} periods:`);
for (const p of periods) {
  console.error(
    `  ${p.start_date}…${p.end_date}  acct=${p.account_last4 ?? '????'}  bank=${p.bank ?? '?'}  ocrLines=${p.ocrLineStart}-${p.ocrLineEnd}`,
  );
}

const mapped = mapOcrPeriodsToPageRanges(ocr, periods, totalPages);
console.error('\nMapped to absolute PDF pages:');
console.table(
  mapped.map((p) => ({
    period: `${p.start_date}…${p.end_date}`,
    last4: p.account_last4 ?? '????',
    pages: `${p.absoluteStartPage}-${p.absoluteEndPage}`,
    count: p.absoluteEndPage - p.absoluteStartPage + 1,
  })),
);
const sum = mapped.reduce((a, b) => a + (b.absoluteEndPage - b.absoluteStartPage + 1), 0);
console.error(`Sum of pages: ${sum} (expected ${totalPages})`);

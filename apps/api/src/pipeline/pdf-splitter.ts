import { PDFDocument } from 'pdf-lib';

export interface PdfChunk {
  index: number;
  startPage: number;
  endPage: number;
  bytes: Uint8Array;
}

export interface SplitOptions {
  maxBytesPerChunk: number;
  maxPagesPerChunk: number;
}

export async function splitPdf(source: Uint8Array, opts: SplitOptions): Promise<PdfChunk[]> {
  const src = await PDFDocument.load(source, { ignoreEncryption: false });
  const totalPages = src.getPageCount();
  if (totalPages === 0) return [];

  const chunks: PdfChunk[] = [];
  let cursor = 0;
  let chunkIndex = 0;

  while (cursor < totalPages) {
    const tentativeEnd = Math.min(cursor + opts.maxPagesPerChunk, totalPages);
    let chosenEnd = tentativeEnd;
    let chosenBytes: Uint8Array | null = null;

    let lo = cursor + 1;
    let hi = tentativeEnd;
    while (lo <= hi) {
      const mid = Math.floor((lo + hi) / 2);
      const candidate = await assemble(src, cursor, mid);
      if (candidate.byteLength <= opts.maxBytesPerChunk) {
        chosenEnd = mid;
        chosenBytes = candidate;
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }

    if (!chosenBytes) {
      const single = await assemble(src, cursor, cursor + 1);
      if (single.byteLength > opts.maxBytesPerChunk) {
        throw new Error(
          `pdf-splitter: page ${cursor + 1} alone (${single.byteLength} bytes) exceeds the per-chunk byte budget (${opts.maxBytesPerChunk}). Re-encode the source PDF or raise OPENAI_CHUNK_BUDGET_BYTES.`,
        );
      }
      chosenEnd = cursor + 1;
      chosenBytes = single;
    }

    chunks.push({
      index: chunkIndex,
      startPage: cursor + 1,
      endPage: chosenEnd,
      bytes: chosenBytes,
    });
    chunkIndex += 1;
    cursor = chosenEnd;
  }

  return chunks;
}

async function assemble(
  src: PDFDocument,
  startInclusive0: number,
  endExclusive: number,
): Promise<Uint8Array> {
  const sub = await PDFDocument.create();
  const pageRange = Array.from(
    { length: endExclusive - startInclusive0 },
    (_, i) => startInclusive0 + i,
  );
  const copied = await sub.copyPages(src, pageRange);
  for (const p of copied) sub.addPage(p);
  return sub.save({ useObjectStreams: true });
}

export async function countPages(source: Uint8Array): Promise<number> {
  const doc = await PDFDocument.load(source);
  return doc.getPageCount();
}

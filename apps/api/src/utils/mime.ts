const PDF_MAGIC = Buffer.from([0x25, 0x50, 0x44, 0x46, 0x2d]);

export function isPdfBuffer(buf: Uint8Array | Buffer): boolean {
  if (buf.length < PDF_MAGIC.length) return false;
  for (let i = 0; i < PDF_MAGIC.length; i += 1) {
    if (buf[i] !== PDF_MAGIC[i]) return false;
  }
  return true;
}

const PRINTABLE_OR_WHITESPACE = /[\t\n\r\u0020-\u007E]/;

export function isUtf8Text(buf: Uint8Array | Buffer, sampleBytes = 4096): boolean {
  if (buf.length === 0) return true;
  const sample = buf.subarray(0, Math.min(sampleBytes, buf.length));
  try {
    const decoded = new TextDecoder('utf-8', { fatal: true }).decode(sample);
    if (decoded.length === 0) return false;
    let printable = 0;
    for (const ch of decoded) {
      if (PRINTABLE_OR_WHITESPACE.test(ch) || ch.charCodeAt(0) >= 128) {
        printable += 1;
      }
    }
    return printable / decoded.length >= 0.85;
  } catch {
    return false;
  }
}

export class MimeMismatchError extends Error {
  constructor(
    public readonly field: string,
    public readonly reason: string,
  ) {
    super(`Field '${field}' failed MIME check: ${reason}`);
    this.name = 'MimeMismatchError';
  }
}

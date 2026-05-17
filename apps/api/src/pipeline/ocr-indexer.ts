export interface OcrPeriod {
  start_date: string;
  end_date: string;
  account_last4: string | null;
  bank: string | null;
  ocrLineStart: number;
  ocrLineEnd: number;
}

interface BalanceMarker {
  kind: 'begin' | 'end';
  date: string;
  line: number;
}

const RTF_CONTROL_WORD = /\\[a-zA-Z]+\d*\s?/g;
const RTF_DOC_TEXT_START = /=== Document Text ===/;
const RTF_TABLES_START = /=== (Document Tables|Tables in detected order|Tables) ===/;

const MMDDYYYY = /(\d{2})\/(\d{2})\/(\d{4})/;
const BALANCE_LINE = /(Beginning|Ending)\s+Balance\s+as\s+of\s+(\d{2}\/\d{2}\/\d{4})/i;
const _ACCOUNT_LAST4 =
  /(?:Account\s*Number)?[^\d]*X{2,}(\d{4})|^\s*(\d{4})\s+\d{2}\/\d{2}\/\d{4}\s+\d{2}\/\d{2}\/\d{4}/;
const PAGE_OF = /Page\s+(\d+)\s+of\s+(\d+)/i;

function stripRtf(raw: string): string {
  return raw
    .replace(/\\'[0-9a-fA-F]{2}/g, '?')
    .replace(/\\\n/g, '\n')
    .replace(RTF_CONTROL_WORD, '')
    .replace(/[{}]/g, '');
}

function toIso(usDate: string): string {
  const m = usDate.match(MMDDYYYY);
  if (!m) return usDate;
  return `${m[3]}-${m[1]}-${m[2]}`;
}

function isDocumentTextSection(plain: string): { start: number; end: number } {
  const startIdx = plain.search(RTF_DOC_TEXT_START);
  const start = startIdx < 0 ? 0 : startIdx;
  const tablesIdx = plain.slice(start).search(RTF_TABLES_START);
  const end = tablesIdx < 0 ? plain.length : start + tablesIdx;
  return { start, end };
}

export function parseOcrPeriods(rawOcrText: string): OcrPeriod[] {
  const plain = stripRtf(rawOcrText);
  const { start, end } = isDocumentTextSection(plain);
  const docText = plain.slice(start, end);
  const lines = docText.split('\n');

  const markers: BalanceMarker[] = [];
  for (let i = 0; i < lines.length; i++) {
    const m = (lines[i] ?? '').match(BALANCE_LINE);
    if (!m) continue;
    markers.push({
      kind: (m[1] as string).toLowerCase() === 'beginning' ? 'begin' : 'end',
      date: toIso(m[2] as string),
      line: i + 1,
    });
  }

  const periods: OcrPeriod[] = [];
  for (let i = 0; i < markers.length; i++) {
    const cur = markers[i] as BalanceMarker;
    const next = markers[i + 1];
    if (cur.kind !== 'begin' || !next || next.kind !== 'end') continue;
    periods.push({
      start_date: cur.date,
      end_date: next.date,
      account_last4: findNearbyAccountLast4(lines, cur.line),
      bank: findNearbyBank(lines, cur.line),
      ocrLineStart: cur.line,
      ocrLineEnd: next.line,
    });
    i += 1;
  }

  return periods;
}

function findNearbyAccountLast4(lines: string[], around: number): string | null {
  const lo = Math.max(0, around - 100);
  const hi = Math.min(lines.length, around + 20);
  for (let i = around - 1; i >= lo; i--) {
    const l = lines[i] ?? '';
    const m =
      l.match(/X{2,}(\d{4})/) ?? l.match(/^\s*(\d{4})\s+\d{2}\/\d{2}\/\d{4}\s+\d{2}\/\d{2}\/\d{4}/);
    if (m) return (m[1] ?? null) as string | null;
  }
  for (let i = around; i < hi; i++) {
    const l = lines[i] ?? '';
    const m = l.match(/X{2,}(\d{4})/);
    if (m) return m[1] as string;
  }
  return null;
}

function findNearbyBank(lines: string[], around: number): string | null {
  const lo = Math.max(0, around - 60);
  const hi = Math.min(lines.length, around + 10);
  for (let i = lo; i < hi; i++) {
    const l = (lines[i] ?? '').trim();
    if (/^Ixonia Bank\b/i.test(l)) return 'Ixonia Bank';
  }
  return null;
}

export function mapOcrPeriodsToPageRanges(
  rawOcrText: string,
  ocrPeriods: OcrPeriod[],
  totalPdfPages: number,
): Array<OcrPeriod & { absoluteStartPage: number; absoluteEndPage: number }> {
  if (ocrPeriods.length === 0) return [];
  const plain = stripRtf(rawOcrText);
  const { start, end } = isDocumentTextSection(plain);
  const docText = plain.slice(start, end);
  const lines = docText.split('\n');

  const pageOfMarkers = collectPageOfMarkers(lines);

  const periodPageCounts = ocrPeriods.map((p) => coverPageTotal(pageOfMarkers, p.ocrLineStart));

  const knownSum = periodPageCounts.reduce<number>((acc, n) => acc + (n ?? 0), 0);
  const unknownCount = periodPageCounts.filter((n) => n == null).length;
  const remaining = Math.max(0, totalPdfPages - knownSum);
  const fillEach = unknownCount > 0 ? Math.max(1, Math.floor(remaining / unknownCount)) : 0;

  const finalCounts = periodPageCounts.map((n) => n ?? fillEach);
  const sumFinal = finalCounts.reduce((a, b) => a + b, 0);
  if (sumFinal !== totalPdfPages && finalCounts.length > 0) {
    const drift = totalPdfPages - sumFinal;
    finalCounts[finalCounts.length - 1] = (finalCounts.at(-1) as number) + drift;
  }

  const out: Array<OcrPeriod & { absoluteStartPage: number; absoluteEndPage: number }> = [];
  let cursor = 1;
  for (let i = 0; i < ocrPeriods.length; i++) {
    const p = ocrPeriods[i] as OcrPeriod;
    const cnt = Math.max(1, finalCounts[i] as number);
    out.push({
      ...p,
      absoluteStartPage: cursor,
      absoluteEndPage: cursor + cnt - 1,
    });
    cursor += cnt;
  }
  return out;
}

interface PageOfMarker {
  line: number;
  page: number;
  total: number;
}

function collectPageOfMarkers(lines: string[]): PageOfMarker[] {
  const out: PageOfMarker[] = [];
  for (let i = 0; i < lines.length; i++) {
    const m = (lines[i] ?? '').match(PAGE_OF);
    if (!m) continue;
    const page = Number.parseInt(m[1] as string, 10);
    const total = Number.parseInt(m[2] as string, 10);
    if (Number.isFinite(page) && Number.isFinite(total)) {
      out.push({ line: i + 1, page, total });
    }
  }
  return out;
}

function coverPageTotal(markers: PageOfMarker[], periodBeginLine: number): number | null {
  let best: PageOfMarker | null = null;
  for (const m of markers) {
    if (m.line > periodBeginLine) break;
    if (m.page === 1) best = m;
  }
  return best?.total ?? null;
}

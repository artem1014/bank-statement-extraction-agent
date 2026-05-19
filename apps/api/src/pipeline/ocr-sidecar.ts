import { mapOcrPeriodsToPageRanges, parseOcrPeriods } from './ocr-indexer.js';

export interface OcrSidecar {
  rawText: string;
  plainText: string;
  lines: string[];
  documentTextRange: { start: number; end: number } | null;
  tablesRange: { start: number; end: number } | null;
  tableBlocks: TableBlock[];
  periods: ParsedPeriodSpan[];
}

export interface ParsedPeriodSpan {
  start_date: string;
  end_date: string;
  account_last4: string | null;
  bank: string | null;
  ocrLineStart: number;
  ocrLineEnd: number;
  absoluteStartPage: number;
  absoluteEndPage: number;
}

export interface TableBlock {
  range: { start: number; end: number };
  headerRow: HeaderRow | null;
  dataRows: string[][];
}

export interface HeaderRow {
  cells: string[];
  slots: Partial<Record<HeaderToken, number>>;
}

export type HeaderToken =
  | 'date'
  | 'description'
  | 'deposit'
  | 'withdrawal'
  | 'credit'
  | 'debit'
  | 'balance'
  | 'check';

const RTF_CONTROL_WORD = /\\[a-zA-Z]+\d*\s?/g;
const RTF_DOC_TEXT_START = /=== Document Text ===/;
const RTF_TABLES_START = /=== (Document Tables|Tables in detected order|Tables) ===/;
const TABLE_START = /^=== Table( \d+)? ===/;
const _TABLE_END = /^=== End Table( \d+)? ===|^=== Table( \d+)? ===/;

const HEADER_TOKENS: HeaderToken[] = [
  'date',
  'description',
  'deposit',
  'withdrawal',
  'credit',
  'debit',
  'balance',
  'check',
];

function stripRtf(raw: string): string {
  return raw
    .replace(/\\'[0-9a-fA-F]{2}/g, '?')
    .replace(/\\\n/g, '\n')
    .replace(RTF_CONTROL_WORD, '')
    .replace(/[{}]/g, '');
}

export function parseOcrSidecar(rawText: string, totalPdfPages = 0): OcrSidecar {
  const plain = stripRtf(rawText);
  const lines = plain.split('\n');

  const documentTextRange =
    findFirstSectionRange(lines, RTF_DOC_TEXT_START, [RTF_TABLES_START]) ?? null;
  const tablesRange =
    findFirstSectionRange(lines, RTF_TABLES_START, [
      /=== (Document Text|Key-Value Pairs|Selection Marks) ===/,
    ]) ?? null;

  const tableBlocks = tablesRange ? collectTableBlocks(lines, tablesRange) : [];

  const ocrPeriods = parseOcrPeriods(rawText);
  const mapped =
    ocrPeriods.length > 0 && totalPdfPages > 0
      ? mapOcrPeriodsToPageRanges(rawText, ocrPeriods, totalPdfPages)
      : ocrPeriods.map((p) => ({ ...p, absoluteStartPage: 0, absoluteEndPage: 0 }));

  const docTextOffset = documentTextRange ? documentTextRange.start : 0;

  const periods: ParsedPeriodSpan[] = mapped.map((p) => ({
    start_date: p.start_date,
    end_date: p.end_date,
    account_last4: p.account_last4,
    bank: p.bank,
    ocrLineStart: p.ocrLineStart + docTextOffset,
    ocrLineEnd: p.ocrLineEnd + docTextOffset,
    absoluteStartPage: p.absoluteStartPage,
    absoluteEndPage: p.absoluteEndPage,
  }));

  return {
    rawText,
    plainText: plain,
    lines,
    documentTextRange,
    tablesRange,
    tableBlocks,
    periods,
  };
}

function findFirstSectionRange(
  lines: string[],
  startPattern: RegExp,
  stopPatterns: RegExp[],
): { start: number; end: number } | null {
  let start = -1;
  for (let i = 0; i < lines.length; i++) {
    if (startPattern.test(lines[i] ?? '')) {
      start = i;
      break;
    }
  }
  if (start < 0) return null;
  for (let i = start + 1; i < lines.length; i++) {
    const ln = lines[i] ?? '';
    if (stopPatterns.some((p) => p.test(ln))) {
      return { start: start + 1, end: i };
    }
  }
  return { start: start + 1, end: lines.length };
}

function collectTableBlocks(lines: string[], range: { start: number; end: number }): TableBlock[] {
  const blocks: TableBlock[] = [];
  let i = range.start;
  while (i < range.end) {
    const ln = lines[i] ?? '';
    if (TABLE_START.test(ln)) {
      const startLine = i + 1;
      let j = i + 1;
      while (j < range.end) {
        const inner = lines[j] ?? '';
        if (j > i && (TABLE_START.test(inner) || /^=== End Table/.test(inner))) break;
        j++;
      }
      const endLine = j;
      const body = lines.slice(startLine, endLine);
      const { header, dataRows } = parseTableBody(body);
      blocks.push({
        range: { start: startLine + 1, end: endLine + 1 },
        headerRow: header,
        dataRows,
      });
      i = endLine;
      if (i < range.end && /^=== End Table/.test(lines[i] ?? '')) i++;
      continue;
    }
    i++;
  }
  return blocks;
}

function splitRow(line: string): string[] {
  const trimmed = line.replace(/\t/g, '    ').trimEnd();
  if (trimmed.includes('|')) {
    return trimmed.split(/\s*\|\s*/).map((s) => s.trim());
  }
  return trimmed.split(/\s{2,}/).map((s) => s.trim());
}

function parseTableBody(body: string[]): { header: HeaderRow | null; dataRows: string[][] } {
  let headerIdx = -1;
  let headerCells: string[] = [];
  let slots: Partial<Record<HeaderToken, number>> = {};

  for (let i = 0; i < body.length; i++) {
    const ln = body[i] ?? '';
    if (ln.trim().length === 0) continue;
    const cells = splitRow(ln);
    const lowered = cells.map((c) => c.toLowerCase().replace(/[,:]/g, '').trim());
    const localSlots: Partial<Record<HeaderToken, number>> = {};
    for (const tok of HEADER_TOKENS) {
      const idx = lowered.findIndex((c) => c.includes(tok));
      if (idx >= 0) localSlots[tok] = idx;
    }
    const matchCount = Object.keys(localSlots).length;
    if (matchCount >= 2) {
      headerIdx = i;
      headerCells = cells;
      slots = localSlots;
      break;
    }
  }

  if (headerIdx < 0) return { header: null, dataRows: [] };

  const dataRows: string[][] = [];
  for (let i = headerIdx + 1; i < body.length; i++) {
    const ln = body[i] ?? '';
    if (ln.trim().length === 0) continue;
    if (/^[-=\s|]+$/.test(ln)) continue;
    dataRows.push(splitRow(ln));
  }

  return { header: { cells: headerCells, slots }, dataRows };
}

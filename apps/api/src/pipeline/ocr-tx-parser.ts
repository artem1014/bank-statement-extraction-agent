import type { Transaction } from '../domain/types.js';
import {
  normalizeDateToken,
  normalizeMoneyToken,
  parseDateMDY,
  parseMoney,
} from '../utils/text-normalize.js';
import type { HeaderRow, OcrSidecar, ParsedPeriodSpan, TableBlock } from './ocr-sidecar.js';
import { parseSummaryBlock } from './ocr-summary-parser.js';

export interface ParseTxResult {
  transactions: Transaction[];
  warnings: string[];
}

const BOUNDARY_DESC = /^\s*(BEGINNING|ENDING|OPENING|CLOSING)\s+BALANCE\s*$/i;
const SUBTOTAL_DESC = /^\s*(TOTAL|SUBTOTAL|DAILY\s+ENDING\s+BALANCE)/i;
const MONTH_MMM = /^(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+(\d{1,2})$/i;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const MDY = /^\d{2}\/\d{2}\/\d{4}$/;

const MONTHS: Record<string, number> = {
  jan: 1,
  feb: 2,
  mar: 3,
  apr: 4,
  may: 5,
  jun: 6,
  jul: 7,
  aug: 8,
  sep: 9,
  oct: 10,
  nov: 11,
  dec: 12,
};

export function parseTransactionsForPeriod(
  sidecar: OcrSidecar,
  period: ParsedPeriodSpan,
): ParseTxResult {
  const assignment = assignBlocksToPeriods(sidecar);
  return collectTransactionsForPeriod(sidecar, period, assignment);
}

export function parseTransactionsAllPeriods(sidecar: OcrSidecar): Map<string, ParseTxResult> {
  const assignment = assignBlocksToPeriods(sidecar);
  const out = new Map<string, ParseTxResult>();
  for (const period of sidecar.periods) {
    out.set(periodKey(period), collectTransactionsForPeriod(sidecar, period, assignment));
  }
  return out;
}

function collectTransactionsForPeriod(
  sidecar: OcrSidecar,
  period: ParsedPeriodSpan,
  assignment: Map<number, string>,
): ParseTxResult {
  const transactions: Transaction[] = [];
  const warnings: string[] = [];
  const wantKey = periodKey(period);
  const periodStart = period.start_date;
  const periodEnd = period.end_date;

  for (let i = 0; i < sidecar.tableBlocks.length; i += 1) {
    const block = sidecar.tableBlocks[i] as TableBlock;
    if (!block.headerRow) continue;
    if (!hasDirectionColumn(block.headerRow)) continue;
    const assigned = assignment.get(i);
    if (assigned !== undefined && assigned !== wantKey) continue;

    const blockHits: Transaction[] = [];
    for (const row of block.dataRows) {
      const parsed = parseRow(row, block.headerRow, period, warnings);
      if (!parsed) continue;
      if (parsed.kind === 'continuation' && blockHits.length > 0) {
        const prev = blockHits[blockHits.length - 1] as Transaction;
        prev.description = `${prev.description} ${parsed.descriptionAddition}`.trim();
        continue;
      }
      if (parsed.kind === 'tx') {
        blockHits.push(parsed.tx);
      }
    }

    const inPeriod = blockHits.filter((t) => t.date >= periodStart && t.date <= periodEnd);
    if (inPeriod.length === 0) continue;
    if (assigned === undefined) {
      const periodsForDates = sidecar.periods.filter(
        (p) => p.start_date === periodStart && p.end_date === periodEnd,
      );
      if (periodsForDates.length > 1) continue;
    }

    transactions.push(...inPeriod);
  }

  return { transactions, warnings };
}

function periodKey(p: ParsedPeriodSpan): string {
  return `${p.start_date}|${p.end_date}|${p.account_last4 ?? '????'}`;
}

function assignBlocksToPeriods(sidecar: OcrSidecar): Map<number, string> {
  const out = new Map<number, string>();
  const summaries = new Map<string, number>();
  for (const period of sidecar.periods) {
    if (period.ocrLineStart >= sidecar.lines.length) continue;
    try {
      const s = parseSummaryBlock(sidecar, period);
      if (s.beginning_balance !== null) {
        summaries.set(periodKey(period), s.beginning_balance);
      }
    } catch {}
  }

  const blocks = sidecar.tableBlocks
    .map((b, i) => ({ b, i }))
    .filter(({ b }) => b.headerRow && hasDirectionColumn(b.headerRow))
    .sort((a, z) => a.b.range.start - z.b.range.start);

  let lastAssignedKey: string | null = null;
  const usedKeys = new Set<string>();

  for (const { b, i } of blocks) {
    const firstDate = firstRowDate(b);
    const candidates = sidecar.periods.filter((p) => {
      if (!firstDate) return false;
      if (firstDate.date) {
        return firstDate.date >= p.start_date && firstDate.date <= p.end_date;
      }
      if (firstDate.monthOnly) {
        const pm = Number.parseInt(p.start_date.slice(5, 7), 10);
        return pm === firstDate.monthOnly.month;
      }
      return false;
    });
    if (candidates.length === 0) {
      if (lastAssignedKey) out.set(i, lastAssignedKey);
      continue;
    }
    if (candidates.length === 1) {
      const k = periodKey(candidates[0] as ParsedPeriodSpan);
      out.set(i, k);
      lastAssignedKey = k;
      usedKeys.add(k);
      continue;
    }
    const anchor = findBeginningBalanceAnchor(b);
    if (anchor !== null) {
      let best: { k: string; diff: number } | null = null;
      for (const cand of candidates) {
        const k = periodKey(cand);
        const beg = summaries.get(k);
        if (beg === undefined) continue;
        const diff = Math.abs(beg - anchor);
        if (!best || diff < best.diff) best = { k, diff };
      }
      if (best && best.diff <= Math.max(0.05, Math.abs(anchor) * 1e-3)) {
        out.set(i, best.k);
        lastAssignedKey = best.k;
        usedKeys.add(best.k);
        continue;
      }
    }
    if (lastAssignedKey && candidates.some((c) => periodKey(c) === lastAssignedKey)) {
      out.set(i, lastAssignedKey);
      continue;
    }
    const fallback = candidates.find((c) => !usedKeys.has(periodKey(c))) ?? candidates[0];
    const fk = periodKey(fallback as ParsedPeriodSpan);
    out.set(i, fk);
    lastAssignedKey = fk;
    usedKeys.add(fk);
  }

  return out;
}

function firstRowDate(
  block: TableBlock,
): { date: string; monthOnly: { month: number; day: number } | null } | null {
  if (!block.headerRow) return null;
  const dateSlot = block.headerRow.slots.date;
  if (dateSlot === undefined) return null;
  for (const row of block.dataRows) {
    const raw = (row[dateSlot] ?? '').trim();
    if (!raw) continue;
    if (ISO_DATE.test(raw)) return { date: raw, monthOnly: null };
    if (MDY.test(raw)) {
      try {
        return { date: parseDateMDY(raw), monthOnly: null };
      } catch {
        continue;
      }
    }
    const norm = normalizeDateToken(raw);
    if (MDY.test(norm.value)) {
      try {
        return { date: parseDateMDY(norm.value), monthOnly: null };
      } catch {
        continue;
      }
    }
    const m = raw.match(MONTH_MMM);
    if (m) {
      const monthNum = MONTHS[(m[1] as string).toLowerCase()];
      const day = Number.parseInt(m[2] as string, 10);
      if (monthNum && Number.isFinite(day)) {
        return { date: '', monthOnly: { month: monthNum, day } };
      }
    }
  }
  return null;
}

function findBeginningBalanceAnchor(block: TableBlock): number | null {
  if (!block.headerRow) return null;
  const descSlot = block.headerRow.slots.description;
  if (descSlot === undefined) return null;
  for (const row of block.dataRows) {
    const desc = (row[descSlot] ?? '').trim();
    if (!BOUNDARY_DESC.test(desc)) continue;
    if (!/BEGINNING|OPENING/i.test(desc)) continue;
    for (const cell of row) {
      const norm = normalizeMoneyToken((cell ?? '').trim());
      try {
        const v = parseMoney(norm.value);
        if (Number.isFinite(v)) return v;
      } catch {}
    }
  }
  return null;
}

function hasDirectionColumn(h: HeaderRow): boolean {
  return (
    h.slots.deposit !== undefined ||
    h.slots.credit !== undefined ||
    h.slots.withdrawal !== undefined ||
    h.slots.debit !== undefined
  );
}

type ParsedRow =
  | { kind: 'tx'; tx: Transaction }
  | { kind: 'continuation'; descriptionAddition: string }
  | null;

function parseRow(
  row: string[],
  header: HeaderRow,
  period: ParsedPeriodSpan,
  warnings: string[],
): ParsedRow {
  const cell = (slot: number | undefined): string =>
    slot === undefined ? '' : (row[slot] ?? '').trim();
  const dateCell = cell(header.slots.date);
  const descCell = cell(header.slots.description);
  const depositCell = cell(header.slots.deposit ?? header.slots.credit);
  const withdrawalCell = cell(header.slots.withdrawal ?? header.slots.debit);

  const allEmpty = !dateCell && !descCell && !depositCell && !withdrawalCell;
  if (allEmpty) return null;

  if (!dateCell && descCell) {
    return { kind: 'continuation', descriptionAddition: descCell };
  }

  if (BOUNDARY_DESC.test(descCell) || SUBTOTAL_DESC.test(descCell)) return null;

  const iso = parseDate(dateCell, period);
  if (!iso) return null;

  if (descCell.trim().length === 0) return null;

  const deposit = parseAmount(depositCell);
  const withdrawal = parseAmount(withdrawalCell);

  if (deposit === null && withdrawal === null && descCell.trim().length > 0) {
    warnings.push(`ambiguous-direction: ${iso} '${descCell.slice(0, 60)}'`);
  }

  const tx: Transaction = {
    date: iso,
    description: descCell.trim(),
    deposit,
    withdrawal,
    source_span: { page: null, char_start: null, char_end: null },
  };
  return { kind: 'tx', tx };
}

function parseDate(raw: string, period: ParsedPeriodSpan): string | null {
  const t = raw.trim();
  if (t.length === 0) return null;
  if (ISO_DATE.test(t)) return t;
  if (MDY.test(t)) {
    try {
      return parseDateMDY(t);
    } catch {
      return null;
    }
  }
  const norm = normalizeDateToken(t);
  if (MDY.test(norm.value)) {
    try {
      return parseDateMDY(norm.value);
    } catch {
      return null;
    }
  }
  const m = t.match(MONTH_MMM);
  if (m) {
    const monthNum = MONTHS[(m[1] as string).toLowerCase()];
    const day = Number.parseInt(m[2] as string, 10);
    if (!monthNum || !Number.isFinite(day)) return null;
    const year = pickYearForMonth(period, monthNum);
    const mm = String(monthNum).padStart(2, '0');
    const dd = String(day).padStart(2, '0');
    return `${year}-${mm}-${dd}`;
  }
  return null;
}

function pickYearForMonth(period: ParsedPeriodSpan, month: number): number {
  const startYear = Number.parseInt(period.start_date.slice(0, 4), 10);
  const endYear = Number.parseInt(period.end_date.slice(0, 4), 10);
  const startMonth = Number.parseInt(period.start_date.slice(5, 7), 10);
  if (startYear === endYear) return startYear;
  return month >= startMonth ? startYear : endYear;
}

function parseAmount(raw: string): number | null {
  const t = raw.trim();
  if (t.length === 0) return null;
  if (/^[-]+$/.test(t)) return null;
  const norm = normalizeMoneyToken(t);
  try {
    return parseMoney(norm.value);
  } catch {
    return null;
  }
}

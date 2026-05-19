import { normalizeMoneyToken, parseMoney } from '../utils/text-normalize.js';
import type { OcrSidecar, ParsedPeriodSpan } from './ocr-sidecar.js';

export interface ParsedSummary {
  beginning_balance: number | null;
  ending_balance: number | null;
  deposits_total: number | null;
  deposits_count: number | null;
  withdrawals_total: number | null;
  withdrawals_count: number | null;
  bank: string | null;
  account_last4: string | null;
  period: { start: string; end: string };
  source_lines: { start: number; end: number };
}

const BEGIN_BAL = /Beginning\s+Balance\s+as\s+of\s+\d{2}\/\d{2}\/\d{4}/i;
const END_BAL = /Ending\s+Balance\s+as\s+of\s+\d{2}\/\d{2}\/\d{4}/i;
const DEPOSITS_HEAD = /(?:\+\s*)?Deposits\s+(?:and|&)\s+Credits\s*\((\d+)\)/i;
const WITHDRAWALS_HEAD = /(?:-\s*)?Withdrawals\s+(?:and|&)\s+Debits\s*\((\d+)\)/i;
const MONEY_LINE = /-?\$?-?\d[\d,\sOol]*\.\d{2}-?/;

export function parseSummaryBlock(sidecar: OcrSidecar, period: ParsedPeriodSpan): ParsedSummary {
  const lines = sidecar.lines;
  if (period.ocrLineStart >= lines.length) {
    throw new Error(
      `parseSummaryBlock: period.ocrLineStart (${period.ocrLineStart}) >= lines.length (${lines.length})`,
    );
  }
  const lo = Math.max(0, period.ocrLineStart - 30);
  const hi = Math.min(lines.length, period.ocrLineEnd + 8);

  const beginning_balance = findMoneyAfter(lines, lo, hi, BEGIN_BAL);
  const ending_balance = findMoneyAfter(lines, lo, hi, END_BAL);

  const deposits = findCountAndMoney(lines, lo, hi, DEPOSITS_HEAD);
  const withdrawals = findCountAndMoney(lines, lo, hi, WITHDRAWALS_HEAD);

  return {
    beginning_balance,
    ending_balance,
    deposits_total: deposits.total,
    deposits_count: deposits.count,
    withdrawals_total: withdrawals.total,
    withdrawals_count: withdrawals.count,
    bank: period.bank,
    account_last4: period.account_last4,
    period: { start: period.start_date, end: period.end_date },
    source_lines: { start: lo + 1, end: hi },
  };
}

function findMoneyAfter(lines: string[], lo: number, hi: number, marker: RegExp): number | null {
  for (let i = lo; i < hi; i++) {
    const ln = lines[i] ?? '';
    if (!marker.test(ln)) continue;
    const inline = extractMoney(ln);
    if (inline !== null) return inline;
    for (let j = i + 1; j < Math.min(hi, i + 10); j++) {
      const candidate = lines[j] ?? '';
      if (candidate.trim().length === 0) continue;
      const v = extractMoney(candidate);
      if (v !== null) return v;
      if (/^[A-Z]/.test(candidate.trim()) && !/balance|deposit|withdrawal/i.test(candidate)) break;
    }
  }
  return null;
}

function findCountAndMoney(
  lines: string[],
  lo: number,
  hi: number,
  marker: RegExp,
): { count: number | null; total: number | null } {
  for (let i = lo; i < hi; i++) {
    const ln = lines[i] ?? '';
    const m = ln.match(marker);
    if (!m) continue;
    const count = Number.parseInt(m[1] as string, 10);
    const inline = extractMoney(ln);
    if (inline !== null) return { count, total: inline };
    for (let j = i + 1; j < Math.min(hi, i + 10); j++) {
      const candidate = lines[j] ?? '';
      if (candidate.trim().length === 0) continue;
      const v = extractMoney(candidate);
      if (v !== null) return { count, total: v };
    }
    return { count, total: null };
  }
  return { count: null, total: null };
}

function extractMoney(line: string): number | null {
  const m = line.match(MONEY_LINE);
  if (!m) return null;
  const norm = normalizeMoneyToken(m[0] as string);
  try {
    return parseMoney(norm.value);
  } catch {
    return null;
  }
}

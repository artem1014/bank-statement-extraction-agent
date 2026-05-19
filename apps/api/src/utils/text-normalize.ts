export interface NormalizeResult {
  value: string;
  repaired: boolean;
}

const MONEY_CANDIDATE = /^-?\$?-?[\d\sOol,]+\.\d{2}-?$/;
const MONEY_STRICT = /^-?\$?-?[\d,]+\.\d{2}-?$/;
const DATE_CANDIDATE = /^[\dOol]{2}\/[\dOol]{2}\/[\dOol]{4}$/;
const DATE_STRICT = /^\d{2}\/\d{2}\/\d{4}$/;

export function normalizeMoneyToken(raw: string): NormalizeResult {
  const trimmed = raw.trim();
  if (!MONEY_CANDIDATE.test(trimmed)) {
    return { value: trimmed, repaired: false };
  }
  const noSpaces = trimmed.replace(/\s+/g, '');
  let out = '';
  for (let i = 0; i < noSpaces.length; i++) {
    const ch = noSpaces[i] as string;
    if (ch === 'O' || ch === 'o' || ch === 'l') {
      const prev = i > 0 ? (noSpaces[i - 1] as string) : '';
      const next = i + 1 < noSpaces.length ? (noSpaces[i + 1] as string) : '';
      const adjacentDigit = (c: string): boolean => /[\d,.\-$]/.test(c);
      if (adjacentDigit(prev) || adjacentDigit(next)) {
        out += ch === 'l' ? '1' : '0';
        continue;
      }
    }
    out += ch;
  }
  const repaired = out !== trimmed;
  return { value: out, repaired };
}

export function normalizeDateToken(raw: string): NormalizeResult {
  const trimmed = raw.trim();
  if (!DATE_CANDIDATE.test(trimmed)) {
    return { value: trimmed, repaired: false };
  }
  const out = trimmed.replace(/[Oo]/g, '0').replace(/l/g, '1');
  return { value: out, repaired: out !== trimmed };
}

export function parseMoney(normalised: string): number {
  if (!MONEY_STRICT.test(normalised.trim())) {
    throw new Error(`parseMoney: not a money token: ${JSON.stringify(normalised)}`);
  }
  let s = normalised.trim();
  let sign = 1;
  if (s.startsWith('-')) {
    sign = -1;
    s = s.slice(1);
  } else if (s.endsWith('-')) {
    sign = -1;
    s = s.slice(0, -1);
  }
  if (s.startsWith('$')) s = s.slice(1);
  if (s.startsWith('-')) {
    sign = -sign;
    s = s.slice(1);
  }
  s = s.replace(/,/g, '');
  const n = Number(s);
  if (!Number.isFinite(n)) {
    throw new Error(`parseMoney: not finite: ${JSON.stringify(normalised)}`);
  }
  return sign * n;
}

export function parseDateMDY(normalised: string): string {
  if (!DATE_STRICT.test(normalised.trim())) {
    throw new Error(`parseDateMDY: not a MM/DD/YYYY token: ${JSON.stringify(normalised)}`);
  }
  const [mm, dd, yyyy] = normalised.trim().split('/') as [string, string, string];
  const month = Number(mm);
  const day = Number(dd);
  const year = Number(yyyy);
  if (month < 1 || month > 12) throw new Error(`parseDateMDY: invalid month: ${month}`);
  if (day < 1 || day > 31) throw new Error(`parseDateMDY: invalid day: ${day}`);
  const dt = new Date(Date.UTC(year, month - 1, day));
  if (dt.getUTCMonth() + 1 !== month || dt.getUTCDate() !== day) {
    throw new Error(`parseDateMDY: out-of-range date: ${normalised}`);
  }
  return `${yyyy}-${mm}-${dd}`;
}

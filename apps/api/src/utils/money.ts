import { Decimal } from 'decimal.js';

Decimal.set({ precision: 28, rounding: Decimal.ROUND_HALF_EVEN });

export const DEFAULT_TOLERANCE = '0.01';

export function toDecimal(value: string | number | Decimal): Decimal {
  if (value instanceof Decimal) return value;
  if (typeof value === 'string') return new Decimal(value);
  if (!Number.isFinite(value)) {
    throw new TypeError(`toDecimal: non-finite number ${String(value)}`);
  }
  return new Decimal(value.toString());
}

export function sumDecimals(values: Iterable<string | number | Decimal>): Decimal {
  let acc = new Decimal(0);
  for (const v of values) acc = acc.plus(toDecimal(v));
  return acc;
}

export function withinTolerance(
  a: string | number | Decimal,
  b: string | number | Decimal,
  eps: string | number | Decimal = DEFAULT_TOLERANCE,
): boolean {
  return toDecimal(a).minus(toDecimal(b)).abs().lte(toDecimal(eps));
}

export function delta(
  actual: string | number | Decimal,
  expected: string | number | Decimal,
): Decimal {
  return toDecimal(actual).minus(toDecimal(expected));
}

export function toNumber(value: Decimal): number {
  return Number(value.toFixed(2));
}

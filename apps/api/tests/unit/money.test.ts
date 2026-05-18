import { Decimal } from 'decimal.js';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_TOLERANCE,
  delta,
  sumDecimals,
  toDecimal,
  toNumber,
  withinTolerance,
} from '../../src/utils/money.js';

describe('money.toDecimal', () => {
  it('returns Decimal as-is', () => {
    const d = new Decimal('1.23');
    expect(toDecimal(d)).toBe(d);
  });

  it('parses strings', () => {
    expect(toDecimal('1.23').toString()).toBe('1.23');
  });

  it('parses finite numbers losslessly via .toString()', () => {
    expect(toDecimal(0.1).plus(toDecimal(0.2)).toString()).toBe('0.3');
  });

  it('throws on NaN / Infinity', () => {
    expect(() => toDecimal(Number.NaN)).toThrow();
    expect(() => toDecimal(Number.POSITIVE_INFINITY)).toThrow();
  });
});

describe('money.sumDecimals', () => {
  it('returns 0 on empty', () => {
    expect(sumDecimals([]).toString()).toBe('0');
  });

  it('sums mixed types', () => {
    expect(sumDecimals(['1.10', 2.2, new Decimal('3.30')]).toString()).toBe('6.6');
  });

  it('is exact for tricky float pairs', () => {
    const values = [0.1, 0.2, 0.3, 0.4, 0.5];
    expect(sumDecimals(values).toString()).toBe('1.5');
  });
});

describe('money.withinTolerance', () => {
  it('treats values within 1 cent as equal by default', () => {
    expect(withinTolerance(100.001, 100.0)).toBe(true);
    expect(withinTolerance(100.0, 100.001)).toBe(true);
  });

  it('rejects values further than 1 cent', () => {
    expect(withinTolerance(100.02, 100.0)).toBe(false);
  });

  it('honours custom epsilon', () => {
    expect(withinTolerance(100.05, 100.0, '0.05')).toBe(true);
    expect(withinTolerance(100.06, 100.0, '0.05')).toBe(false);
  });

  it('DEFAULT_TOLERANCE is 0.01', () => {
    expect(DEFAULT_TOLERANCE).toBe('0.01');
  });
});

describe('money.delta', () => {
  it('returns (actual - expected) as Decimal', () => {
    expect(delta(509121.59, 509121.59).toString()).toBe('0');
    expect(delta(509123.59, 509121.59).toString()).toBe('2');
    expect(delta(509119.59, 509121.59).toString()).toBe('-2');
  });
});

describe('money.toNumber', () => {
  it('rounds to 2 decimal places', () => {
    expect(toNumber(new Decimal('1.234'))).toBe(1.23);
    expect(toNumber(new Decimal('1.235'))).toBe(1.24);
    expect(toNumber(new Decimal('0'))).toBe(0);
  });
});

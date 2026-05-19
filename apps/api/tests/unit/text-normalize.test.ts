import { describe, expect, it } from 'vitest';
import {
  normalizeDateToken,
  normalizeMoneyToken,
  parseDateMDY,
  parseMoney,
} from '../../src/utils/text-normalize.js';

describe('normalizeMoneyToken', () => {
  it('strips internal whitespace inside numeric tokens', () => {
    const r = normalizeMoneyToken('$50 9,121.59');
    expect(r.value).toBe('$509,121.59');
    expect(r.repaired).toBe(true);
  });

  it('repairs O → 0 only when adjacent to digits', () => {
    const r = normalizeMoneyToken('$5O,000.00');
    expect(r.value).toBe('$50,000.00');
    expect(r.repaired).toBe(true);
  });

  it('leaves a clean token untouched and returns repaired=false', () => {
    const r = normalizeMoneyToken('$1,234.56');
    expect(r.value).toBe('$1,234.56');
    expect(r.repaired).toBe(false);
  });

  it('does not modify a non-money token', () => {
    const r = normalizeMoneyToken('OFFICE SUPPLIES');
    expect(r.value).toBe('OFFICE SUPPLIES');
    expect(r.repaired).toBe(false);
  });

  it('handles trailing-minus signed amount', () => {
    const r = normalizeMoneyToken('-$1,000.00');
    expect(r.value).toBe('-$1,000.00');
    expect(r.repaired).toBe(false);
  });

  it('rejects pure garbage via repair=false (not a money candidate)', () => {
    const r = normalizeMoneyToken('hello.world');
    expect(r.repaired).toBe(false);
  });
});

describe('normalizeDateToken', () => {
  it('repairs l → 1 inside a date token', () => {
    const r = normalizeDateToken('0l/01/2025');
    expect(r.value).toBe('01/01/2025');
    expect(r.repaired).toBe(true);
  });

  it('repairs O → 0 inside a date token', () => {
    const r = normalizeDateToken('O5/15/2O25');
    expect(r.value).toBe('05/15/2025');
    expect(r.repaired).toBe(true);
  });

  it('leaves a clean date token alone', () => {
    const r = normalizeDateToken('04/30/2025');
    expect(r.value).toBe('04/30/2025');
    expect(r.repaired).toBe(false);
  });

  it('does not modify a non-date token', () => {
    const r = normalizeDateToken('Apr 30, 2025');
    expect(r.value).toBe('Apr 30, 2025');
    expect(r.repaired).toBe(false);
  });
});

describe('parseMoney', () => {
  it('parses a normalised positive amount', () => {
    expect(parseMoney('$509,121.59')).toBeCloseTo(509121.59, 2);
  });

  it('parses a leading-minus amount', () => {
    expect(parseMoney('-$1,000.00')).toBeCloseTo(-1000, 2);
  });

  it('parses a trailing-minus amount', () => {
    expect(parseMoney('$1,000.00-')).toBeCloseTo(-1000, 2);
  });

  it('throws on malformed input', () => {
    expect(() => parseMoney('$1.O')).toThrow();
  });
});

describe('parseDateMDY', () => {
  it('round-trips a valid date to ISO', () => {
    expect(parseDateMDY('04/30/2025')).toBe('2025-04-30');
  });

  it('rejects Feb 30', () => {
    expect(() => parseDateMDY('02/30/2025')).toThrow();
  });

  it('rejects month 13', () => {
    expect(() => parseDateMDY('13/01/2025')).toThrow();
  });
});

import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseOcrSidecar } from '../../src/pipeline/ocr-sidecar.js';
import { parseTransactionsForPeriod } from '../../src/pipeline/ocr-tx-parser.js';

const FIXTURE = resolve(import.meta.dirname, '..', '..', '..', '..', 'Bank Statement.rtf');

describe('parseTransactionsForPeriod', () => {
  it('returns empty for a period without tables', () => {
    const s = parseOcrSidecar(
      [
        '=== Document Text ===',
        'Beginning Balance as of 04/01/2025',
        'Ending Balance as of 04/30/2025',
      ].join('\n'),
      1,
    );
    const p = s.periods[0];
    if (!p) throw new Error('expected one period');
    const r = parseTransactionsForPeriod(s, p);
    expect(r.transactions).toEqual([]);
  });

  it('parses pipe-separated table rows and skips BEGINNING/ENDING rows', () => {
    const s = parseOcrSidecar(
      [
        '=== Document Text ===',
        'Beginning Balance as of 04/01/2025',
        '$100.00',
        'Ending Balance as of 04/30/2025',
        '$110.00',
        '',
        '=== Tables ===',
        '=== Table ===',
        'Date | Description | Deposits | Withdrawals | Balance',
        '----',
        'Apr 01 | BEGINNING BALANCE |  |  | 100.00',
        'Apr 02 | DEPOSIT ONE | 50.00 |  | 150.00',
        'Apr 03 | WITHDRAWAL ONE |  | 40.00 | 110.00',
        '       | continuation line for the previous row |  |  |',
        'Apr 30 | ENDING BALANCE |  |  | 110.00',
      ].join('\n'),
      1,
    );
    const p = s.periods[0];
    if (!p) throw new Error('expected one period');
    const r = parseTransactionsForPeriod(s, p);
    expect(r.transactions.length).toBe(2);
    const first = r.transactions[0];
    const second = r.transactions[1];
    if (!first || !second) throw new Error('expected two rows');
    expect(first.deposit).toBeCloseTo(50, 2);
    expect(first.withdrawal).toBeNull();
    expect(second.withdrawal).toBeCloseTo(40, 2);
    expect(second.description).toContain('continuation');
  });

  it.runIf(existsSync(FIXTURE))(
    'parses >= 95% of declared April 2025 transactions in the Ixonia fixture',
    () => {
      const raw = readFileSync(FIXTURE, 'utf8');
      const s = parseOcrSidecar(raw, 99);
      const april = s.periods.find((p) => p.start_date === '2025-04-01');
      expect(april).toBeDefined();
      if (!april) return;
      const r = parseTransactionsForPeriod(s, april);
      const expected = 81 + 111;
      expect(r.transactions.length).toBeGreaterThanOrEqual(Math.floor(expected * 0.95));
      const withDeposit = r.transactions.filter((t) => t.deposit !== null).length;
      const withWithdrawal = r.transactions.filter((t) => t.withdrawal !== null).length;
      expect(withDeposit).toBeGreaterThanOrEqual(Math.floor(81 * 0.9));
      expect(withWithdrawal).toBeGreaterThanOrEqual(Math.floor(111 * 0.9));
    },
  );
});

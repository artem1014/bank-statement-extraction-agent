import { describe, expect, it } from 'vitest';
import type { Transaction } from '../../src/domain/types.js';
import { reconcile } from '../../src/pipeline/reconcile.js';

function tx(deposit: number | null, withdrawal: number | null, date = '2025-04-01'): Transaction {
  return {
    date,
    description: 'X',
    deposit,
    withdrawal,
    source_span: { page: null, char_start: null, char_end: null },
  };
}

describe('reconcile', () => {
  it('flags Ixonia-style balanced statement as ok', () => {
    const transactions: Transaction[] = [tx(1000, null), tx(null, 500)];
    const out = reconcile({
      beginning_balance: 5000,
      ending_balance: 5500,
      deposits_total: 1000,
      deposits_count: 1,
      withdrawals_total: 500,
      withdrawals_count: 1,
      transactions,
    });
    expect(out.reconciliation.ok).toBe(true);
    expect(out.reconciliation.delta).toBe(0);
    expect(out.reconciliation.expected_ending).toBe(5500);
    expect(out.warnings).toEqual([]);
  });

  it('flags 2-cent mismatch and reports correct delta', () => {
    const transactions: Transaction[] = [tx(1000, null), tx(null, 500)];
    const out = reconcile({
      beginning_balance: 5000,
      ending_balance: 5502,
      deposits_total: 1000,
      deposits_count: 1,
      withdrawals_total: 500,
      withdrawals_count: 1,
      transactions,
    });
    expect(out.reconciliation.ok).toBe(false);
    expect(out.reconciliation.delta).toBe(2);
    expect(out.reconciliation.expected_ending).toBe(5500);
  });

  it('treats 1-cent drift as ok (within tolerance)', () => {
    const transactions: Transaction[] = [tx(1000.005, null), tx(null, 500)];
    const out = reconcile({
      beginning_balance: 5000,
      ending_balance: 5500.005,
      deposits_total: 1000.005,
      deposits_count: 1,
      withdrawals_total: 500,
      withdrawals_count: 1,
      transactions,
    });
    expect(out.reconciliation.ok).toBe(true);
  });

  it('emits warning when deposits_total mismatches transaction sum', () => {
    const transactions: Transaction[] = [tx(1000, null), tx(2000, null)];
    const out = reconcile({
      beginning_balance: 0,
      ending_balance: 3000,
      deposits_total: 3001,
      deposits_count: 2,
      withdrawals_total: 0,
      withdrawals_count: 0,
      transactions,
    });
    expect(out.warnings.some((w) => w.startsWith('deposits-total-mismatch'))).toBe(true);
  });

  it('emits warning when count of non-null deposits differs from declared', () => {
    const transactions: Transaction[] = [tx(1000, null)];
    const out = reconcile({
      beginning_balance: 0,
      ending_balance: 1000,
      deposits_total: 1000,
      deposits_count: 2,
      withdrawals_total: 0,
      withdrawals_count: 0,
      transactions,
    });
    expect(out.warnings.some((w) => w.startsWith('deposits-count-mismatch'))).toBe(true);
  });

  it('ignores ambiguous-direction rows in totals (both null)', () => {
    const transactions: Transaction[] = [tx(1000, null), tx(null, null)];
    const out = reconcile({
      beginning_balance: 0,
      ending_balance: 1000,
      deposits_total: 1000,
      deposits_count: 1,
      withdrawals_total: 0,
      withdrawals_count: 0,
      transactions,
    });
    expect(out.reconciliation.ok).toBe(true);
    expect(out.txDepositsCount).toBe(1);
    expect(out.txWithdrawalsCount).toBe(0);
  });

  it('uses decimal arithmetic — sum of 0.1 + 0.2 is exact', () => {
    const transactions: Transaction[] = [tx(0.1, null), tx(0.2, null)];
    const out = reconcile({
      beginning_balance: 0,
      ending_balance: 0.3,
      deposits_total: 0.3,
      deposits_count: 2,
      withdrawals_total: 0,
      withdrawals_count: 0,
      transactions,
    });
    expect(out.reconciliation.ok).toBe(true);
    expect(out.reconciliation.delta).toBe(0);
    expect(out.warnings).toEqual([]);
  });
});

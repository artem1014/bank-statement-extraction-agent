import type { Reconciliation, Summary, Transaction } from '../domain/types.js';
import {
  delta as decimalDelta,
  sumDecimals,
  toDecimal,
  toNumber,
  withinTolerance,
} from '../utils/money.js';

export interface ReconcileInput {
  beginning_balance: number;
  ending_balance: number;
  deposits_total: number;
  deposits_count: number;
  withdrawals_total: number;
  withdrawals_count: number;
  transactions: Transaction[];
}

export interface ReconcileOutput {
  reconciliation: Reconciliation;
  txDepositsTotal: number;
  txDepositsCount: number;
  txWithdrawalsTotal: number;
  txWithdrawalsCount: number;
  warnings: string[];
}

export function reconcile(input: ReconcileInput): ReconcileOutput {
  const txDeposits = input.transactions
    .map((t) => t.deposit)
    .filter((v): v is number => v !== null);
  const txWithdrawals = input.transactions
    .map((t) => t.withdrawal)
    .filter((v): v is number => v !== null);

  const txDepositsSum = sumDecimals(txDeposits);
  const txWithdrawalsSum = sumDecimals(txWithdrawals);

  const expected = toDecimal(input.beginning_balance).plus(txDepositsSum).minus(txWithdrawalsSum);
  const ok = withinTolerance(input.ending_balance, expected);
  const delta = decimalDelta(input.ending_balance, expected);

  const reconciliation: Reconciliation = {
    ok,
    delta: toNumber(delta),
    expected_ending: toNumber(expected),
  };

  const warnings: string[] = [];
  if (!withinTolerance(input.deposits_total, txDepositsSum)) {
    const d = toNumber(decimalDelta(input.deposits_total, txDepositsSum));
    warnings.push(
      `deposits-total-mismatch: statement=${input.deposits_total} sum-of-transactions=${toNumber(txDepositsSum)} delta=${d}`,
    );
  }
  if (input.deposits_count !== txDeposits.length) {
    warnings.push(
      `deposits-count-mismatch: statement=${input.deposits_count} non-null-transactions=${txDeposits.length}`,
    );
  }
  if (!withinTolerance(input.withdrawals_total, txWithdrawalsSum)) {
    const d = toNumber(decimalDelta(input.withdrawals_total, txWithdrawalsSum));
    warnings.push(
      `withdrawals-total-mismatch: statement=${input.withdrawals_total} sum-of-transactions=${toNumber(txWithdrawalsSum)} delta=${d}`,
    );
  }
  if (input.withdrawals_count !== txWithdrawals.length) {
    warnings.push(
      `withdrawals-count-mismatch: statement=${input.withdrawals_count} non-null-transactions=${txWithdrawals.length}`,
    );
  }

  return {
    reconciliation,
    txDepositsTotal: toNumber(txDepositsSum),
    txDepositsCount: txDeposits.length,
    txWithdrawalsTotal: toNumber(txWithdrawalsSum),
    txWithdrawalsCount: txWithdrawals.length,
    warnings,
  };
}

export function buildSummary(input: ReconcileInput, reconciliation: Reconciliation): Summary {
  return {
    beginning_balance: input.beginning_balance,
    ending_balance: input.ending_balance,
    deposits_total: input.deposits_total,
    deposits_count: input.deposits_count,
    withdrawals_total: input.withdrawals_total,
    withdrawals_count: input.withdrawals_count,
    reconciliation,
  };
}

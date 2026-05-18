import { describe, expect, it } from 'vitest';
import { isRetriable } from '../src/errors.js';
import {
  ExtractResultSchema,
  LlmExtractionInputSchema,
  TransactionSchema,
} from '../src/schemas.js';

const IXONIA_VALID: unknown = {
  account: {
    bank: 'Ixonia Bank',
    account_last4: '4664',
    period: { start: '2025-04-01', end: '2025-04-30' },
  },
  summary: {
    beginning_balance: 597068.7,
    ending_balance: 509121.59,
    deposits_total: 1214254.05,
    deposits_count: 81,
    withdrawals_total: 1302201.16,
    withdrawals_count: 111,
    reconciliation: { ok: true, delta: 0, expected_ending: 509121.59 },
  },
  transactions: [
    {
      date: '2025-04-01',
      description: 'AIRLINEHYD 2759/VENDOR PMT',
      deposit: 1809.28,
      withdrawal: null,
      source_span: { page: null, char_start: 1234, char_end: 1289 },
    },
  ],
  extraction: {
    model: 'claude-sonnet-4-6',
    prompt_version: 'v1.0.0',
    duration_ms: 14230,
    warnings: [],
  },
};

describe('ExtractResultSchema', () => {
  it('parses the Ixonia reference example successfully', () => {
    const parsed = ExtractResultSchema.parse(IXONIA_VALID);
    expect(parsed.account.account_last4).toBe('4664');
    expect(parsed.transactions).toHaveLength(1);
    expect(parsed.summary.reconciliation.ok).toBe(true);
  });

  it('rejects account_last4 that is not exactly 4 digits', () => {
    const bad = structuredClone(IXONIA_VALID) as { account: { account_last4: string } };
    bad.account.account_last4 = '12345';
    expect(() => ExtractResultSchema.parse(bad)).toThrow(/account_last4/);
  });

  it('rejects period where end is before start', () => {
    const bad = structuredClone(IXONIA_VALID) as {
      account: { period: { start: string; end: string } };
    };
    bad.account.period.start = '2025-04-30';
    bad.account.period.end = '2025-04-01';
    expect(() => ExtractResultSchema.parse(bad)).toThrow(/period.end/);
  });

  it('rejects negative deposits_total', () => {
    const bad = structuredClone(IXONIA_VALID) as { summary: { deposits_total: number } };
    bad.summary.deposits_total = -1;
    expect(() => ExtractResultSchema.parse(bad)).toThrow();
  });

  it('rejects non-integer deposits_count', () => {
    const bad = structuredClone(IXONIA_VALID) as { summary: { deposits_count: number } };
    bad.summary.deposits_count = 2.5;
    expect(() => ExtractResultSchema.parse(bad)).toThrow();
  });

  it('rejects malformed date', () => {
    const bad = structuredClone(IXONIA_VALID) as { transactions: { date: string }[] };
    const tx = bad.transactions[0];
    if (tx) tx.date = '04/01/2025';
    expect(() => ExtractResultSchema.parse(bad)).toThrow(/ISO/);
  });
});

describe('TransactionSchema (direction rule is enforced in the pipeline, not in Zod)', () => {
  const baseTx = {
    date: '2025-04-01',
    description: 'Test',
    deposit: 100,
    withdrawal: null,
    source_span: { page: 1, char_start: 0, char_end: 4 },
  };

  it('accepts deposit-only row', () => {
    expect(TransactionSchema.safeParse(baseTx).success).toBe(true);
  });

  it('accepts withdrawal-only row', () => {
    expect(TransactionSchema.safeParse({ ...baseTx, deposit: null, withdrawal: 50 }).success).toBe(
      true,
    );
  });

  it('accepts both-null row (ambiguous; warning attached separately by the pipeline)', () => {
    expect(
      TransactionSchema.safeParse({ ...baseTx, deposit: null, withdrawal: null }).success,
    ).toBe(true);
  });

  it('still accepts both-non-null at the Zod level (pipeline rejects this case)', () => {
    expect(TransactionSchema.safeParse({ ...baseTx, deposit: 100, withdrawal: 50 }).success).toBe(
      true,
    );
  });
});

describe('LlmExtractionInputSchema', () => {
  it('omits summary.reconciliation', () => {
    const llmInput = {
      account: IXONIA_VALID.account,
      summary: {
        beginning_balance: 1,
        ending_balance: 1,
        deposits_total: 0,
        deposits_count: 0,
        withdrawals_total: 0,
        withdrawals_count: 0,
      },
      transactions: [],
      extraction: { warnings: [] },
    };
    const parsed = LlmExtractionInputSchema.parse(llmInput);
    expect('reconciliation' in parsed.summary).toBe(false);
  });

  it('silently strips a stray reconciliation field if the LLM emits one (per prompt contract)', () => {
    const llmInput = {
      account: IXONIA_VALID.account,
      summary: {
        beginning_balance: 1,
        ending_balance: 1,
        deposits_total: 0,
        deposits_count: 0,
        withdrawals_total: 0,
        withdrawals_count: 0,
        reconciliation: { ok: true, delta: 0, expected_ending: 1 },
      },
      transactions: [],
      extraction: { warnings: [] },
    };
    const parsed = LlmExtractionInputSchema.parse(llmInput);
    expect('reconciliation' in parsed.summary).toBe(false);
  });
});

describe('errors.isRetriable', () => {
  it('marks LLM_UNAVAILABLE and EXTRACTION_FAILED as retriable', () => {
    expect(isRetriable('LLM_UNAVAILABLE')).toBe(true);
    expect(isRetriable('EXTRACTION_FAILED')).toBe(true);
  });
  it('marks BAD_FILE as non-retriable', () => {
    expect(isRetriable('BAD_FILE')).toBe(false);
  });
});

import { z } from 'zod';

export const IsoDateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'date must be ISO YYYY-MM-DD');

export const PeriodSchema = z
  .object({
    start: IsoDateSchema,
    end: IsoDateSchema,
  })
  .refine((p) => p.start <= p.end, {
    message: 'period.end must be greater than or equal to period.start',
    path: ['end'],
  });

export const AccountSchema = z.object({
  bank: z.string().min(1).nullable(),
  account_last4: z
    .string()
    .regex(/^\d{4}$/, 'account_last4 must be exactly 4 digits')
    .nullable(),
  period: PeriodSchema,
});

export const ReconciliationSchema = z.object({
  ok: z.boolean(),
  delta: z.number().finite(),
  expected_ending: z.number().finite(),
});

export const SummarySchema = z.object({
  beginning_balance: z.number().finite(),
  ending_balance: z.number().finite(),
  deposits_total: z.number().finite().nonnegative(),
  deposits_count: z.number().int().nonnegative(),
  withdrawals_total: z.number().finite().nonnegative(),
  withdrawals_count: z.number().int().nonnegative(),
  reconciliation: ReconciliationSchema,
});

export const SourceSpanSchema = z.object({
  page: z.number().int().positive().nullable(),
  char_start: z.number().int().nonnegative().nullable(),
  char_end: z.number().int().nonnegative().nullable(),
});

export const TransactionSchema = z.object({
  date: IsoDateSchema,
  description: z.string().trim().min(1),
  deposit: z.number().finite().nonnegative().nullable(),
  withdrawal: z.number().finite().nonnegative().nullable(),
  source_span: SourceSpanSchema,
});

export const ExtractionMetadataSchema = z.object({
  model: z.string().min(1),
  prompt_version: z.string().min(1),
  duration_ms: z.number().int().nonnegative(),
  warnings: z.array(z.string().min(1)),
});

export const ExtractResultSchema = z.object({
  account: AccountSchema,
  summary: SummarySchema,
  transactions: z.array(TransactionSchema),
  extraction: ExtractionMetadataSchema,
});

export const ExtractResultArraySchema = z.array(ExtractResultSchema);

const LlmSummarySchema = SummarySchema.omit({ reconciliation: true });
const LlmExtractionMetadataSchema = z.object({
  warnings: z.array(z.string()),
});

export const LlmExtractionInputSchema = z.object({
  account: AccountSchema,
  summary: LlmSummarySchema,
  transactions: z.array(TransactionSchema),
  extraction: LlmExtractionMetadataSchema,
});

export const LlmExtractionInputArraySchema = z.object({
  periods: z.array(LlmExtractionInputSchema),
});

export type IsoDate = z.infer<typeof IsoDateSchema>;
export type Period = z.infer<typeof PeriodSchema>;
export type Account = z.infer<typeof AccountSchema>;
export type Reconciliation = z.infer<typeof ReconciliationSchema>;
export type Summary = z.infer<typeof SummarySchema>;
export type LlmSummary = z.infer<typeof LlmSummarySchema>;
export type SourceSpan = z.infer<typeof SourceSpanSchema>;
export type Transaction = z.infer<typeof TransactionSchema>;
export type ExtractionMetadata = z.infer<typeof ExtractionMetadataSchema>;
export type ExtractResult = z.infer<typeof ExtractResultSchema>;
export type ExtractResultArray = z.infer<typeof ExtractResultArraySchema>;
export type LlmExtractionInput = z.infer<typeof LlmExtractionInputSchema>;
export type LlmExtractionInputArray = z.infer<typeof LlmExtractionInputArraySchema>;

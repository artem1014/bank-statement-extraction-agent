import { z } from 'zod';

export const ErrorCodeSchema = z.enum(['BAD_FILE', 'EXTRACTION_FAILED', 'LLM_UNAVAILABLE']);
export type ErrorCode = z.infer<typeof ErrorCodeSchema>;

export const ErrorBodySchema = z.object({
  code: ErrorCodeSchema,
  message: z.string().min(1),
});
export type ErrorBody = z.infer<typeof ErrorBodySchema>;

export const RETRIABLE_ERROR_CODES = [
  'EXTRACTION_FAILED',
  'LLM_UNAVAILABLE',
] as const satisfies readonly ErrorCode[];

export function isRetriable(code: ErrorCode): boolean {
  return (RETRIABLE_ERROR_CODES as readonly ErrorCode[]).includes(code);
}

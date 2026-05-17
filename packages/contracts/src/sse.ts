import { z } from 'zod';
import { ErrorBodySchema } from './errors.js';
import { ExtractResultSchema } from './schemas.js';

export const StageNameSchema = z.enum(['upload', 'parse', 'extract', 'reconcile']);
export type StageName = z.infer<typeof StageNameSchema>;

export const StageStatusSchema = z.enum(['pending', 'active', 'done', 'error']);
export type StageStatus = z.infer<typeof StageStatusSchema>;

export const STAGE_NAMES = [
  'upload',
  'parse',
  'extract',
  'reconcile',
] as const satisfies readonly StageName[];

export const StageEventDataSchema = z.object({
  stage: StageNameSchema,
  status: StageStatusSchema,
});
export type StageEventData = z.infer<typeof StageEventDataSchema>;

export const ResultEventDataSchema = ExtractResultSchema;
export type ResultEventData = z.infer<typeof ResultEventDataSchema>;

export const ErrorEventDataSchema = ErrorBodySchema;
export type ErrorEventData = z.infer<typeof ErrorEventDataSchema>;

export const SseEventNameSchema = z.enum(['stage', 'result', 'error']);
export type SseEventName = z.infer<typeof SseEventNameSchema>;

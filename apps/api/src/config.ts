import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { config as loadDotenv } from 'dotenv';
import { z } from 'zod';

for (const candidate of [
  resolve(process.cwd(), '.env'),
  resolve(process.cwd(), '..', '..', '.env'),
  resolve(import.meta.dirname ?? process.cwd(), '..', '..', '..', '.env'),
]) {
  if (existsSync(candidate)) {
    loadDotenv({ path: candidate, override: false });
    break;
  }
}

const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(8080),
  CORS_ORIGIN: z.string().url().default('http://localhost:5173'),
  OPENAI_API_KEY: z.string().min(1, 'OPENAI_API_KEY is required'),
  OPENAI_MODEL: z.string().min(1).default('gpt-4.1'),
  OPENAI_CHUNK_BUDGET_BYTES: z.coerce
    .number()
    .int()
    .positive()
    .default(28 * 1024 * 1024),
  OPENAI_CHUNK_PAGE_BUDGET: z.coerce.number().int().positive().default(20),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  MAX_PDF_BYTES: z.coerce
    .number()
    .int()
    .positive()
    .default(100 * 1024 * 1024),
  MAX_OCR_BYTES: z.coerce
    .number()
    .int()
    .positive()
    .default(2 * 1024 * 1024),
  EXTRACTION_MODE: z.enum(['ocr-first', 'ocr-only', 'llm-only']).default('ocr-first'),
});

export const ExtractionModeSchema = z.enum(['ocr-first', 'ocr-only', 'llm-only']);
export type ExtractionMode = z.infer<typeof ExtractionModeSchema>;

export type Config = z.infer<typeof EnvSchema>;

function loadConfig(): Config {
  const parsed = EnvSchema.safeParse(process.env);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('\n');
    throw new Error(`Invalid environment configuration:\n${issues}`);
  }
  return parsed.data;
}

export const config: Config = loadConfig();

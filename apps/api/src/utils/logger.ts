import pino from 'pino';
import { config } from '../config.js';

const REDACT_PATHS = [
  'req.headers.authorization',
  'req.headers.cookie',
  'req.body',
  '*.OPENAI_API_KEY',
  '*.openai_api_key',
  'env.OPENAI_API_KEY',
  'env.openai_api_key',
  '*.sidecarText',
  '*.rawText',
  '*.ocrText',
  '*.description',
  '*.amount',
  'sidecarText',
  'rawText',
  'ocrText',
];

export const logger = pino({
  level: config.LOG_LEVEL,
  base: { service: 'bse-api' },
  redact: { paths: REDACT_PATHS, censor: '[redacted]' },
  ...(config.NODE_ENV === 'development'
    ? {
        transport: {
          target: 'pino/file',
          options: { destination: 1 },
        },
      }
    : {}),
});

export type Logger = typeof logger;

export function withCorrelation(requestId: string): Logger {
  return logger.child({ requestId });
}

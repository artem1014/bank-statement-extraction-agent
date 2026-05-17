import type { ErrorCode } from '@app/contracts';

export class TypedError extends Error {
  public readonly code: ErrorCode;
  public readonly userMessage: string;
  public override readonly cause?: unknown;

  constructor(code: ErrorCode, userMessage: string, cause?: unknown) {
    super(userMessage);
    this.code = code;
    this.userMessage = userMessage;
    this.cause = cause;
    this.name = 'TypedError';
  }
}

export class BadFileError extends TypedError {
  constructor(
    userMessage = "We couldn't read your PDF. Make sure it's not corrupted or password-protected.",
    cause?: unknown,
  ) {
    super('BAD_FILE', userMessage, cause);
    this.name = 'BadFileError';
  }
}

export class ExtractionFailedError extends TypedError {
  constructor(
    userMessage = "The AI couldn't extract data from this statement. Please try a clearer scan.",
    cause?: unknown,
  ) {
    super('EXTRACTION_FAILED', userMessage, cause);
    this.name = 'ExtractionFailedError';
  }
}

export class LlmUnavailableError extends TypedError {
  constructor(
    userMessage = 'Our extraction service is temporarily unavailable. Please try again in a moment.',
    cause?: unknown,
  ) {
    super('LLM_UNAVAILABLE', userMessage, cause);
    this.name = 'LlmUnavailableError';
  }
}

export function isTypedError(e: unknown): e is TypedError {
  return e instanceof TypedError;
}

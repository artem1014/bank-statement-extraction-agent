import { Hono } from 'hono';
import { stream } from 'hono/streaming';
import { config } from '../config.js';
import {
  BadFileError,
  ExtractionFailedError,
  LlmUnavailableError,
  OcrSidecarInvalidError,
  OcrSidecarTooLargeError,
  TypedError,
} from '../domain/errors.js';
import { extractDispatch } from '../pipeline/extract.js';
import { createOpenAIClient } from '../pipeline/openai-client.js';
import { StageEmitter } from '../pipeline/stage-emitter.js';
import { newCorrelationId } from '../utils/correlation.js';
import { withCorrelation } from '../utils/logger.js';
import { isPdfBuffer } from '../utils/mime.js';

const PROMPT_VERSION = 'v2.1.0';

export const extractRoute = new Hono().post('/', async (c) => {
  const requestId = newCorrelationId();
  c.header('X-Request-Id', requestId);
  const log = withCorrelation(requestId);
  let form: FormData;
  try {
    form = await c.req.formData();
  } catch (_err) {
    return c.json(
      {
        code: 'BAD_FILE' as const,
        message: 'Request body is not a valid multipart form.',
        retriable: false,
      },
      400,
    );
  }

  const pdfField = form.get('pdf');
  const ocrField = form.get('ocr_text');

  if (!(pdfField instanceof File)) {
    return c.json(
      {
        code: 'BAD_FILE' as const,
        message: "Multipart field 'pdf' (a File) is required.",
        retriable: false,
      },
      400,
    );
  }

  if (pdfField.size > config.MAX_PDF_BYTES) {
    return c.json(
      {
        code: 'BAD_FILE' as const,
        message: `PDF exceeds the ${config.MAX_PDF_BYTES.toLocaleString()}-byte limit.`,
        retriable: false,
      },
      413,
    );
  }

  const pdfBuf = new Uint8Array(await pdfField.arrayBuffer());
  if (!isPdfBuffer(pdfBuf)) {
    return c.json(
      {
        code: 'BAD_FILE' as const,
        message: 'Uploaded file is not a PDF (failed magic-byte check).',
        retriable: false,
      },
      415,
    );
  }

  let ocrText: string | undefined;
  if (ocrField instanceof File) {
    if (ocrField.size > config.MAX_OCR_BYTES) {
      return c.json(
        {
          code: 'BAD_FILE' as const,
          message: `OCR text exceeds the ${config.MAX_OCR_BYTES.toLocaleString()}-byte limit.`,
          retriable: false,
        },
        413,
      );
    }
    ocrText = await ocrField.text();
  } else if (typeof ocrField === 'string' && ocrField.length > 0) {
    ocrText = ocrField;
  }

  c.header('Content-Type', 'text/event-stream; charset=utf-8');
  c.header('Cache-Control', 'no-cache, no-transform');
  c.header('Connection', 'keep-alive');
  c.header('X-Accel-Buffering', 'no');

  return stream(c, async (s) => {
    const emitter = new StageEmitter({
      write: async (chunk) => {
        await s.write(chunk);
      },
      close: () => Promise.resolve(),
    });

    try {
      const client = createOpenAIClient(config);
      const results = await extractDispatch({
        pdfBytes: pdfBuf,
        client,
        promptVersion: PROMPT_VERSION,
        chunkBudgetBytes: config.OPENAI_CHUNK_BUDGET_BYTES,
        chunkPageBudget: config.OPENAI_CHUNK_PAGE_BUDGET,
        ocrText,
        mode: config.EXTRACTION_MODE,
        requestId,
        onProgress: async (e) => {
          await emitter.emitStage(e.stage, e.status, e.detail);
        },
      });
      await emitter.emitResult(results);
    } catch (err) {
      const typed = err instanceof TypedError ? err : null;
      const referenceTag = `Reference: ${requestId}.`;
      const body =
        typed instanceof BadFileError
          ? { code: 'BAD_FILE' as const, message: `${typed.userMessage} ${referenceTag}` }
          : typed instanceof OcrSidecarTooLargeError
            ? {
                code: 'OCR_SIDECAR_TOO_LARGE' as const,
                message: `${typed.userMessage} ${referenceTag}`,
              }
            : typed instanceof OcrSidecarInvalidError
              ? {
                  code: 'OCR_SIDECAR_INVALID' as const,
                  message: `${typed.userMessage} ${referenceTag}`,
                }
              : typed instanceof LlmUnavailableError
                ? {
                    code: 'LLM_UNAVAILABLE' as const,
                    message: `${typed.userMessage} ${referenceTag}`,
                  }
                : typed instanceof ExtractionFailedError
                  ? {
                      code: 'EXTRACTION_FAILED' as const,
                      message: `${typed.userMessage} ${referenceTag}`,
                    }
                  : {
                      code: 'EXTRACTION_FAILED' as const,
                      message: `An unexpected error occurred during extraction. ${referenceTag}`,
                    };
      log.error({ err }, 'extract-route-failed');
      await emitter.emitError(body);
    }
  });
});

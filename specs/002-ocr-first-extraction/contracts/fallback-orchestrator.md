# Contract: OCR-First Orchestrator with Per-Field LLM Fallback

**Feature**: 002-ocr-first-extraction
**Scope**: Internal TypeScript contract for `apps/api/src/pipeline/ocr-orchestrator.ts` — the top-level coordinator that wires the parser triplet together, runs the per-field fallback escalator, attaches reconciliation, and emits the final `ExtractResult[]`.

---

## Public API

```ts
import type {
  ExtractResult,
  ExtractProgressEvent,
} from '@app/contracts';
import type { OpenAIPipelineClient } from './openai-client';

export interface ExtractWithOcrFirstInput {
  pdfBytes: Uint8Array;
  ocrText: string;
  openai: OpenAIPipelineClient;
  mode: 'ocr-first' | 'ocr-only';
  /** SSE progress emitter; receives stage events identical in shape to feature 001. */
  onProgress?: (event: ExtractProgressEvent) => Promise<void>;
  /** Correlation id for the per-request child logger (set by routes/extract.ts). */
  requestId: string;
}

export async function extractWithOcrFirst(
  input: ExtractWithOcrFirstInput,
): Promise<ExtractResult[]>;
```

The function lives alongside the existing `extractPdf()` in `pipeline/extract.ts`. The route layer (`routes/extract.ts`) decides which to call:

| `EXTRACTION_MODE` | `ocr_text` field present? | Function invoked |
|---|---|---|
| `ocr-first` (default) | yes | `extractWithOcrFirst({ mode: 'ocr-first', ... })` |
| `ocr-first` (default) | no | `extractPdf(...)` (feature-001 legacy path) |
| `ocr-only` | yes | `extractWithOcrFirst({ mode: 'ocr-only', ... })` |
| `ocr-only` | no | `extractPdf(...)` with a request-level warning `ocr-only-mode-without-sidecar` |
| `llm-only` | yes | `extractPdf(...)` — sidecar **ignored**, warning `llm-only-mode-ignored-sidecar` |
| `llm-only` | no | `extractPdf(...)` (feature-001 legacy path) |

---

## Internal flow

```text
extractWithOcrFirst(input):

  1. Parse the sidecar:
       sidecar = parseOcrSidecar(input.ocrText)
       periods = sidecar.periods   // from existing ocr-indexer.ts

     If sidecar.periods.length === 0:
       throw new ExtractionFailedError(
         code='OCR_SIDECAR_INVALID',
         reason='no periods detected'
       )

  2. emit stage('indexing-complete', { periods: periods.length })

  3. For each period in periods:                         ← parallelised via
       record = createPeriodRecord(period)               ← mapWithConcurrency
                                                         ← (limit = OCR_PARSE_CONCURRENCY,
                                                         ←  default 5; pure-CPU work)
       summary = parseSummaryBlock(sidecar, period)
       txResult = parseTransactionsForPeriod(sidecar, period)
       record.summary = summary
       record.transactions = txResult.transactions
       record.warnings.push(...txResult.warnings)

       missingSummaryFields = collectNulls(summary)
       needsTxFallback     = (txResult.transactions.length === 0)

       if (mode === 'ocr-first' && (missingSummaryFields.length || needsTxFallback)):
         periodPdfBytes = pdfSplitter.extractPages(
           input.pdfBytes,
           period.pdfPageStart,
           period.pdfPageEnd
         )
         llmResult = await input.openai.extractPeriod(
           periodPdfBytes,
           periodLabel(period),
           { hint: 'fields_missing_from_ocr', fields: missingSummaryFields }
         )
         mergeLlmIntoRecord(record, llmResult, missingSummaryFields, needsTxFallback)
         emit stage('llm-fallback', { period: periodLabel(period),
                                       fields: missingSummaryFields,
                                       txList: needsTxFallback })

       if (mode === 'ocr-only' && (missingSummaryFields.length || needsTxFallback)):
         record.warnings.push(`ocr-only-missing: ${...}`)
         (no LLM call)

       record.reconciliation = reconcile(record.summary, record.transactions)
       emit stage('period-done', { period: periodLabel(period),
                                    reconciliation: record.reconciliation.ok })

  4. results = records
       .sort((a,b) => a.spec.ocrLineStart - b.spec.ocrLineStart)   // FR-014
       .map(reduceToWireShape)

  5. return results
```

---

## Behavioural contract

- **Concurrency**: per-period OCR parsing is CPU-bound and side-effect-free, so it runs through `mapWithConcurrency(periods, OCR_PARSE_CONCURRENCY, ...)`. Default `OCR_PARSE_CONCURRENCY = 5`. The LLM-fallback call inherits the existing `TX_WINDOW_CONCURRENCY = 3` cap when active.
- **Determinism (SC-010)**: on the full-OCR happy path (no fallback fires), repeated runs MUST produce byte-identical `ExtractResult[]` (modulo `extraction.duration_ms` and timestamps).
- **Fallback scope**: when an LLM call is needed, it operates on **a single period's PDF page range** (`pdf-splitter.extractPages(pdfBytes, period.pdfPageStart, period.pdfPageEnd)`), never the whole document. The legacy multi-window chunking inside that call is reused unchanged.
- **Provenance accounting (FR-012)**: every LLM-recovered field results in exactly one warning of the form `recovered-via-llm: <wire-path>`. Examples:
  - `recovered-via-llm: summary.beginning_balance`
  - `recovered-via-llm: summary.deposits_count`
  - `recovered-via-llm: transactions` (full list)
  - `recovered-via-llm: transactions (partial)` (mixed)
- **Error handling (FR-013, SC-009)**: any error raised inside the orchestrator is mapped to a typed error from `domain/errors.ts`. The user-facing message MUST NOT include sidecar text slices. Internal `pino.debug({ requestId, sidecarLineRange })` calls MAY include slices for offline debugging.
- **`ocr-only` mode**: never invokes `input.openai.*`. The OpenAI client argument is still accepted for type-uniformity but is unused.
- **Output ordering (FR-014)**: ascending by `period.ocrLineStart`. This is the canonical OCR-order resolution from clarification Q5.

---

## Stage events (SSE)

All events match the **existing** `ExtractEventData` shape (FR-007 — no wire contract changes). The new event `name`s introduced by this feature:

| Stage `name` | Trigger | `detail` payload (free-form JSON) |
|---|---|---|
| `mode-resolved` | First action of orchestrator | `{ mode: 'ocr-first' \| 'ocr-only', sidecar_size: <bytes> }` |
| `indexing-complete` | After `ocr-indexer.ts` runs | `{ periods: <count> }` |
| `period-parse-start` | Top of per-period loop | `{ period: '2025-04', i: 0, total: 10 }` |
| `llm-fallback` | When per-field fallback fires | `{ period, fields: ['summary.beginning_balance', ...], txList: bool }` |
| `period-done` | Bottom of per-period loop | `{ period, reconciliation: bool, source: 'ocr' \| 'mixed' }` |

The existing `stage` events from feature 001 (`uploading`, `pdf-validated`, `indexing`, `extracting`, `reconciling`, `result-ready`) are reused unchanged for the legacy LLM path.

---

## Failure modes & their codes

| Failure | Code (added to `domain/errors.ts`) | Client-visible message | Logged at DEBUG |
|---|---|---|---|
| Sidecar is provided but parse yields zero periods | `OCR_SIDECAR_INVALID` | `"OCR sidecar contained no recognisable statement periods. Reference: <uuid>"` | sidecar line count, first 200 chars hash, period detection summary |
| Sidecar over `MAX_OCR_BYTES` | `OCR_SIDECAR_TOO_LARGE` | `"OCR sidecar exceeds size limit. Reference: <uuid>"` | actual byte count |
| Per-period parse fails AND fallback also fails (mode ocr-first) | `EXTRACTION_FAILED` | `"Extraction failed. Reference: <uuid>"` | period span, missing fields, LLM error chain |
| Per-period parse fails in mode ocr-only | (none — emits period with nulls + `period-extraction-failed` warning) | n/a | period span, missing fields |
| LLM unavailable during fallback | `LLM_UNAVAILABLE` | `"LLM service unavailable. Reference: <uuid>"` | period being processed |

All client-visible messages embed the correlation UUID per research R-5.

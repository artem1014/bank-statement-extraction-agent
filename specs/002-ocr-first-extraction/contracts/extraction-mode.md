# Contract: `EXTRACTION_MODE` Configuration

**Feature**: 002-ocr-first-extraction
**Scope**: Internal configuration contract for the env-driven extraction mode switch (FR-009, FR-010, clarification Q3).

---

## Configuration shape

Added to `apps/api/src/config.ts` (alongside existing `MAX_PDF_BYTES`, `MAX_OCR_BYTES`, etc.):

```ts
const ExtractionMode = z.enum(['ocr-first', 'ocr-only', 'llm-only']);

const ConfigSchema = z.object({
  // existing fields ...
  EXTRACTION_MODE: ExtractionMode.default('ocr-first'),
});
```

Documented in `.env.example`:

```
# Extraction mode. Controls how the /api/extract route processes uploads.
# - ocr-first  (default) : Parse the OCR sidecar deterministically; fall back to
#                          OpenAI per-field for unrecoverable fields. If no
#                          sidecar is provided, use the legacy LLM-only path.
# - ocr-only             : Same as ocr-first but NEVER call OpenAI; unrecoverable
#                          fields are emitted as null with a warning. Useful for
#                          offline runs and for measuring deterministic recall.
# - llm-only             : Always use the legacy LLM-only path; ignore any
#                          provided sidecar.
EXTRACTION_MODE=ocr-first
```

---

## Routing matrix (single source of truth)

| `EXTRACTION_MODE` | `ocr_text` multipart field | Behaviour |
|---|---|---|
| `ocr-first` (default) | present | `extractWithOcrFirst({ mode: 'ocr-first' })` — deterministic parsing with per-field LLM fallback |
| `ocr-first` (default) | absent  | `extractPdf(...)` — legacy LLM-only path |
| `ocr-only`            | present | `extractWithOcrFirst({ mode: 'ocr-only' })` — deterministic parsing only, no LLM |
| `ocr-only`            | absent  | `extractPdf(...)` + add warning `ocr-only-mode-without-sidecar` to every period |
| `llm-only`            | present | `extractPdf(...)` + add warning `llm-only-mode-ignored-sidecar` to every period |
| `llm-only`            | absent  | `extractPdf(...)` — legacy LLM-only path |

---

## CLI flag override

`apps/api/scripts/extract-cli.ts` exposes a `--mode` flag that overrides the env value for that invocation only:

```sh
pnpm -F @app/api extract:cli ./statement.pdf --ocr ./statement.rtf --mode ocr-only
```

Validation: Zod-parsed against `ExtractionMode`; invalid value → exit 64 (`EX_USAGE`) with a helpful error pointing at the valid options.

---

## Observability

On every request, the orchestrator emits a `stage('mode-resolved', detail)` event as its first action (see `fallback-orchestrator.md`). `detail.mode` carries the *effective* mode for this request after the routing matrix is applied, so consumers (Web UI, CLI logs) can display the actual path taken without re-implementing the routing logic.

---

## Backwards compatibility guarantees

- The default mode `ocr-first` was chosen (clarification Q3 → Option A) specifically so that operators on the legacy LLM-only path see **no behavioural change** as long as they continue not to upload a sidecar.
- The `extractPdf(...)` function signature is unchanged. All existing tests (29 baseline) keep passing without modification (SC-006).
- `packages/contracts` is unchanged (FR-007). Web UI, CLI, and any third-party consumer that talks to `/api/extract` keep working without code changes.

---

## Failure modes

| Failure | Reaction |
|---|---|
| `EXTRACTION_MODE` env var set to an invalid value | Process exits 1 on boot via Zod schema validation. Log message identifies the invalid value and lists allowed values. |
| CLI `--mode` flag set to an invalid value | Process exits 64 with usage hint. |
| Env not set | Default `ocr-first` applied silently. |

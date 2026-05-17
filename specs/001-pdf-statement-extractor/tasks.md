# Tasks: PDF Bank Statement Extractor

**Input**: Design documents from `/specs/001-pdf-statement-extractor/`
**Prerequisites**: plan.md (required), spec.md (required for user stories), research.md, data-model.md, contracts/

**Tests**: Tests are **REQUIRED** for this feature — see constitution §V "Testing strategy" and spec §VI Acceptance Criteria ("CI зелёный: lint, typecheck, unit + integration tests"). Test tasks below are non-optional.

## 2026-05-17 amendment (constitution v1.1.0) — provider switch & multi-period

Three governed changes applied in a single commit alongside this tasks.md update:

1. **LLM provider**: `@anthropic-ai/sdk` → `openai@^4.85` (Responses API + Structured Outputs). All Anthropic-specific tasks below (those that mention `tool-use`, `claude-sonnet-4-6`, `submit_extraction` tool, `prompt-contract.md` Anthropic shape) are re-scoped to OpenAI equivalents but keep the same IDs.
2. **Multi-period**: top-level API result is `ExtractResult[]` (was: single `ExtractResult`). New schemas `extract-result-array.schema.json` and `llm-tool-input-array.schema.json` generated. NG1 in spec lifted.
3. **PDF preprocessing**: `unpdf`-based text extraction removed; `pdf-lib`-based page-range splitter added (`apps/api/src/pipeline/pdf-splitter.ts`). Reason: the production demo PDF is image-only (no text layer); OpenAI Responses API reads PDFs visually via `input_file`.

Phase 3 implementation also added two unplanned but necessary modules that aren't enumerated below by ID:

- `apps/api/src/pipeline/openai-client.ts` — OpenAI Responses API + Files API adapter with three call shapes: `indexPeriods`, `extractPeriod`, `extractTransactionRows`.
- `apps/api/src/pipeline/openai-schemas.ts` — three hand-authored JSON Schemas for Structured Outputs strict mode.
- `apps/api/src/pipeline/extract.ts` — orchestrator (indexer pass + per-period chunked extractor pass + dedup merge + per-period reconcile).
- `apps/api/scripts/extract-cli.ts` — CLI runner that exercises the full pipeline end-to-end against a local PDF.
- `apps/api/scripts/{probe-pdf,smoke-index,smoke-extract-one,smoke-extract-chunked}.ts` — diagnostic scripts (gitignored output to `/out/`).

These count as completion of the spirit of T060–T064; their tests are added as `apps/api/tests/unit/{money,reconcile}.test.ts` (20 passing assertions covering money utilities and reconciliation edge cases).

## 2026-05-17 amendment II — indexer hardening, concurrency, HTTP wiring

Three follow-up changes (no constitution bump; all preserve §I principles):

1. **Deterministic OCR-based indexer** (`apps/api/src/pipeline/ocr-indexer.ts`): when the operator supplies an OCR sidecar (RTF/TXT, multipart field `ocr_text` or CLI flag `--ocr`), the period boundaries are parsed from `Beginning Balance as of MM/DD/YYYY` / `Ending Balance as of MM/DD/YYYY` markers and mapped to absolute PDF page ranges via `Page X of Y` cover-page markers. On the Ixonia fixture this finds **exactly 10 periods** (matches the reference table) vs. 12 with the LLM-only indexer, and skips one full Files-API round-trip per chunk (~10s saved per upload).
2. **LLM indexer post-validation** (`sanitizeIndexedPeriods` in `extract.ts`): when no OCR is supplied, raw markers from the LLM indexer are filtered (drop any period whose `end_date - start_date < 3 days` — those are typically running-header false positives) and adjacent overlapping markers for the same account are merged.
3. **Transaction-window concurrency** (`apps/api/src/utils/concurrency.ts`): `extractAllTransactionsInWindows` now schedules sub-windows through `mapWithConcurrency(slices, 3, …)`. On the 99-page demo PDF this drops wall-clock from ~27 min → ~10 min.

New tests (added to `apps/api/tests/unit/`): `ocr-indexer.test.ts` (4 assertions — parsing, page mapping, edge drift), `concurrency.test.ts` (5 assertions — order preservation, max-active invariant, error propagation). Total unit-test count is now 29 passing.

HTTP surface wired (T070-ish, was previously stubbed): `POST /api/extract` accepts `multipart/form-data` (`pdf` required, `ocr_text` optional), responds with `text/event-stream` emitting `stage`, `result`, `error` frames per `packages/contracts/src/sse.ts`. Errors map to typed `ErrorBody` (`BAD_FILE` / `EXTRACTION_FAILED` / `LLM_UNAVAILABLE`).

Web UI (T065–T073 spirit): `apps/web/src/App.tsx` now drives a real upload form (drop zone + optional OCR sidecar picker), consumes the SSE stream via `features/extraction/hooks/useExtract.ts`, and renders a `PeriodCard` per `ExtractResult` (collapsible transaction table, balance reconciliation badge, per-period drift detail) plus a single "Download JSON" action that serialises the full `{ periods: ExtractResult[] }` payload.

**Organization**: Tasks are grouped by user story to enable independent implementation and testing of each story.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies on incomplete tasks)
- **[Story]**: Which user story this task belongs to (US1, US2, US3, US4)
- Include exact file paths in descriptions

## Path Conventions

Per `plan.md` "Project Structure": this is a **TypeScript monorepo** with `pnpm` workspaces. Roots:

- Backend: `apps/api/`
- Frontend: `apps/web/`
- Shared contracts: `packages/contracts/`
- Shared tsconfig: `packages/tsconfig/`

All paths below are relative to the repo root.

---

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: Initialise the monorepo, tooling, and skeleton package files. No business logic in this phase.

- [X] T001 Create monorepo directory structure (`apps/api/{src,tests}`, `apps/web/{src,tests,public}`, `packages/contracts/src`, `packages/tsconfig`, `.github/workflows/`) per `plan.md` "Project Structure" — placeholder `.gitkeep` files only
- [X] T002 Create root `package.json` with workspace scripts (`dev`, `build`, `lint`, `typecheck`, `test`, `test:e2e`) wired to `turbo run <task>`
- [X] T003 Create `pnpm-workspace.yaml` declaring `apps/*` and `packages/*`
- [X] T004 Create `turbo.json` with task pipeline: `build` (depends on `^build`, outputs `dist/**`), `lint`, `typecheck`, `test`, `dev` (no cache, persistent)
- [X] T005 [P] Create `packages/tsconfig/base.json` with `strict: true`, `noUncheckedIndexedAccess: true`, `target: ES2022`, `module: NodeNext`
- [X] T006 [P] Create `packages/tsconfig/node.json` extending `base.json` for Node 20 (`lib: ["ES2022"]`, `types: ["node"]`)
- [X] T007 [P] Create `packages/tsconfig/react.json` extending `base.json` for the SPA (`jsx: react-jsx`, `lib: ["ES2022","DOM","DOM.Iterable"]`)
- [X] T008 [P] Create `packages/tsconfig/package.json` (private, version 0.0.0)
- [X] T009 [P] Create `biome.json` at repo root with TS+TSX+JSON+Markdown formatting and lint rules; align with constitution §V code-quality requirements
- [X] T010 [P] Create `.env.example` at repo root listing `ANTHROPIC_API_KEY`, `ANTHROPIC_MODEL`, `PORT`, `CORS_ORIGIN`, `LOG_LEVEL`, `MAX_PDF_BYTES`, `MAX_OCR_BYTES`
- [X] T011 [P] Configure Husky (`.husky/pre-commit`) to run `pnpm exec lint-staged` and `pnpm typecheck`
- [X] T012 [P] Add `lint-staged` config in root `package.json` running `biome check --write` on staged `*.{ts,tsx,json,md}`
- [X] T013 [P] Update root `.gitignore` to cover `dist/`, `.turbo/`, `coverage/`, `playwright-report/`, `node_modules/`, `apps/api/tests/fixtures/*.pdf` already partially listed — verify and amend
- [X] T014 [P] Install root devDependencies: `pnpm add -Dw turbo @biomejs/biome husky lint-staged typescript@^5.4`

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: Shared infrastructure that every user story depends on — the data contract package, the API skeleton, the SPA skeleton, the prompt files, the LLM-client interface, and shared utilities. **No user-story work can begin until this phase is complete.**

### `packages/contracts` — single source of truth

- [X] T015 Initialise `packages/contracts/package.json` with name `@app/contracts`, `type: module`, build script (`tsc -p .`), `gen-schema` script, deps: `zod@^3.23`, devDeps: `zod-to-json-schema@^3.23`, `typescript@^5.4`
- [X] T016 Create `packages/contracts/tsconfig.json` extending `packages/tsconfig/node.json`, output to `dist/`
- [X] T017 [P] Implement `packages/contracts/src/schemas.ts` — Zod schemas for `AccountSchema`, `PeriodSchema`, `SummarySchema`, `ReconciliationSchema`, `SourceSpanSchema`, `TransactionSchema`, `ExtractionMetadataSchema`, `ExtractResultSchema` per `data-model.md` (no XOR refinement on `TransactionSchema` — direction rule is enforced in the pipeline per constitution v1.0.1 §IV). Also export a derived `LlmExtractionInputSchema` via `ExtractResultSchema.omit({...})` such that `summary.reconciliation` is removed and `extraction` is reduced to `{ warnings }`; this is the runtime validator for the Anthropic tool-use response (see `contracts/prompt-contract.md` "Schema source")
- [X] T018 [P] Implement `packages/contracts/src/errors.ts` exporting the `ErrorCode` union (`'BAD_FILE'|'EXTRACTION_FAILED'|'LLM_UNAVAILABLE'`) and a Zod schema for the SSE/HTTP error body
- [X] T019 [P] Implement `packages/contracts/src/sse.ts` exporting `StageName`, `StageStatus`, and Zod schemas for `StageEventDataSchema`, `ResultEventDataSchema`, `ErrorEventDataSchema`
- [X] T020 Implement `packages/contracts/src/index.ts` re-exporting all public types and schemas
- [X] T021 Implement `packages/contracts/scripts/gen-schema.ts` that converts **both** `ExtractResultSchema` and `LlmExtractionInputSchema` to JSON Schema Draft 2020-12 (via `zod-to-json-schema`) and writes `specs/001-pdf-statement-extractor/contracts/extract-result.schema.json` and `specs/001-pdf-statement-extractor/contracts/llm-tool-input.schema.json` respectively; wire `pnpm -F @app/contracts run gen-schema`
- [X] T022 [P] Add `packages/contracts/tests/schemas.test.ts` — round-trip tests: parse `data-model.md` Ixonia example, assert valid; mutate fields to invalid values, assert each produces a typed Zod issue
- [X] T023 [P] Add `packages/contracts/tests/schema-snapshot.test.ts` — runs `gen-schema` script and asserts that both committed JSON Schemas (`extract-result.schema.json` and `llm-tool-input.schema.json`) are byte-equal to the generated output (drift detector)

### `apps/api` — backend skeleton

- [X] T024 Initialise `apps/api/package.json` with name `@app/api`, scripts (`dev: tsx watch src/index.ts`, `build: tsc -p .`, `start: node dist/index.js`, `test: vitest run`, `typecheck: tsc --noEmit`), deps: `hono@^4`, `@hono/node-server`, `@anthropic-ai/sdk@^0.27`, `unpdf@^0.12`, `zod@^3.23`, `decimal.js@^10`, `pino@^9`, `pino-http@^10`, `@app/contracts: workspace:*`, devDeps: `tsx`, `vitest@^2`, `@types/node`
- [X] T025 Create `apps/api/tsconfig.json` extending `packages/tsconfig/node.json`, references `packages/contracts`
- [X] T026 Implement `apps/api/src/config.ts` — Zod-validated env (per `research.md` R-16); exported typed `config` object; throws at boot on missing/invalid vars
- [X] T027 [P] Implement `apps/api/src/utils/logger.ts` — `pino` instance with redact paths (`req.headers.authorization`, env keys, `req.body`); default level from `config.LOG_LEVEL`
- [X] T028 [P] Implement `apps/api/src/utils/money.ts` — `decimal.js` helpers: `toDecimal(string|number)`, `sumDecimals(values: Decimal[])`, `withinTolerance(a, b, eps='0.01')`; set `Decimal.set({ precision: 28, rounding: Decimal.ROUND_HALF_EVEN })` once
- [X] T029 [P] Implement `apps/api/src/utils/mime.ts` — magic-byte sniffing: `isPdfBuffer(buf)` checks leading `%PDF-`; `isUtf8Text(buf)` heuristic; export `MimeMismatchError`
- [X] T030 [P] Implement `apps/api/src/domain/errors.ts` — typed exceptions `BadFileError`, `ExtractionFailedError`, `LlmUnavailableError`; each carries the matching `ErrorCode` and a user-facing message
- [X] T031 [P] Implement `apps/api/src/domain/types.ts` — re-export contract types from `@app/contracts` for ergonomic internal imports
- [X] T032 Implement `apps/api/src/pipeline/llm-client.ts` — interface `LlmClient { extract(text: string, opts: ExtractOptions): Promise<unknown> }`; expose factory `createAnthropicClient(config)`; **do not implement the body yet** — leave a `throw new Error('not yet implemented')` stub. (Implementation is in Phase 3.)
- [X] T033 Implement `apps/api/src/pipeline/stage-emitter.ts` — helper class that encapsulates SSE writes (`emitStage`, `emitResult`, `emitError`) given a `Response` writer; serialises per the grammar in `contracts/sse-events.md`
- [X] T034 Implement `apps/api/src/index.ts` — Hono app bootstrap: load `config`, attach `pino-http`, register CORS middleware limited to `config.CORS_ORIGIN`, mount `/api/health` route inline returning `{ ok: true, version }`
- [X] T035 [P] Create `apps/api/src/prompts/system.md` with frontmatter `prompt_version: v1.0.0, purpose: system` and the 7 invariants from `contracts/prompt-contract.md`
- [X] T036 [P] Create `apps/api/src/prompts/extraction.md` with frontmatter `prompt_version: v1.0.0, purpose: extraction` and bank-agnostic field-by-field guidance per `contracts/prompt-contract.md`
- [X] T037 [P] Create `apps/api/src/prompts/examples/ixonia.md` — compact few-shot (header + 2-3 representative transactions) anchored to the Ixonia fixture
- [X] T038 Add `apps/api/Dockerfile` — multi-stage build (deps → build → runtime); runtime image is `node:20-alpine`; non-root user; exposes `${PORT:-8080}`

### `apps/web` — frontend skeleton

- [X] T039 Initialise `apps/web/package.json` with name `@app/web`, scripts (`dev: vite`, `build: tsc -p . && vite build`, `preview: vite preview`, `test: vitest run`, `test:e2e: playwright test`, `typecheck: tsc --noEmit`), deps: `react@^18`, `react-dom@^18`, `@tanstack/react-query@^5`, `@tanstack/react-table@^8`, `react-dropzone@^14`, `lucide-react`, `@radix-ui/react-slot`, `class-variance-authority`, `clsx`, `tailwind-merge`, `@app/contracts: workspace:*`, devDeps: `vite@^5`, `@vitejs/plugin-react`, `tailwindcss@^3`, `postcss`, `autoprefixer`, `vitest@^2`, `@testing-library/react`, `@testing-library/jest-dom`, `@playwright/test@^1.46`, `jsdom`
- [X] T040 Create `apps/web/tsconfig.json` extending `packages/tsconfig/react.json`; references `packages/contracts`
- [X] T041 Create `apps/web/vite.config.ts` — React plugin, dev-server proxy `/api → http://localhost:8080`, build size check that fails if initial JS chunk > 250 KB gzipped (NFR-3)
- [X] T042 [P] Configure Tailwind: `apps/web/tailwind.config.ts`, `postcss.config.cjs`, `src/styles/globals.css` with `@tailwind base/components/utilities`
- [X] T043 [P] Initialise shadcn/ui — copy required primitives (`button`, `card`, `badge`, `input`, `table`, `dialog`, `alert`) into `apps/web/src/shared/ui/`
- [X] T044 Implement `apps/web/src/main.tsx` (mount with `QueryClientProvider`) and `apps/web/src/App.tsx` (skeleton route shell)
- [X] T045 Implement `apps/web/src/shared/api/sse.ts` — minimal SSE parser per `contracts/sse-events.md` "Client parsing"; exports `async function* readSse(res): AsyncGenerator<AnyEvent>` and validates each `data:` payload through `@app/contracts` Zod schemas
- [X] T046 [P] Implement `apps/web/src/shared/api/client.ts` — `fetch` wrapper that builds `multipart/form-data`, attaches an `AbortController`, returns the raw `Response` (the SSE generator consumes it)
- [X] T047 [P] Implement `apps/web/src/shared/lib/format.ts` — `formatMoney(value, currency='USD')` (thousands separator, 2 dp), `formatDate(iso)` (`Apr 1, 2025`), `formatPeriod(start,end)` (`Apr 1 – Apr 30, 2025`), `maskAccount(last4)` (`••••<last4>`); FR-021
- [X] T048 [P] Implement `apps/web/src/shared/lib/download.ts` — `downloadJsonFile(filename, payload)` (Blob + temporary `a` element)
- [X] T049 Create `apps/web/playwright.config.ts` — runs against `vite preview` on port 4173, headless Chromium only, retries=1 on CI

### `packages/contracts` JSON Schema sync gate

- [X] T050 Add a CI step (in advance, as a script) `packages/contracts/scripts/check-schema.sh` that runs `gen-schema` and `git diff --exit-code` on `specs/001-pdf-statement-extractor/contracts/extract-result.schema.json`; wire via root `pnpm check:schema`

**Checkpoint**: Foundation ready — user story implementation can now begin. Phase 2 leaves the project in a "everything compiles, nothing extracts" state; `pnpm dev` should start both apps and `GET /api/health` should respond.

---

## Phase 3: User Story 1 — Extract a single-period statement (Priority: P1) 🎯 MVP

**Goal**: A user drops a PDF (optionally + OCR text), clicks Extract, and within 20 seconds sees Account card, Summary card, Transactions table, and can Copy/Download a valid JSON result. (This phase does **not** yet enforce reconciliation correctness — `summary.reconciliation` is filled with a placeholder; US2 makes it real.)

**Tasks**: T051–T073 (23 main tasks) + T111, T112 (2 added during post-analyze remediation: no-disk-persistence, log-sanitization tests)

**Independent Test**: Per spec §AC-1 (without the reconciliation badge assertion): upload `apps/api/tests/fixtures/ixonia.{pdf,ocr.txt}`, observe Account, Summary (six values), 192-row table, Copy JSON produces a payload that validates against `extract-result.schema.json`.

### Tests for User Story 1 (REQUIRED)

- [ ] T051 [P] [US1] Add `apps/api/tests/unit/money.test.ts` — covers `toDecimal`, `sumDecimals`, `withinTolerance`; strings vs. numbers, half-cent edge cases, banker's rounding
- [ ] T052 [P] [US1] Add `apps/api/tests/unit/mime.test.ts` — magic-byte detection: real PDF buffer (passes), PNG bytes (fails), text-only buffer (fails)
- [ ] T053 [P] [US1] Add `apps/api/tests/fixtures/ixonia.pdf` and `apps/api/tests/fixtures/ixonia.ocr.txt` (provided assets)
- [ ] T054 [P] [US1] Add `apps/api/tests/fixtures/ixonia.expected.json` matching spec §AC-1 (192 transactions; placeholder `reconciliation.ok: true, delta: 0`)
- [ ] T055 [P] [US1] Add `apps/api/tests/fixtures/llm-responses/ixonia.tool-input.json` — a recorded Anthropic tool-use input that, after pipeline post-processing, equals `ixonia.expected.json`
- [ ] T056 [P] [US1] Add `apps/api/tests/integration/extract-happy-path.test.ts` — uses a fake `LlmClient` returning the recorded response; runs the full pipeline against `ixonia.pdf` + OCR; asserts the result deep-equals `ixonia.expected.json` and validates with `ExtractResultSchema`
- [ ] T057 [P] [US1] Add `apps/web/tests/unit/format.test.ts` — `formatMoney`, `formatDate`, `formatPeriod`, `maskAccount` covering FR-021 examples
- [ ] T058 [P] [US1] Add `apps/web/tests/unit/sse.test.ts` — `readSse` correctly parses a fixed event stream (stage→stage→…→result), rejects unknown events, validates payload Zod
- [ ] T059 [US1] Add `apps/web/tests/e2e/extract-ixonia.spec.ts` Playwright smoke — boot `vite preview` + a `wiremock`-style fake API (serves SSE from the recorded fixture); drop the fixture, click Extract, assert Account text, six summary numbers, 192 rows, then click Download JSON and assert the file parses against `extract-result.schema.json`
- [ ] T111 [P] [US1] Add `apps/api/tests/integration/no-disk-persistence.test.ts` — stubs `fs.writeFile` / `fs.writeFileSync` / `fs.createWriteStream` / `fs.promises.writeFile` to throw if invoked during request handling; runs the Ixonia integration fixture through `/api/extract` with a fake LLM; asserts the response completes successfully and **none** of the stubbed functions were called (FR-028 / NFR-9)
- [ ] T112 [P] [US1] Add `apps/api/tests/integration/log-sanitization.test.ts` — installs a pino transport that captures every emitted log object into an array; runs the Ixonia integration fixture; asserts that no captured log line contains either a 32-character substring of the OCR text or a substring of the masked Anthropic API key (FR-030 / NFR-13 / FR-031). Use a distinctive marker string in the test fixture so the search is reliable.

### Implementation for User Story 1

- [ ] T060 [US1] Implement `apps/api/src/pipeline/preprocess.ts` — if OCR `Buffer` provided, decode as UTF-8 and return as `{ text, mode: 'ocr' }`; else run `unpdf` over the PDF buffer, concatenate per-page text with `\n`, return `{ text, mode: 'pdf', pageOffsets }` where `pageOffsets[i]` is the character offset where page `i+1` starts (used later by the LLM via `source_span`)
- [ ] T061 [P] [US1] Implement `apps/api/src/pipeline/chunk.ts` — for now a pass-through (`return [text]`) because Sonnet 4.6 context window suffices for 10-page statements; export the function so the orchestrator can call it without conditionals (matches `plan.md` data flow)
- [ ] T062 [US1] Implement `apps/api/src/pipeline/llm-client.ts` real Anthropic body per `contracts/prompt-contract.md`: load the three prompt files, build `messages`, call `client.messages.create` with forced tool-use against the JSON Schema imported from `specs/001-pdf-statement-extractor/contracts/llm-tool-input.schema.json` (the LLM-input variant, which omits `summary.reconciliation`); return `tool_use.input` as `unknown`; map 5xx/429/timeout/abort to `LlmUnavailableError`, malformed tool use to `ExtractionFailedError`
- [ ] T063 [US1] Implement `apps/api/src/pipeline/extract.ts` orchestrator — sequence: `preprocess → chunk → llm-client.extract → Zod parse against LlmExtractionInputSchema → enrich (server-set model/prompt_version/duration_ms; append warnings from LLM input) → placeholder-reconcile → validate full result against ExtractResultSchema`. On Zod failure, retry the LLM call **once** with the corrective `user` turn from `contracts/prompt-contract.md`; on second failure throw `ExtractionFailedError`. Reconciliation is a stub here: copies `expected_ending = ending_balance`, `delta = 0`, `ok = true`. (Real reconciliation lands in US2.)
- [ ] T064 [US1] Implement `apps/api/src/routes/extract.ts` — `POST /api/extract` handler: parse multipart (Hono built-in), validate sizes & magic bytes (raise `BadFileError → BAD_FILE` SSE), set `text/event-stream` headers, instantiate `stage-emitter`, call orchestrator, emit `stage` events at each boundary, then `result` (or `error`); honour `req.signal` for cancellation
- [ ] T065 [US1] Wire `extract` route in `apps/api/src/index.ts`; ensure `/api/health` already works (set in T034)
- [ ] T066 [US1] Implement `apps/web/src/features/extraction/api/useExtract.ts` — TanStack Query `useMutation` that calls `client.postExtract(formData)` and yields the SSE stream into a callback (`onStage`, `onResult`, `onError`); returns `mutate(file, ocr?)`
- [ ] T067 [P] [US1] Implement `apps/web/src/features/extraction/components/FileDropzone.tsx` — `react-dropzone` accepting one `application/pdf` (required) and one `text/plain` (optional); client-side MIME + size validation per FR-001..FR-005; shows name+size+Remove button
- [ ] T068 [P] [US1] Implement `apps/web/src/features/extraction/components/AccountCard.tsx` — bank, `maskAccount`, `formatPeriod`
- [ ] T069 [P] [US1] Implement `apps/web/src/features/extraction/components/SummaryCard.tsx` — six values via `formatMoney`; renders a neutral placeholder badge area (will be replaced by `ReconciliationBanner`/badge in US2)
- [ ] T070 [P] [US1] Implement `apps/web/src/features/extraction/components/TransactionsTable.tsx` — TanStack Table with columns Date / Description / Deposit / Withdrawal; client-side sorting (default date asc) and search-input filtering by description (FR-022); deposit green / withdrawal red (FR-021); empty-state row (FR-025)
- [ ] T071 [P] [US1] Implement `apps/web/src/features/extraction/components/ResultActions.tsx` — Copy JSON button (uses `navigator.clipboard.writeText`) and Download JSON button (`downloadJsonFile`) producing `<bank>_<period>.json` (FR-023)
- [ ] T072 [US1] Wire it all up in `apps/web/src/App.tsx` — top-level layout: dropzone → on result, hide dropzone and render `AccountCard + SummaryCard + ResultActions + TransactionsTable`
- [ ] T073 [US1] Add `apps/web/index.html` `<title>` and meta description; favicon placeholder

**Checkpoint**: User Story 1 is independently demonstrable. The Ixonia happy-path end-to-end test (T056 + T059) passes. Reconciliation badge content is a placeholder; mismatch banner does not yet appear. MVP demo capability achieved.

---

## Phase 4: User Story 2 — Surface reconciliation mismatches (Priority: P1)

**Goal**: After US1, reconciliation must become real: a deterministic decimal check on the server, a clear green/red badge in the summary card, and a prominent red banner above the transactions table when totals don't tie within $0.01.

**Independent Test**: Per spec §AC-3: upload an intentionally-mistuned Ixonia fixture (totals off by $2.00); the banner appears with `delta = $2.00` and a correctly-formatted explanation; `summary.reconciliation.ok` is `false` in the downloaded JSON; HTTP status remains 200 throughout.

### Tests for User Story 2 (REQUIRED)

- [ ] T074 [P] [US2] Add `apps/api/tests/unit/reconcile.test.ts` — covers: identical sums (ok=true, delta=0), $0.005 jitter (ok=true), $0.02 mismatch (ok=false, delta sign), large statements (1000 transactions, no precision loss), empty transaction list (ok=true ⟺ beginning=ending)
- [ ] T075 [P] [US2] Add `apps/api/tests/fixtures/ixonia-mismatch.expected.json` — same as `ixonia.expected.json` but `summary.ending_balance` increased by 2.00 and `reconciliation: { ok: false, delta: 2.00, expected_ending: 509121.59 }`
- [ ] T076 [P] [US2] Add `apps/api/tests/fixtures/llm-responses/ixonia-mismatch.tool-input.json` — recorded LLM input where `ending_balance` is the tampered value but the transaction array is unchanged (the server-side reconciler detects the mismatch)
- [ ] T077 [P] [US2] Add `apps/api/tests/integration/extract-mismatch.test.ts` — fake LLM returns the mismatch fixture; asserts pipeline yields `summary.reconciliation.ok === false` with the correct delta and the HTTP-level response remained a `result` event (no `error`)
- [ ] T078 [P] [US2] Add `apps/api/tests/integration/extract-warnings.test.ts` — fake LLM returns a payload where `transactions.deposit` counts mismatch `summary.deposits_count`; asserts a `count-mismatch:` warning is appended to `extraction.warnings[]`
- [ ] T079 [P] [US2] Add `apps/web/tests/unit/ReconciliationBanner.test.tsx` — renders nothing when `ok=true`; renders banner with formatted `delta`, `expected_ending`, and `ending_balance` when `ok=false`; snapshot only this component (allowed per constitution §V testing strategy — deterministic formatter)

### Implementation for User Story 2

- [ ] T080 [US2] Implement `apps/api/src/pipeline/reconcile.ts` — pure function `reconcile(summary, transactions) → Reconciliation`; uses `decimal.js` per `research.md` R-8; returns `{ ok, delta, expected_ending }`; **does not mutate inputs**
- [ ] T081 [US2] Implement post-LLM consistency checks in `apps/api/src/pipeline/extract.ts` — replace the placeholder reconciliation from T063 with a real call to `reconcile()`; also compute `Σdeposits ≈ deposits_total`, `Σwithdrawals ≈ withdrawals_total`, counts, and ambiguous-row direction check (R-6); each divergence appends an entry to `extraction.warnings[]` with the prefixes `count-mismatch:` / `total-mismatch:` / `ambiguous-direction:`; surface but do not throw
- [ ] T082 [P] [US2] Implement `apps/web/src/features/extraction/components/ReconciliationBanner.tsx` — renders only when `summary.reconciliation.ok === false`; shows expected vs. actual ending and the signed delta using `formatMoney`; uses the red `Alert` shadcn primitive
- [ ] T083 [US2] Update `apps/web/src/features/extraction/components/SummaryCard.tsx` — replace the placeholder badge with `ReconciledBadge` (green check or red cross) bound to `summary.reconciliation.ok`
- [ ] T084 [US2] Insert `ReconciliationBanner` above `TransactionsTable` in `apps/web/src/App.tsx` (only when the result exists and `ok` is false)

**Checkpoint**: Both P1 stories are independently functional. The Ixonia happy-path (US1) still passes; the mismatch path (US2) is a separate green test. The product is now demoable end-to-end with the trust-in-numbers guarantee from spec §AC-1 and §AC-3.

---

## Phase 5: User Story 3 — Cross-bank generalisation (Priority: P2)

**Goal**: Demonstrate that adding a new bank requires **no code changes** — only an additional prompt example file plus a fixture and an integration test. This phase exists primarily to prove the constraint and to add **two** unseen-bank fixtures (per spec §AC-2 / §SC-002 / §AC-5) so that CI catches regressions to generalisation and the README accuracy table covers three banks.

**Tasks**: T085–T092 (8 main tasks) + T113, T114, T115 (3 added during post-analyze remediation for the second unseen bank)

**Independent Test**: Per spec §AC-2: process **both** unseen-bank fixtures; ≥ 90 % of summary fields match the human-prepared references; reconciliation passes (or correctly reports a delta) for each.

### Tests for User Story 3 (REQUIRED)

- [ ] T085 [P] [US3] Add `apps/api/tests/fixtures/unseen-bank-1.pdf` and (optional) `apps/api/tests/fixtures/unseen-bank-1.ocr.txt` (provided assets)
- [ ] T086 [P] [US3] Add `apps/api/tests/fixtures/unseen-bank-1.expected.json` — human-curated reference for the second bank
- [ ] T087 [P] [US3] Add `apps/api/tests/fixtures/llm-responses/unseen-bank-1.tool-input.json` — recorded Anthropic tool-use input for this fixture
- [ ] T113 [P] [US3] Add `apps/api/tests/fixtures/unseen-bank-2.pdf` and (optional) `apps/api/tests/fixtures/unseen-bank-2.ocr.txt` (provided assets — second unseen bank required by spec §AC-2 / §SC-002 / §AC-5)
- [ ] T114 [P] [US3] Add `apps/api/tests/fixtures/unseen-bank-2.expected.json` — human-curated reference for the third bank in the test corpus
- [ ] T115 [P] [US3] Add `apps/api/tests/fixtures/llm-responses/unseen-bank-2.tool-input.json` — recorded Anthropic tool-use input for this fixture
- [ ] T088 [P] [US3] Add `apps/api/tests/integration/extract-unseen-bank.test.ts` — runs the pipeline against **both** unseen-bank-1 and unseen-bank-2 (parameterised); asserts ≥ 90 % field-by-field match against the reference summary and correct reconciliation behaviour for each

### Implementation for User Story 3

- [ ] T089 [US3] Add `apps/api/src/prompts/examples/generic.md` — neutral, fictional bank few-shot designed to prevent over-fitting to Ixonia conventions
- [ ] T090 [US3] Update `apps/api/src/prompts/extraction.md` to register the new few-shot example; bump `prompt_version` frontmatter from `v1.0.0` to `v1.1.0`
- [ ] T091 [US3] Add a "Adding a new bank" smoke check `apps/api/tests/integration/no-bank-specific-code.test.ts` — uses static analysis (`fs` walk over `apps/api/src/pipeline/`) and asserts that no `pipeline/*.ts` file contains the strings `"Ixonia"`, `"Unseen Bank 1"`, or the masked account number; constitution §III gate at the test level
- [ ] T092 [US3] Update `quickstart.md` "Adding support for a new bank" section to reference `generic.md` as the canonical second example (sanity, not procedure change)

**Checkpoint**: US3 has shipped. CI verifies bank-agnostic code paths. Two banks in the test corpus.

---

## Phase 6: User Story 4 — Real-time progress and actionable errors (Priority: P3)

**Goal**: Replace the basic loading state from US1 with the four-stage progress UI (FR-017..FR-019) and the typed error-handling UX (FR-026, FR-027). The pipeline already emits SSE `stage` events; this phase makes them visible and adds error mapping to friendly copy on the client.

**Independent Test**: Throttle the network (or use a slow recorded LLM response) and verify all four stages render `pending → active → done`; upload a corrupt PDF and verify `BAD_FILE` is shown without any stack trace; disconnect mid-extraction and verify a "Try again" path.

### Tests for User Story 4 (REQUIRED)

- [ ] T093 [P] [US4] Add `apps/api/tests/integration/sse-ordering.test.ts` — drives the SSE endpoint with a slow fake LLM (50 ms artificial delay per stage); asserts the exact event sequence and that `result` is terminal
- [ ] T094 [P] [US4] Add `apps/api/tests/integration/sse-cancellation.test.ts` — client aborts after `extract: active`; assert the server stops the upstream call and emits no further events
- [ ] T095 [P] [US4] Add `apps/web/tests/unit/ProgressStages.test.tsx` — renders four stage rows; transitions states on incoming `stage` events; shows "still working…" after 5 simulated seconds in `active`
- [ ] T096 [P] [US4] Add `apps/web/tests/unit/errorMapping.test.ts` — `mapErrorCodeToCopy(code)` returns the strings mandated by FR-026 verbatim, and `Try again` is shown for retriable codes only

### Implementation for User Story 4

- [ ] T097 [P] [US4] Implement `apps/web/src/features/extraction/components/ProgressStages.tsx` — four rows (Upload / Parse PDF / Extract with AI / Reconcile), three states each, controlled by props from `useExtract`; 5-second `setTimeout` per active row triggers the "still working…" annotation
- [ ] T098 [P] [US4] Implement `apps/web/src/features/extraction/lib/errorCopy.ts` — `errorCopy: Record<ErrorCode | 'NETWORK' | 'UNKNOWN', { title, detail, retriable }>` per FR-026
- [ ] T099 [US4] Update `apps/web/src/features/extraction/api/useExtract.ts` to surface stage transitions to the consumer (component state shape: `{ stages: Record<StageName, StageStatus>, result?, error? }`)
- [ ] T100 [US4] Update `apps/web/src/App.tsx` to render `ProgressStages` while in-flight and an inline alert with `Try again` on error states (uses `errorCopy`)
- [ ] T101 [P] [US4] Audit and update API error pathways in `apps/api/src/routes/extract.ts` to guarantee FR-027: no error response or SSE event contains `err.stack`, internal codes, model names, or library names — verified by a dedicated assertion in T093/T094

**Checkpoint**: All four user stories are independently functional. The product matches the demo spec end-to-end including progress UX and friendly error states.

---

## Phase 7: Polish & Cross-Cutting Concerns

**Purpose**: Wrap-up items that affect multiple stories and the demo deliverables.

**Tasks**: T102–T110 (9 main tasks) + T117 (latency-budget tripwire added during post-analyze remediation)

- [ ] T102 Create `.github/workflows/ci.yml` running `pnpm install --frozen-lockfile` then `turbo run lint typecheck test build` and `pnpm check:schema`; cache `~/.local/share/pnpm/store` and `.turbo` keyed on the lockfile hash; fail the build if the frontend gzipped initial bundle exceeds 250 KB (NFR-3, T041)
- [ ] T103 Add `.github/workflows/e2e.yml` — separate job running `pnpm build` + `pnpm test:e2e`; uploads `playwright-report/` on failure
- [ ] T104 Update repo-root `README.md` per spec §AC-5: replace the current placeholder with: architecture diagram (text) lifted from `plan.md`, run commands from `quickstart.md`, self-reported accuracy table covering **all three banks** (Ixonia + unseen-bank-1 + unseen-bank-2), and a "Known weaknesses" section that explicitly lists deferred items (no rate limiting per R-9, no per-row running balance per R-5, no multi-period support per spec, etc.)
- [ ] T105 [P] Add a `docs/demo-script.md` 30-minute walkthrough per constitution §VI (Ixonia happy path → mismatch case → unseen-bank generalisation → error handling)
- [ ] T106 [P] Add `apps/api/src/utils/perf.ts` helper to measure stage durations and log them at info level; ensure the `extraction.duration_ms` value is end-to-end and matches the wall-clock budget in NFR-1
- [ ] T117 [P] Add `apps/api/tests/integration/latency-budget.test.ts` — with the deterministic fake `LlmClient` returning the Ixonia recorded response, run the orchestrator end-to-end and assert wall-clock duration is below a generous synthetic budget (≤ 500 ms). Acts as a CI tripwire for accidental quadratic regressions in PDF parsing / Zod validation; **not** a substitute for the real-LLM SC-004 measurement (still tracked manually in T108)
- [ ] T107 Verify that `.specify/memory/constitution.md` is at version `1.0.1` (the §IV `TransactionSchema` PATCH that legalises the relaxed Zod schema landed during the post-`/speckit-analyze` remediation, before any implementation began); fail CI if the version line drops back to `1.0.0`
- [ ] T108 [P] Run a manual `pnpm preview` smoke against a real Anthropic key and confirm SC-001 / SC-003 / SC-005 hold; record results in `README.md` accuracy table (T104)
- [ ] T109 [P] Verify `quickstart.md` is accurate end-to-end by following it from a fresh clone on a clean machine; fix any drift
- [ ] T110 Final lint/typecheck/test pass on the merge-target branch and ensure `pnpm check:schema` is clean

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: No dependencies — can start immediately.
- **Foundational (Phase 2)**: Depends on Setup completion. **Blocks all user stories.**
- **User Stories (Phase 3..6)**: All depend on Foundational completion.
  - **US1 (P1, Phase 3)** is the MVP and must complete before US2 because US2 replaces the placeholder reconciliation introduced in US1's `pipeline/extract.ts` (T063 ← T081).
  - **US2 (P1, Phase 4)** depends on US1's pipeline shape; cannot start until T063 lands.
  - **US3 (P2, Phase 5)** depends on the prompt/fixture infrastructure from Phase 2 + the working pipeline from US1. It does **not** require US2 logically (an unseen-bank statement can be validated even with placeholder reconciliation), but for CI cleanliness we sequence it after US2 so that all integration tests share the real reconciler.
  - **US4 (P3, Phase 6)** depends on the SSE plumbing from Phase 2 (T033) and the orchestrator from US1 (T063). It can technically begin in parallel with US3 if staffed separately.
- **Polish (Phase 7)**: Depends on all desired user stories being complete.

### User Story Dependencies

- **US1 → US2**: T081 replaces T063's reconciliation stub. Must be sequenced.
- **US1 → US3**: US3 uses the same pipeline; only adds prompts and fixtures. Independent test still applies (the unseen-bank fixture can run against the in-MVP pipeline once US2 has finalised the reconciler).
- **US1 → US4**: US4 consumes SSE events emitted by the orchestrator. Independent of US2/US3 logic.
- **US2 vs. US3**: independent.
- **US2 vs. US4**: independent.
- **US3 vs. US4**: independent.

### Within Each User Story

- Tests are written first (per spec §VI testing strategy) — the integration test for US1 (T056) is written against the **interface** of the orchestrator T063; it is expected to fail until T060–T065 land, then go green.
- Models / shared schemas (Phase 2) → services / pipeline (Phase 3–6) → routes / UI components → integration → e2e.
- Each story finishes with a checkpoint where its independent test must pass without help from later stories.

### Parallel Opportunities

- **Setup**: T005–T014 are all [P] — independent files.
- **Foundational**: within Phase 2, three islands run in parallel:
  - `packages/contracts` (T015–T023): one developer can take the whole package.
  - `apps/api` skeleton (T024–T038): another developer.
  - `apps/web` skeleton (T039–T049): a third.
- **US1**: all tests T051–T058 are [P]; the `apps/web` components T067–T071 are [P]; the integration test T056 and the route T064 must be sequenced after T060–T063 (same files / dependency chain).
- **US2**: T074–T079 tests are [P]; T080 (reconcile.ts, pure) is [P] with the UI component T082; T081 must sequence after T080.
- **US3**: T085–T088 are [P]; T089–T091 are [P] (different files).
- **US4**: T093–T096 are [P]; T097–T098 are [P] with each other; T099/T100 sequence after.
- Across stories: once Foundational lands, three developers can take US1, US3, US4 in parallel; US2 waits for US1's T063.

---

## Parallel Example: User Story 1

```bash
# Phase 3 — kick off all parallelisable test tasks at once:
Task: "Add apps/api/tests/unit/money.test.ts (T051)"
Task: "Add apps/api/tests/unit/mime.test.ts (T052)"
Task: "Add apps/web/tests/unit/format.test.ts (T057)"
Task: "Add apps/web/tests/unit/sse.test.ts (T058)"

# Once the orchestrator (T063) lands, kick off all UI components in parallel:
Task: "Implement FileDropzone.tsx (T067)"
Task: "Implement AccountCard.tsx (T068)"
Task: "Implement SummaryCard.tsx (T069)"
Task: "Implement TransactionsTable.tsx (T070)"
Task: "Implement ResultActions.tsx (T071)"
```

---

## Implementation Strategy

### MVP First (Phase 1 + Phase 2 + Phase 3)

1. Complete Phase 1 (Setup) — `pnpm install`, `pnpm typecheck` green on empty packages.
2. Complete Phase 2 (Foundational) — `pnpm typecheck` green, `pnpm test -F @app/contracts` green, `/api/health` answers, blank SPA renders.
3. Complete Phase 3 (US1) — integration test T056 green, e2e T059 green.
4. **STOP & VALIDATE**: live-demo Ixonia happy path end-to-end (without the reconciliation badge story).
5. The product is demoable at this point as a minimal but honest extractor.

### Incremental Delivery

1. MVP shipped (Phase 3) → demo Ixonia (US1 acceptance).
2. Phase 4 → reconciliation banner; the mismatch demo (§AC-3) becomes possible.
3. Phase 5 → demonstrate cross-bank generalisation (§AC-2) and the no-bank-specific-code CI gate.
4. Phase 6 → polished progress UX and error states (§AC-4).
5. Phase 7 → README, CI, Docker, constitution amendment, demo script.

### Parallel Team Strategy

With three developers:

1. Together: Phase 1 + Phase 2 (foundational packages and skeletons).
2. After Phase 2 checkpoint:
   - Dev A: US1 (Phase 3) → then takes the lead on US2 (Phase 4) because of the pipeline coupling.
   - Dev B: US3 (Phase 5) once US1's orchestrator (T063) is in.
   - Dev C: US4 (Phase 6) once US1's SSE wiring (T064) is in.
3. Together: Phase 7 (CI, README, polish).

---

## Notes

- `[P]` tasks = different files, no dependency on still-incomplete tasks in the same story.
- `[Story]` label maps the task to the user story for traceability; Setup, Foundational, and Polish tasks carry no story label.
- Each user story should be independently completable and testable at its checkpoint.
- Verify tests fail before implementing the corresponding code (the recorded-LLM-response fixtures make this possible without spending Anthropic credits in CI).
- Commit after each task or after a tight logical group of [P] siblings.
- Stop at any checkpoint to validate the story independently.
- Avoid: vague tasks, same-file conflicts inside a [P] cluster, cross-story dependencies that break independence.

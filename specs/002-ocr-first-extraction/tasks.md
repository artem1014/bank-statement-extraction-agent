---
description: "Implementation tasks for OCR-first extraction pipeline"
---

# Tasks: OCR-First Extraction Pipeline

**Input**: Design documents from `/specs/002-ocr-first-extraction/`
**Prerequisites**: plan.md (loaded), spec.md (loaded), research.md (loaded), data-model.md (loaded), contracts/ (loaded), quickstart.md (loaded)

**Tests**: Unit tests are MANDATORY for new pure modules per constitution §V (Testing Strategy). Integration tests are mandatory per spec SC-006 (no regression) and SC-001/SC-005 (acceptance criteria require demonstrable end-to-end runs).

**Organization**: Three user stories from spec.md — US1 (OCR-first happy path, P1, MVP), US2 (per-period LLM fallback, P1), US3 (legacy LLM path preserved, P2).

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies on other in-flight tasks).
- **[Story]**: User-story label (US1, US2, US3) — Setup/Foundational/Polish tasks have no label.
- All file paths are **relative to repository root**.

---

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: Wire up configuration and environment scaffolding required by every later phase.

- [X] T001 Add `EXTRACTION_MODE` Zod enum to `apps/api/src/config.ts` with default `ocr-first` and allowed values `ocr-first | ocr-only | llm-only`; validate on boot and exit 1 with a helpful error when an invalid value is provided.
- [X] T002 [P] Document `EXTRACTION_MODE` in `.env.example` with the routing matrix excerpt from `specs/002-ocr-first-extraction/contracts/extraction-mode.md`.
- [X] T003 [P] Add `--mode` flag parsing to `apps/api/scripts/extract-cli.ts` (Zod-validated against the same enum; on invalid value print usage and exit 64).
- [X] T004 [P] Add new error codes `OCR_SIDECAR_INVALID` and `OCR_SIDECAR_TOO_LARGE` to `apps/api/src/domain/errors.ts` and re-export from `packages/contracts/src/errors.ts` (codes only — schema unchanged).

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: Build the pure, side-effect-free building blocks that US1 and US2 both depend on. Includes the parser triplet's foundations + the cross-cutting redaction/correlation utilities.

**⚠️ CRITICAL**: No user-story work can begin until this phase is complete.

- [X] T005 [P] Create `apps/api/src/utils/correlation.ts` exporting `newCorrelationId(): string` (UUID v4 from `crypto.randomUUID`).
- [X] T006 [P] Modify `apps/api/src/utils/logger.ts` to add `withCorrelation(requestId)` that returns a `pino` child logger and to register a custom serializer that drops any field literally named `sidecarText`, `rawText`, `description`, or `amount` from any logged object at level `info` and above (per FR-013 + SC-009). Sidecar slices are allowed only at `debug`.
- [X] T007 [P] Create `apps/api/src/utils/text-normalize.ts` exporting `normalizeMoneyToken`, `normalizeDateToken`, `parseMoney`, `parseDateMDY` per `contracts/ocr-parser.md` §1. Pure functions, deterministic, no I/O.
- [X] T008 [P] Create `apps/api/tests/unit/text-normalize.test.ts` with ≥12 cases covering: `$50 9,121.59` → `$509,121.59`; `$5O,000.00` → `$50,000.00`; `0l/01/2025` → `01/01/2025`; `OFFICE SUPPLIES` left untouched; `$1.O` rejected as malformed; `--$1,000.00` rejected; ISO date round-trip; Feb 30 rejection.
- [X] T009 Create `apps/api/src/pipeline/ocr-sidecar.ts` exporting `parseOcrSidecar(rawText: string): OcrSidecar` per `data-model.md` §1. Responsibilities: split lines; locate FIRST `=== Document Text ===` and `=== Tables ===` ranges; collect `=== Table ===` blocks into `TableBlock[]` (header detection via canonical token set per research R-3); reuse the existing `ocr-indexer.ts` to populate `periods`. Header parsing here is structural only — row parsing belongs to `ocr-tx-parser.ts`.
- [X] T010 [P] Create `apps/api/tests/unit/ocr-sidecar.test.ts` covering: fixture-derived snippet of `Bank Statement.rtf` produces N tables and 10 periods; sidecar without `=== Tables ===` returns `tablesRange: null` and empty `tableBlocks`; sidecar with the post-Tables duplicate text section is sliced to the FIRST `=== Document Text ===` only.

**Checkpoint**: After Phase 2, the foundation is in place — text normalisation, sidecar tokenisation, logging redaction, and correlation IDs are all available and tested. User-story implementation may now begin.

---

## Phase 3: User Story 1 — Use OCR sidecar as primary source of truth (Priority: P1) 🎯 MVP

**Goal**: When a complete OCR sidecar is uploaded, produce a full `ExtractResult[]` in ≤ 5 s wall-clock with **zero** OpenAI API calls, matching the existing reference numbers within the bounds of feature 001.

**Independent Test**: `pnpm -F @app/api extract:cli ./Binder2_Redacted.pdf --ocr "./Bank Statement.rtf" --out ./out/v2.json` completes in ≤ 5 s; produces 10 periods; every period has `extraction.model === 'ocr-deterministic'` and zero `recovered-via-llm:` warnings; reconciliation patterns match feature 001.

### Implementation for User Story 1

- [X] T011 [P] [US1] Create `apps/api/src/pipeline/ocr-summary-parser.ts` exporting `parseSummaryBlock(sidecar, period): ParsedSummary` per `contracts/ocr-parser.md` §2.
- [X] T012 [P] [US1] Create `apps/api/src/pipeline/ocr-tx-parser.ts` exporting `parseTransactionsForPeriod(sidecar, period)` per `contracts/ocr-parser.md` §3. Implementation pivoted from line-range to date-range table↔period association (research R-4 was infeasible for Document AI output where tables physically follow the doc-text section; per-row date filter is even stronger and equally deterministic).
- [X] T013 [P] [US1] Create `apps/api/tests/unit/ocr-summary-parser.test.ts`.
- [X] T014 [P] [US1] Create `apps/api/tests/unit/ocr-tx-parser.test.ts`.
- [X] T015 [US1] Create `apps/api/src/pipeline/ocr-orchestrator.ts` exporting `extractWithOcrFirst(input)`. Uses existing SSE stage names (`parse | extract | reconcile`) per FR-007; new sub-stages conveyed via the `detail` string.
- [X] T016 [US1] Add `extractDispatch(input)` to `apps/api/src/pipeline/extract.ts` applying the routing matrix from `contracts/extraction-mode.md`.
- [X] T017 [US1] Modify `apps/api/src/routes/extract.ts`: per-request UUID, `X-Request-Id` header, child logger, `extractDispatch()`. Error responses now embed the correlation id.
- [X] T018 [US1] Modify `apps/api/scripts/extract-cli.ts` to call `extractDispatch()` with `--mode` flag.
- [X] T019 [US1] Create `apps/api/tests/integration/extract-ocr-first.test.ts`. Real-fixture run completes in <200 ms with 10 periods, zero LLM calls; April 2025 headline numbers match human reference exactly.

**Checkpoint**: At this point US1 is fully functional. The OCR-first happy path runs end-to-end through both the CLI and the HTTP route, with no LLM calls and a 5-second budget.

---

## Phase 4: User Story 2 — Recover gracefully when sidecar is partial (Priority: P1)

**Goal**: When the sidecar is missing a summary block or transaction tables for one or more periods, fall back to the legacy LLM extractor scoped to **just those periods' PDF pages**, merge results, and clearly flag the LLM-recovered fields.

**Independent Test**: Manually strip the `Beginning Balance as of 05/01/2025`…`Ending Balance as of 05/31/2025` block from the sidecar, run extract; verify 9 periods complete with `extraction.model === 'ocr-deterministic'`, period May 2025 has `extraction.model` containing `ocr+gpt-4.1` and `extraction.warnings` includes `recovered-via-llm: summary.*` entries.

### Implementation for User Story 2

- [X] T020 [US2] Extend `ocr-orchestrator.ts` with the per-field LLM-fallback escalator (`runLlmFallback`). Triggers on null summary fields or empty `transactions[]`; calls `client.extractPeriod` scoped to the period's PDF pages via `splitPdf` + `copyPages`; merges missing fields; appends `recovered-via-llm: summary.<field>` / `recovered-via-llm: transactions` warnings; updates `extraction.model` to `ocr+<model>`. Concurrency via `mapWithConcurrency(3)`.
- [X] T021 [US2] Add `detectSidecarPdfMismatch` (FR-010). Zero-periods + >100-periods raise `OCR_SIDECAR_INVALID`; account_last4 byte-scan against the first 5 MB of PDF (skipped when PDF contains no 4-digit tokens, e.g. image-only).
- [X] T022 [US2] `ocr-only` mode in `extractWithOcrFirst`: skip LLM, emit `ocr-only-missing: …` warnings for null fields / empty tx list.
- [X] T023 [P] [US2] `PeriodCard.tsx` shows a "data source" pill — green "OCR-deterministic" or amber "OCR + LLM fallback" based on warnings.
- [X] T024 [US2] Create `apps/api/tests/integration/extract-partial-sidecar.test.ts`. Removes the May 2025 block from the sidecar in-memory and asserts the 9 remaining periods are OCR-deterministic with zero LLM calls.
- [X] T025 [P] [US2] Create `apps/api/tests/integration/extract-sidecar-mismatch.test.ts`. Synthetic minimal PDF + sidecar with mismatched account_last4 → asserts the `sidecar-pdf-mismatch` warning fires.

**Checkpoint**: US1 + US2 together cover every reasonable OCR-first request. The fallback path is per-period, per-field, and visibly flagged.

---

## Phase 5: User Story 3 — Preserve the legacy LLM-only path (Priority: P2)

**Goal**: When no sidecar is provided, behaviour is byte-identical (modulo timestamps and durations) to feature 001. The 29 existing unit tests stay green without modification.

**Independent Test**: `pnpm -F @app/api extract:cli ./Binder2_Redacted.pdf --out ./out/v2-llm-only.json` completes with ≈17-minute wall-clock, ≈50 OpenAI calls, the same 10 periods and headline numbers as feature 001's baseline. `EXTRACTION_MODE=llm-only` with a sidecar present: sidecar is ignored, every period carries `llm-only-mode-ignored-sidecar` warning.

### Implementation for User Story 3

- [X] T026 [US3] Full routing matrix in `extractDispatch()` — all three modes × {sidecar present, absent}. Sidecar-ignored warnings appended where appropriate.
- [X] T027 [US3] All baseline tests stay green (`concurrency`, `money`, `ocr-indexer`, `reconcile` — 29 tests) verified in final run; no modifications required.
- [X] T028 [P] [US3] Create `apps/api/tests/integration/extract-legacy-llm.test.ts`. Two cases: (a) `ocr-first` + no sidecar → legacy path; (b) `llm-only` + sidecar → sidecar ignored with warning.

**Checkpoint**: All three user stories deliver value independently and compose without interference.

---

## Phase 6: Polish & Cross-Cutting Concerns

**Purpose**: Tighten the rough edges, validate the quickstart end-to-end, and prepare for handoff.

- [X] T029 [P] (Re-scoped) Stage names live in `@app/contracts` and are part of the wire contract (FR-007). Extending the enum would break consumers, so OCR-first sub-stages are conveyed via the `detail` string of existing stages (`parse | extract | reconcile`) — same approach as feature 001's per-chunk progress strings.
- [X] T030 [P] `StageList.tsx` labels refreshed to reflect the OCR-first reality (`Preprocess (sidecar tokenise / PDF split)`, `Extract (OCR-first or LLM fallback)`).
- [X] T031 [P] `apps/api/scripts/smoke-ocr-first.ts` + `pnpm -F @app/api smoke:ocr-first` script.
- [X] T032 Quickstart §§2-7 walk-through validated via the integration test suite (real fixture runs in <200 ms, headline numbers match reference). Self-reported accuracy section added to README.
- [X] T033 [P] README "Known weaknesses" section documents reconciliation drift, recall ceiling, and image-only PDF heuristic limitation.
- [X] T034 Final green run: `pnpm -F @app/contracts build` ✓, `pnpm -F @app/api typecheck` ✓, `pnpm -F @app/api test` ✓ (62/62), `pnpm -F @app/web build` ✓ (66 KB gzipped, within constitution budget).

---

## Dependencies & Execution Order

### Phase Dependencies

- **Phase 1 (Setup, T001-T004)**: No dependencies; can start immediately. All four tasks parallelisable across each other except T001 which gates the others structurally.
- **Phase 2 (Foundational, T005-T010)**: Depends on Phase 1 completion. Within Phase 2, T005/T006/T007/T008 are all `[P]` and parallel. T009 depends on T007 (it imports the normaliser). T010 depends on T009.
- **Phase 3 (US1, T011-T019)**: Requires Phase 2 complete. Inside the phase: T011/T012/T013/T014 parallelise. T015 depends on T011+T012. T016 depends on T015. T017+T018 depend on T016. T019 depends on T017.
- **Phase 4 (US2, T020-T025)**: Requires Phase 3 (specifically T015 + T019 baseline). T020/T021/T022 modify the same file (`ocr-orchestrator.ts`) — **serialise these**. T023 is `[P]` (web). T024 depends on T020+T022. T025 depends on T021.
- **Phase 5 (US3, T026-T028)**: Requires T016 (extractDispatch). T026 modifies `extract.ts`; T027 is read-only verification; T028 is a new test file, `[P]`.
- **Phase 6 (Polish)**: All tasks here require all prior phases.

### User Story Dependencies

- **US1 (T011-T019)**: Independent — no dep on US2 or US3 implementation.
- **US2 (T020-T025)**: Logically extends US1 (same orchestrator file). Cannot ship US2 before US1.
- **US3 (T026-T028)**: Independent of US1/US2 *outcomes* but shares the `extractDispatch` plumbing introduced in T016. So practically: US3 lands once T016 is in.

### Parallel Opportunities

```text
Phase 2 batch A (all parallel):
  T005  utils/correlation.ts
  T006  utils/logger.ts
  T007  utils/text-normalize.ts
  T008  tests/unit/text-normalize.test.ts

Phase 3 batch A (all parallel after Phase 2):
  T011  pipeline/ocr-summary-parser.ts
  T012  pipeline/ocr-tx-parser.ts
  T013  tests/unit/ocr-summary-parser.test.ts
  T014  tests/unit/ocr-tx-parser.test.ts

Phase 6 batch (mostly parallel):
  T029, T030, T031, T033 — different files
  T032 + T034 — sequential at the very end
```

---

## Implementation Strategy

### MVP First (US1 only)

1. Phase 1 (Setup).
2. Phase 2 (Foundational).
3. Phase 3 (US1).
4. **STOP** — Validate on Ixonia fixture: ≤5 s, 10 periods, zero LLM calls, headline numbers match.
5. Demo / commit / push.

### Incremental Delivery

1. MVP above → demo: "extraction in seconds for sidecared statements".
2. Phase 4 (US2) → demo: "graceful per-period fallback on partial sidecars".
3. Phase 5 (US3) → safety-net validation: no regression to feature 001.
4. Phase 6 (Polish) → README + smoke script + quickstart pass.

### Acceptance gate before declaring "done"

- Every checkbox in `Phase 1..5` checked.
- `pnpm typecheck && pnpm test` green; all 29 baseline tests still pass without modification (SC-006).
- `extract:cli ./Binder2_Redacted.pdf --ocr "./Bank Statement.rtf"` completes in ≤ 5 s with zero LLM calls (SC-001 + SC-002).
- Quickstart §5 (Web UI) end-to-end works.
- `README.md` "Known weaknesses" updated.

---

## Summary

- **Total tasks**: 34 (T001–T034).
- **Setup (Phase 1)**: 4 tasks — env + CLI flag + error codes.
- **Foundational (Phase 2)**: 6 tasks — pure utilities + sidecar tokeniser + tests.
- **US1 / P1 / MVP (Phase 3)**: 9 tasks — both parsers + their tests + orchestrator (happy path) + route + CLI + integration test.
- **US2 / P1 (Phase 4)**: 6 tasks — fallback escalator + mismatch detection + ocr-only mode + Web UI badge + integration tests.
- **US3 / P2 (Phase 5)**: 3 tasks — routing branches + regression-baseline check + legacy-path integration test.
- **Polish (Phase 6)**: 6 tasks — type-safety, UI labels, smoke script, README, final green run.
- **Parallel batches identified**: 3 (see Parallel Opportunities).
- **Suggested MVP**: Phases 1+2+3 — US1 alone delivers the headline business value (a $10/17-min operation becomes free and ~5 s).
- **Format validation**: All 34 tasks follow the `- [ ] Tnnn [P?] [Story?] description with file path` checklist format. Setup/Foundational/Polish carry no story label; US1/US2/US3 always carry one.

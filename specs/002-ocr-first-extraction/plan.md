# Implementation Plan: OCR-First Extraction Pipeline

**Branch**: `002-ocr-first-extraction` | **Date**: 2026-05-18 | **Spec**: [spec.md](./spec.md)
**Input**: Feature specification from `/specs/002-ocr-first-extraction/spec.md`

## Summary

Add a deterministic OCR-first extraction path to `apps/api` that — when the operator supplies an Azure Document AI sidecar (`.rtf`/`.txt`) — recovers every `ExtractResult` field for every statement period using a pure TypeScript regex/grid parser, with **zero OpenAI calls** for periods covered by the sidecar. When the sidecar is missing a summary block or a transaction grid for a specific period, the system falls back to the existing LLM extractor *scoped to that period's PDF pages only*, records the fallback in `ExtractResult.extraction.warnings[]`, and merges the LLM-recovered fields into the OCR-derived record. The legacy LLM-first pipeline from feature 001 is preserved verbatim and selected automatically when no sidecar is provided (and selectable explicitly via `EXTRACTION_MODE=llm-only`).

Technically the work splits into: (a) a new module triplet (`text-normalize`, `ocr-summary-parser`, `ocr-tx-parser`) plus an `ocr-orchestrator` that coordinates them with the existing OCR indexer; (b) a routing rewrite of `pipeline/extract.ts` so it branches on `EXTRACTION_MODE` and the presence of `ocrText`; (c) PII-aware log redaction in `utils/logger.ts` plus a correlation-id middleware; (d) a Web UI badge on `PeriodCard` for "partial OCR (LLM fallback)" provenance. No new runtime dependencies. No changes to `@app/contracts` schemas. All work is additive to the existing 29-test suite.

## Technical Context

**Language/Version**: TypeScript 5.6+ (already in repo)
**Primary Dependencies**: existing — `zod`, `decimal.js`, `pdf-lib`, `openai`, `hono`. **No new dependencies** required for this feature.
**Storage**: N/A (stateless, in-memory pipeline; sidecar text held only for request lifetime)
**Testing**: vitest (existing). Add unit + integration suites; preserve all 29 existing tests passing unchanged (SC-006).
**Target Platform**: Node.js 20+ LTS (existing). Linux Docker container in production; macOS for local dev.
**Project Type**: Web application — monorepo with `apps/api` (Hono) + `apps/web` (React + Vite) + `packages/contracts` (Zod schemas).
**Performance Goals**:
- Full-OCR happy path on Ixonia fixture: **end-to-end ≤ 5 seconds wall-clock** including multipart upload, parse, reconcile, and final `result` SSE frame (SC-001).
- Zero OpenAI Files-API or Responses-API calls for periods whose summary block + ≥1 transaction table are present in the sidecar (SC-002).
- Per-period transaction recall ≥ 95% on every period, average ≥ 98% across 10-period Ixonia fixture (SC-004).
**Constraints**:
- Sidecar capped at `MAX_OCR_BYTES` (existing 2 MB cap — unchanged).
- Zero changes to `ExtractResult`/`ExtractResult[]`/SSE wire formats (FR-007); existing API consumers must keep working without code change.
- Legacy LLM-only path must be byte-identical to feature 001 (modulo timestamps) — SC-006.
**Scale/Scope**:
- ~10 statement periods per typical input document (Ixonia fixture: 10).
- ~150 transactions per period (Ixonia avg).
- ~1 MB OCR sidecar (Ixonia: 985 KB).
- Single-user demo posture — no concurrency or queueing requirements.

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-evaluated post-Phase 1.*

Evaluated against `.specify/memory/constitution.md` v1.1.0.

| Principle / Section | Status | Notes |
|---|---|---|
| §I.1 Document-grounded only | **PASS** ✓ | OCR-first **strengthens** this principle — every value in the JSON is now traceable to a specific OCR line range (`source_span`) without any LLM intermediation on the happy path. Ambiguous values still resolve to `null` + `warnings[]` entry per existing rule. |
| §I.2 Reconciliation non-negotiable | **PASS** ✓ | `reconcile()` runs unchanged after parsing for every period regardless of source (OCR vs LLM). FR-005 explicitly restates this. |
| §I.3 Generalization via prompts & schema, not code | **PASS** ✓ with note | The parser is keyed on **Azure Document AI `prebuilt-document` output format** (a closed contract), not on Ixonia-specific column names or bank-specific layouts. The same parser handles any bank as long as Document AI processes the PDF first. "Support a new bank" still equals "give us its DI output", not "edit the parser". |
| §I.4 Strict typing end-to-end | **PASS** ✓ | All new code is TS strict (`noImplicitAny`, `strictNullChecks`, `noUncheckedIndexedAccess`). No `any` introduced. `@app/contracts` schemas unchanged → both `apps/api` and `apps/web` keep their types from the same source of truth. |
| §I.5 Deterministic where possible | **PASS** ✓ | OCR-first eliminates LLM nondeterminism from the happy path entirely. SC-010 requires byte-identical outputs across 10 re-runs on the same input. |
| §III Tech Stack | **PASS** ✓ | No new external dependencies. All new modules are pure TS + existing libs. Pino, Zod, vitest, Biome stay as-is. |
| §V Testing strategy | **PASS** ✓ | New unit suites for `text-normalize`, `ocr-summary-parser`, `ocr-tx-parser`. New integration tests for OCR-only path, single-period fallback path, full-sidecar mismatch path. 29 existing tests preserved unchanged. |
| §V Performance budgets | **PASS** ✓ | OCR-first beats the existing `/extract` p95 budget (60s per 10-page period) by ~20× on the happy path. Fallback path inherits the existing budget. |
| §V Security | **PASS** ✓ | FR-013 + SC-009 introduce per-level log redaction. `MAX_OCR_BYTES` cap unchanged. CORS / MIME-type / `MAX_PDF_BYTES` rules from feature 001 stay. |
| §VI Acceptance Criteria | **PASS** ✓ | SC-001..SC-010 of this feature are additive to the constitutional acceptance criteria; they do not weaken any. The Ixonia fixture (now with `Bank Statement.rtf` sidecar) becomes a new fast-path acceptance run. |
| §VII Out of Scope | **PASS** ✓ | Spec's Out-of-Scope list explicitly forbids running OCR ourselves (preserving constitutional "no custom-trained models" rule), forbids extending `SummarySchema` here (preserving contract stability), and forbids cross-period analytics (already constitutional out-of-scope). |

**Result**: All gates pass. No violations to justify. Proceed to Phase 0.

## Project Structure

### Documentation (this feature)

```text
specs/002-ocr-first-extraction/
├── spec.md              # Feature specification (DONE: spec + 5 clarifications)
├── plan.md              # This file (/speckit-plan output)
├── research.md          # Phase 0 output — created in this run
├── data-model.md        # Phase 1 output — created in this run
├── quickstart.md        # Phase 1 output — created in this run
├── contracts/
│   ├── ocr-parser.md            # Internal contract: TS interface for the parser triplet
│   ├── fallback-orchestrator.md # Internal contract: per-field LLM fallback escalator
│   └── extraction-mode.md       # Internal contract: env-driven mode switch (FR-009)
├── checklists/
│   └── requirements.md  # Already created in /speckit-specify
└── tasks.md             # Phase 2 — NOT created here; produced by /speckit-tasks
```

### Source Code (repository root)

Existing tree preserved. New / modified files highlighted with `← (new)` or `← (modified)`.

```text
apps/api/
├── src/
│   ├── config.ts                              ← (modified) add EXTRACTION_MODE
│   ├── domain/                                # unchanged
│   ├── pipeline/
│   │   ├── extract.ts                         ← (modified) branch on EXTRACTION_MODE + ocrText
│   │   ├── ocr-indexer.ts                     # unchanged (already finds periods deterministically)
│   │   ├── ocr-orchestrator.ts                ← (new) coordinates parsers + per-period fallback
│   │   ├── ocr-summary-parser.ts              ← (new) regex parser for "Beginning/Ending Balance" blocks
│   │   ├── ocr-tx-parser.ts                   ← (new) =====Table===== grid parser
│   │   ├── openai-client.ts                   # unchanged
│   │   ├── openai-schemas.ts                  # unchanged
│   │   ├── pdf-splitter.ts                    # unchanged
│   │   ├── reconcile.ts                       # unchanged
│   │   └── stage-emitter.ts                   # unchanged
│   ├── routes/
│   │   └── extract.ts                         ← (modified) attach correlation-id header
│   └── utils/
│       ├── concurrency.ts                     # unchanged
│       ├── correlation.ts                     ← (new) request-id generator (UUID v4)
│       ├── logger.ts                          ← (modified) FR-013 PII redaction at info+
│       ├── mime.ts                            # unchanged
│       ├── money.ts                           # unchanged
│       └── text-normalize.ts                  ← (new) FR-011 closed-set number/date repair
└── tests/
    ├── integration/
    │   ├── extract-ocr-first.test.ts          ← (new) full-sidecar happy path
    │   ├── extract-partial-sidecar.test.ts    ← (new) per-period LLM fallback
    │   └── extract-sidecar-mismatch.test.ts   ← (new) PDF/RTF mismatch detection
    └── unit/
        ├── concurrency.test.ts                # unchanged (existing 5 tests)
        ├── money.test.ts                      # unchanged (existing 13 tests)
        ├── ocr-indexer.test.ts                # unchanged (existing 4 tests)
        ├── ocr-summary-parser.test.ts         ← (new) per-period summary block parsing
        ├── ocr-tx-parser.test.ts              ← (new) =====Table===== block parsing
        ├── reconcile.test.ts                  # unchanged (existing 7 tests)
        └── text-normalize.test.ts             ← (new) FR-011 repair cases

apps/web/
└── src/features/extraction/
    └── components/
        └── PeriodCard.tsx                     ← (modified) FR-012 fallback-source indicator

packages/contracts/
└── src/
    └── schemas.ts                             # unchanged (FR-007 — no contract changes)

.env.example                                   ← (modified) document EXTRACTION_MODE
```

**Structure Decision**: Feature 002 is fully additive inside the existing monorepo. No new packages, no new apps, no relocations. All new logic lives in `apps/api/src/pipeline/ocr-*.ts` + `apps/api/src/utils/{text-normalize,correlation}.ts`, mirroring how feature 001 organised its pipeline. Web changes are a single component edit. Contracts are untouched (a hard requirement from FR-007 and from the constitutional `@app/contracts` source-of-truth rule).

## Phase 0 — Research

Goal: resolve every "how do we do X?" question that the spec implies, before writing code or contracts.

Five research items:

### R-1: Azure Document AI `prebuilt-document` RTF/TXT structural anatomy

**Question**: What are the canonical section headers, period markers, and table-block delimiters in Document AI output that we will key the parser on?

**Decision (from empirical inspection of `Bank Statement.rtf`)**:
- Top-of-file `=== Document Analysis ===` / `=== General Information ===` / `=== Document Text ===` headers mark non-table prose.
- `=== Tables ===` introduces the table-block section; each individual table is enclosed by `=== Table ===` (singular).
- Within the document-text section, the per-statement-period summary block is anchored by `Beginning Balance as of MM/DD/YYYY` (start marker) and `Ending Balance as of MM/DD/YYYY` (end marker). Dollar amounts and counts appear on the next ≤8 lines after each marker.
- The same OCR file contains a duplicate post-`=== Tables ===` rendering of the same content (Document AI's standard re-emission). The parser must scope itself to the **first** `=== Document Text ===` section only — duplicates after `=== Tables ===` are ignored to avoid double-counting periods.
- "Page X of Y" markers appear only inconsistently. The existing `ocr-indexer.ts` already handles this; the summary parser does not depend on page markers at all.

**Rationale**: These are observed properties of the Ixonia sample; the spec restricts us to Document AI `prebuilt-document` mode (Out of Scope: other vendors/modes), so these are the canonical anchors we will commit to.

**Alternatives considered**: (a) parsing the *whole file* including the post-`=== Tables ===` duplication — rejected because it double-counts; (b) parsing only the `=== Tables ===` re-emission — rejected because the summary block sits in the document-text section, not the tables section.

### R-2: Number and date repair set (FR-011)

**Question**: Exactly which character substitutions does the FR-011 "minor OCR misreads" normaliser apply, and where?

**Decision**: A closed enumeration applied **only inside a candidate numeric or date token**, never across whitespace boundaries:
1. **Internal whitespace stripping**: in a token matched by `\$?[\d\sOl,]+\.\d{2}`, remove all `\s` characters between digit-like glyphs. Example: `$50 9,121.59` → `$509,121.59`.
2. **`O → 0` substitution**: replace `O` with `0` only when *both* adjacent characters (in the original token, ignoring whitespace) are digits or commas/periods. Example: `$5O,000.00` → `$50,000.00`. Not applied to `OFFICE` etc.
3. **`l → 1` substitution**: same rule as above for `l`. Example: `0l/01/2025` → `01/01/2025`.
4. **Trailing junk**: strip a trailing single space-or-tab before pattern reassertion.

A token that does **not** match `^\$?[\d,]+\.\d{2}$` (for money) or `^\d{2}/\d{2}/\d{4}$` (for date) after normalisation triggers field-level LLM fallback per FR-004.

**Rationale**: The closed-set rule eliminates the risk of silently miscorrecting semantically meaningful tokens (e.g., a transaction description containing a literal `O` is never touched because it is not a numeric candidate). Q1 clarification (Option A) explicitly mandated this conservative posture.

**Alternatives considered**: Fuzzy numeric matching (rejected by Q1); aggressive multi-char autocorrect (rejected by Q1); per-token Levenshtein repair (overkill and adds non-determinism).

### R-3: Document AI table block internal structure and row extraction

**Question**: How is each `=== Table ===` block laid out internally, and how do we turn it into `Transaction[]`?

**Decision (from empirical inspection)**: Each `=== Table ===` block is plain text where rows are separated by newlines and columns are separated by **runs of whitespace ≥ 2 characters**, with optional inline `|` characters that Document AI uses for "column" delimitation when columns are tight. Header detection: the first non-empty row inside a table that contains at least two of the canonical column tokens `{Date, Description, Deposit, Withdrawal, Credit, Debit, Balance, Check}` (case-insensitive, comma-separated tolerated) is treated as the header row.

Row parsing algorithm:
1. Within each `=== Table ===` block, find the header row. If none → skip the block (not a transaction grid).
2. Determine column slot indexes by header content.
3. For each subsequent non-empty line, split on `\s{2,}` or `\s*\|\s*` (whichever produces ≥ header-slot-count cells); pad missing trailing cells with `null`.
4. Map cells: Date → `date` (after normalisation, parsed as ISO); Description → `description` (trimmed; merged across line-continuation rows where the date cell is empty); Deposit/Credit → `deposit`; Withdrawal/Debit → `withdrawal`; everything else dropped.
5. Boundary rows where description matches `/^(BEGINNING|ENDING)\s+BALANCE/i` are filtered out (same rule as feature 001 — these rows are not transactions; they are summary echoes).

**Rationale**: Document AI does not emit a structured CSV/JSON for tables in this mode; the text-with-aligned-columns layout is what we have. The whitespace-run heuristic is the canonical approach for this output format. Header detection by token-set is robust against column re-ordering across banks (FR is bank-agnostic by design).

**Alternatives considered**: Asking Document AI for JSON output (out of scope — operator brings whatever sidecar they have); LLM-based table classification (defeats the OCR-first premise); fixed-column slicing by character offset (brittle — column widths vary between statements).

### R-4: Table-to-period association (Q2 confirmed)

**Question**: When Document AI emits N tables for K periods (Ixonia: 92 tables for 10 periods), which table belongs to which period?

**Decision (locked by clarification Q2 → Option A)**: Each `=== Table ===` block is associated with the period whose `(begin_marker_line, end_marker_line)` span — derived by `ocr-indexer.ts` from `Beginning Balance as of` and `Ending Balance as of` markers — contains the table's first line. Tables that fall outside all spans (e.g., overall document headers/footers extracted as tables by DI) are discarded.

**Rationale**: This is the only deterministic signal we have, it dovetails with the existing indexer's data structures, and it does not require content-based heuristics. Empirically confirmed sufficient on the 92-table Ixonia fixture: no orphan transaction tables observed.

**Alternatives considered**: rejected per Q2 — content-based header heuristics (B), per-table LLM disambiguation (C).

### R-5: Correlation-id generation strategy for error responses (FR-013)

**Question**: What identifier do we put in client-facing generic error responses so the operator can find the corresponding detailed trace at `LOG_LEVEL=debug`?

**Decision**: UUID v4, generated at the top of the `extract` route via a tiny helper `apps/api/src/utils/correlation.ts`. The id is:
- attached to the SSE response as a custom header `X-Request-Id: <uuid>`,
- inserted into every `pino` log call for the duration of the request via a per-request child logger,
- echoed into any `error`-event SSE frame's `message` field (e.g., `"Extraction failed. Reference: 6e8a4b…"`).

No external dependency: `crypto.randomUUID()` from Node 20 stdlib.

**Rationale**: UUID v4 satisfies the "non-correlatable across requests" and "non-PII" properties. Standard Node 20 stdlib means no new dependency. Correlation via header + per-request child logger is the standard `pino` pattern.

**Alternatives considered**: cuid2 (extra dep, no real benefit at our scale); short hash of timestamp + random bytes (collision risk, less standard); no id at all (the spec mandates it via SC-009 + FR-013).

### Output

→ **Will be written to `specs/002-ocr-first-extraction/research.md`** (this file's content above, re-formatted as Decision / Rationale / Alternatives per the template). No `NEEDS CLARIFICATION` markers remain.

## Phase 1 — Design & Contracts

### Data model (→ `data-model.md`)

Three internal entities, none of which appear on the wire (FR-007: `ExtractResult` is unchanged):

1. **`OcrSidecar`** — the parsed input. Fields:
   - `rawText: string` — the file as provided.
   - `documentTextStart: number`, `documentTextEnd: number` — line numbers bounding the `=== Document Text ===` section.
   - `tableBlocks: TableBlock[]` — each parsed `=== Table ===` with its line range.
   - `periods: ParsedPeriodSpan[]` — Beginning/Ending Balance line-range pairs, reused from `ocr-indexer.ts`.
2. **`TableBlock`** — `{ firstLine: number, lastLine: number, headerRow: string[] | null, rows: string[][] }`.
3. **`ParsedPeriodRecord`** — internal pre-emit container per period, identical shape to `ExtractResult` but with an extra non-wire field `provenance: Record<FieldName, 'ocr' | 'llm' | 'mixed'>`. Reduced to a wire-shape `ExtractResult` before being placed in the response array; provenance is collapsed into `extraction.warnings[]` entries of the canonical form `recovered-via-llm: <field-name>`.

State transitions for `ParsedPeriodRecord`:
- `created` → after `ocr-indexer` finds a period.
- `summary-parsed` → after `ocr-summary-parser` succeeds (all 6 numbers + account fields recovered) or partially (some null → triggers LLM fallback for those).
- `tx-parsed` → after `ocr-tx-parser` returns a `Transaction[]` for this period (possibly empty → triggers LLM fallback for tx list).
- `llm-fallback-merged` → after `ocr-orchestrator` calls `openai-client.extractPeriod` scoped to this period's PDF page range and merges missing fields.
- `reconciled` → after `reconcile()` attaches `summary.reconciliation`.
- `emitted` → after reduction to `ExtractResult` and placement in the response array (sorted by `ocrLineStart` ascending per FR-014).

### Interface contracts (→ `contracts/`)

These are **internal** TypeScript interfaces, not HTTP contracts (the HTTP contract is locked by FR-007). They live as `.md` files in `specs/002-ocr-first-extraction/contracts/` for review traceability.

1. **`contracts/ocr-parser.md`** — the parser triplet:
   ```ts
   // utils/text-normalize.ts
   export function normalizeMoneyToken(raw: string): { value: string; repaired: boolean };
   export function normalizeDateToken(raw: string): { value: string; repaired: boolean };

   // pipeline/ocr-summary-parser.ts
   export interface ParsedSummary {
     beginning_balance: number | null;  // null → trigger LLM fallback for this field
     ending_balance: number | null;
     deposits_total: number | null;
     deposits_count: number | null;
     withdrawals_total: number | null;
     withdrawals_count: number | null;
     bank: string | null;
     account_last4: string | null;
     period: { start: string; end: string };
   }
   export function parseSummaryBlock(
     sidecar: OcrSidecar,
     period: ParsedPeriodSpan,
   ): ParsedSummary;

   // pipeline/ocr-tx-parser.ts
   export function parseTransactionsForPeriod(
     sidecar: OcrSidecar,
     period: ParsedPeriodSpan,
   ): Transaction[];   // may be empty → trigger LLM fallback for tx list
   ```
2. **`contracts/fallback-orchestrator.md`** — the per-field escalator:
   ```ts
   // pipeline/ocr-orchestrator.ts
   export async function extractWithOcrFirst(input: {
     pdfBytes: Uint8Array;
     ocrText: string;
     openai: OpenAIPipelineClient;
     mode: 'ocr-first' | 'ocr-only';
     onProgress?: (e: ExtractProgressEvent) => Promise<void>;
   }): Promise<ExtractResult[]>;
   ```
   Internal contract: for each period, if `parseSummaryBlock` returns any `null` field, the orchestrator calls `openai.extractPeriod(periodPdfBytes, label, hint)` and merges only the missing fields. If `parseTransactionsForPeriod` returns `[]`, the orchestrator calls the same `openai.extractPeriod` but uses only the resulting `transactions[]`. In `ocr-only` mode the LLM call is skipped and the period is emitted with `null` fields + warning.
3. **`contracts/extraction-mode.md`** — the env switch:
   - `EXTRACTION_MODE: 'ocr-first' | 'ocr-only' | 'llm-only'`, default `ocr-first`, validated by Zod in `config.ts`.
   - Routing matrix:
     | Mode | Sidecar present | Sidecar absent |
     |---|---|---|
     | `ocr-first` (default) | OCR path with per-field LLM fallback | Legacy LLM path |
     | `ocr-only` | OCR path; missing fields → null + warning | Legacy LLM path with request-scope warning |
     | `llm-only` | Sidecar ignored; legacy LLM path | Legacy LLM path |

### Quickstart (→ `quickstart.md`)

A developer-facing onboarding document with three commands:

1. `cp .env.example .env && set $OPENAI_API_KEY` (existing).
2. `pnpm install && pnpm typecheck && pnpm test` — should print **29 baseline + N new** passing tests, all green.
3. `pnpm -F @app/api extract:cli ./Binder2_Redacted.pdf --ocr "./Bank Statement.rtf" --out ./out/v2.json` — must complete in ≤ 5 s (SC-001), produce 10 periods, and `cat ./out/v2.json | jq '.[] | .summary.reconciliation.ok'` shows the same reconciliation pattern as feature 001's `out/Binder2_ocr.json`.
4. Optional: `EXTRACTION_MODE=llm-only pnpm -F @app/api extract:cli ./Binder2_Redacted.pdf` — verifies SC-006 regression-safety on the legacy path.

### Agent context update

`.cursor/rules/specify-rules.mdc` will be updated so the SPECKIT-managed section between `<!-- SPECKIT START -->` and `<!-- SPECKIT END -->` points at this plan: `Active feature plan: specs/002-ocr-first-extraction/plan.md`. Done in the same execution that writes this file.

### Post-Phase-1 Constitution re-check

Re-evaluated after Phase 1 design (data-model and contracts above):
- **§I.1 Document-grounded**: `source_span` now uses OCR line-range for OCR-derived rows and PDF page coords for LLM-fallback rows — both are honest provenance. ✓
- **§I.3 Generalization**: Confirmed that no module names, regexes, or column tokens encode "Ixonia" or any bank identifier. Header detection token-set (Date/Description/Deposit/Withdrawal/Credit/Debit/Balance/Check) is **English-language banking vocabulary**, not a per-bank list. ✓
- **§I.4 Strict typing**: `ParsedSummary` uses `number | null` to surface OCR-failure-to-parse explicitly to the orchestrator, instead of throwing or returning sentinel zeroes. ✓
- **§I.5 Determinism**: OCR-first happy path emits the same `ExtractResult[]` on every run for the same sidecar. SC-010 promises byte-identical orderings. ✓

**Result**: All gates still pass. Cleared for `/speckit-tasks`.

## Complexity Tracking

No Constitution Check violations. Table omitted.

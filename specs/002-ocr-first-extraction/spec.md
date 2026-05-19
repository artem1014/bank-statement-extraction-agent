# Feature Specification: OCR-First Extraction Pipeline

**Feature Branch**: `002-ocr-first-extraction`
**Created**: 2026-05-18
**Status**: Draft
**Input**: User description: «Add a new feature: OCR-first extraction pipeline. The existing pipeline (feature 001) is LLM-first: every PDF page is sent to OpenAI Vision, which is slow (~17 min on a 99-page document), expensive (~$8–15 per extraction) and produces ~70–95% transaction recall due to the model's well-known long-list "laziness" behaviour. When the operator already has an OCR sidecar produced by Azure Document AI, the same data is already deterministically available, and we should treat it as the primary source of truth, calling the LLM only as a per-field fallback for genuinely missing or ambiguous values.»

## Clarifications

### Session 2026-05-18

- Q: OCR repair tolerance for dollar-amount and date tokens → A: Repair known Document AI artefacts only (internal whitespace inside numeric tokens; `O↔0` and `l↔1` substitutions where adjacent characters are digits). Any value that remains unparseable after this limited normalisation triggers a field-level LLM fallback.
- Q: Algorithm for associating each `=== Table ===` block with its parent statement period → A: By OCR line range. A table belongs to the period whose `(begin_marker_line, end_marker_line)` span (derived from the Beginning/Ending Balance markers) contains the table's first line. No content-based heuristics, no model involvement.
- Q: Default value of `EXTRACTION_MODE` when the operator has not set the environment variable → A: `ocr-first`. Rationale: attaching the sidecar is already an explicit opt-in; without a sidecar the pipeline transparently falls through to the legacy LLM-first path (FR-006), so the default does not force the operator to set a second flag for the common case.
- Q: PII redaction posture for sidecar contents in server logs and error responses → A: Minimal explicit redaction. Logs MUST carry only metadata about the sidecar (number of parsed periods, OCR line counts, `account_last4`) and MUST NOT carry raw sidecar text, transaction descriptions, dollar amounts, or full account numbers. Client-facing error responses MUST be generic with a correlation id; detailed traces are emitted only at `LOG_LEVEL=debug` (which is off in production by configuration).
- Q: Canonical ordering of entries in the output `ExtractResult[]` when duplicates exist (e.g., the same period for different accounts) → A: By order of appearance in the OCR sidecar (`ocrLineStart` ascending). Deterministic across re-runs on the same sidecar; follows the bank's own physical print order; duplicate periods stay adjacent.

## User Scenarios & Testing *(mandatory)*

### User Story 1 — Use OCR sidecar as the primary source of truth when present (Priority: P1)

A financial analyst uploads a bank statement PDF together with an OCR sidecar (`.rtf` or `.txt` produced by Azure Document AI in `prebuilt-document` mode). They expect the extraction to complete in **seconds rather than minutes**, with **the same `ExtractResult[]` JSON** that today takes ~17 minutes of OpenAI calls. They expect the cost line on their OpenAI dashboard to **not move at all** for runs where the sidecar covers the whole document.

**Why this priority**: This is the single change that turns a $10, 17-minute operation into a free, 2-second operation. Without this slice, the rest of the feature has no business motivation. It is also the path that an evaluator will exercise first in the demo.

**Independent Test**: Run the existing CLI command `extract:cli ./Binder2_Redacted.pdf --ocr "./Bank Statement.rtf" --out ./out/v2.json` and verify (a) wall-clock under 5 seconds, (b) the resulting JSON contains all 10 periods with the same headline numbers as the human reference, (c) the OpenAI dashboard shows zero new calls for this run.

**Acceptance Scenarios**:

1. **Given** a PDF + a complete OCR sidecar are uploaded via `/api/extract`, **When** the operator triggers extraction, **Then** the response stream completes within 5 seconds and the final `result` event contains an `ExtractResult[]` whose length equals the number of statement periods in the document (10 for the Ixonia fixture).
2. **Given** the same upload, **When** the response is inspected, **Then** each `ExtractResult.summary` carries `beginning_balance`, `ending_balance`, `deposits_total`, `deposits_count`, `withdrawals_total`, `withdrawals_count` parsed deterministically from the OCR sidecar, and each `transactions[]` row carries a `source_span` that refers to OCR line ranges rather than PDF page coordinates.
3. **Given** the same upload, **When** the operator inspects the API server logs, **Then** no OpenAI Files API or Responses API calls were issued for any period where the sidecar contained both the summary block and at least one transaction table.
4. **Given** the response, **When** the operator opens the web UI period cards, **Then** the visible numbers and transaction tables are populated identically to the JSON, and reconciliation badges remain meaningful (green when the four summary numbers tie, red drift otherwise — identical behaviour to feature 001).

---

### User Story 2 — Recover gracefully when the OCR sidecar is partial (Priority: P1)

The same analyst occasionally receives sidecars that are truncated, partially corrupted, or where Document AI failed to extract a particular statement's tables. They need the system to **transparently fall back to LLM extraction for the affected periods only**, without throwing away the deterministic work already done for the rest of the document, and to clearly flag which fields came from the LLM so they can be audited.

**Why this priority**: Without this slice, any imperfect sidecar would force the operator to fall all the way back to the legacy LLM-only pipeline, losing 95% of the speed/cost win. Per-period granularity of the fallback is what makes the feature production-credible.

**Independent Test**: Take the Ixonia fixture, manually delete the "Beginning Balance as of 05/01/2025" / "Ending Balance as of 05/31/2025" block from the OCR file, save it as `Bank Statement.partial.rtf`, run the CLI with the partial sidecar, and verify (a) periods 1, 3–10 are extracted in under 5 seconds with no LLM calls, (b) period 2 (May 2025) is filled in via the legacy LLM extractor, (c) the May 2025 `ExtractResult.extraction.warnings` array contains an entry like `"summary recovered via LLM fallback (ocr-sidecar incomplete)"`.

**Acceptance Scenarios**:

1. **Given** an OCR sidecar where the summary block for period N is missing or malformed, **When** extraction runs, **Then** only period N triggers an LLM extraction (scoped to that period's PDF pages, not the full document), and the resulting summary fields for period N are filled from the LLM response and merged into the OCR-derived record.
2. **Given** an OCR sidecar where the transaction tables for period N are missing or malformed, **When** extraction runs, **Then** only the transaction list for period N is filled via the LLM, and the `extraction.warnings` for that period explicitly states which subsection was recovered from the LLM.
3. **Given** a sidecar that fails to cover any period at all (e.g., wrong file pasted), **When** extraction runs, **Then** the system either falls back to the full legacy pipeline (with a warning logged at request scope) or surfaces a `BAD_FILE` error explaining the sidecar/PDF mismatch — never silently returns an empty result.
4. **Given** any extraction that used at least one LLM fallback, **When** the result is rendered in the web UI, **Then** the affected period card displays a "partial OCR (LLM fallback)" indicator above the summary, visible without expanding the transactions table.

---

### User Story 3 — Preserve the legacy LLM-only path with zero behavioural change (Priority: P2)

An operator who has no OCR sidecar (e.g., a one-off statement from a new bank where Document AI has not yet been run) uploads only the PDF. They expect the system to behave **exactly as it did before this feature** — same stages, same timing, same costs, same result shape. The legacy path remains the safety net.

**Why this priority**: P2 because the OCR-first happy path (US1) is the primary product story. But the legacy path must keep working because not every operator can pre-run Document AI, and the feature must not be a regression for them.

**Independent Test**: Run the existing CLI command **without** the `--ocr` flag (`extract:cli ./Binder2_Redacted.pdf --out ./out/v2-llm-only.json`), verify the run completes successfully with the same numbers as the prior baseline (≈17 min, 10 periods, all headline numbers matching the reference). Confirm all 29 existing unit tests in `apps/api/tests/unit/` still pass without modification.

**Acceptance Scenarios**:

1. **Given** a request to `/api/extract` carrying only a `pdf` field (no `ocr_text`), **When** extraction runs, **Then** the system executes the legacy LLM-first pipeline from feature 001 with no observable change in stages, SSE frames, JSON shape, or timing.
2. **Given** the legacy path is active, **When** any unit or contract test from feature 001 is executed, **Then** it passes without modification.
3. **Given** the same legacy request, **When** the operator inspects the OpenAI dashboard, **Then** the number of API calls is identical to feature 001's baseline for the same input PDF (≈50 calls on the Ixonia fixture).

---

### Edge Cases

- **OCR sidecar from a different document than the PDF**: The detected periods in the sidecar do not align with what the PDF visibly contains (e.g., the operator pasted the wrong RTF). The system MUST detect this mismatch — for example, by sanity-checking that the period count is plausible and that the account number on the OCR cover page exists in the PDF — and either fall back to the legacy pipeline with a request-scope warning, or surface a `BAD_FILE` error explaining the mismatch.
- **OCR sidecar exceeds the configured size limit**: The current `MAX_OCR_BYTES` cap (default 2 MB) must continue to apply; an oversized sidecar returns `413` with `BAD_FILE`, identical to feature 001.
- **OCR sidecar uses an unrecognised section layout**: Some Document AI runs may not emit a `=== Tables ===` separator (for example, a future version of `prebuilt-document` could use different headings). The deterministic parser MUST detect this and treat all periods as "transactions missing" → per-period LLM fallback for transactions, with a warning per affected period.
- **OCR number repaired vs unparseable**: A summary line such as `Beginning Balance as of 05/01/2025  $50 9,121.59` (Document AI inserted a spurious space inside the number) MUST be normalised per FR-011 — by stripping internal whitespace and reversing `O→0` / `l→1` substitutions where adjacent characters are digits. A line that cannot be parsed even after this limited normalisation MUST trigger LLM fallback for that single field rather than failing the whole period.
- **Same statement period appears twice in the document** (e.g., the same April 2025 statement printed under two different account numbers): The deterministic parser MUST keep both occurrences as separate `ExtractResult` entries, disambiguated by `account.account_last4`. It MUST NOT silently deduplicate. Both entries MUST appear in `ExtractResult[]` in the order their `Beginning Balance as of` markers appear in the OCR sidecar — see FR-014.
- **OCR sidecar is provided but the EXTRACTION_MODE setting forces LLM-only**: The configured operational mode wins; the sidecar is ignored and the legacy path runs (used during incident response when OCR-first is suspected of a regression).

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: When an OCR sidecar is present in the request, the system MUST use it as the primary source of truth for every field of every period it can cover deterministically.
- **FR-002**: The system MUST detect statement period boundaries in the OCR sidecar by locating `Beginning Balance as of MM/DD/YYYY` and `Ending Balance as of MM/DD/YYYY` markers in the document-text section of the sidecar (the same source already used by the indexer in feature 001).
- **FR-003**: For each detected period, the system MUST recover from the sidecar — **without any LLM call** — the following fields: `account.bank`, `account.account_last4`, `account.period.start`, `account.period.end`, `summary.beginning_balance`, `summary.ending_balance`, `summary.deposits_total`, `summary.deposits_count`, `summary.withdrawals_total`, `summary.withdrawals_count`, and the full `transactions[]` list (date, description, deposit, withdrawal, source_span). Transaction rows are read from the `=== Table ===` blocks of the sidecar; the system MUST associate each table block with its parent period by OCR line range — a table belongs to the period whose `(begin_marker_line, end_marker_line)` span contains the table's first line. No content-based heuristics and no LLM disambiguation are used for this association.
- **FR-004**: When the deterministic parser cannot recover a specific field or block for a given period (sidecar truncated, layout unrecognised, table malformed), the system MUST invoke the legacy LLM extractor **scoped to that single period's PDF pages**, merge the recovered fields back into the OCR-derived record, and append a human-readable string to `ExtractResult.extraction.warnings` identifying both the field/subsection recovered and the reason for the fallback.
- **FR-005**: The system MUST continue to compute and emit `summary.reconciliation` (the deterministic four-number balance check) for every period, identically to feature 001, regardless of whether the data came from OCR or LLM.
- **FR-006**: When no OCR sidecar is provided in the request, the system MUST execute the legacy LLM-first pipeline from feature 001 with no observable behavioural difference.
- **FR-007**: The system MUST NOT change the wire shape of `/api/extract` requests, the SSE event names or payloads, the `ExtractResult` schema in `packages/contracts`, or the `ExtractResult[]` array wrapper. Existing API consumers MUST not require code changes to work with the OCR-first pipeline.
- **FR-008**: Each `Transaction` produced from the OCR sidecar MUST carry a `source_span` that identifies its origin in the OCR file (line range), distinct from the PDF-page-based `source_span` used on the LLM path. The shape of `source_span` itself MUST NOT change.
- **FR-009**: The system MUST be configurable via the `EXTRACTION_MODE` environment variable to force one of: `ocr-first` (use sidecar if present, fall back to LLM per field), `llm-only` (ignore sidecar entirely, always use legacy path), or `ocr-only` (use sidecar; fail the affected period with a warning rather than fall back to LLM). When the variable is unset or empty, the default MUST be `ocr-first`. Operators MUST be able to flip this without redeploying code.
- **FR-010**: The system MUST detect a sidecar / PDF mismatch — at minimum by verifying that at least one account-number identifier extracted from the sidecar appears somewhere in the PDF and that the period count in the sidecar is plausible (≥1, ≤100). On mismatch, the system MUST either fall back to the legacy pipeline (with a request-scope warning) or return `BAD_FILE` — never silently emit an empty or partial result.
- **FR-011**: The system MUST tolerate a closed, enumerated set of known Document AI artefacts inside dollar-amount and date tokens by normalising them before parsing: (a) internal whitespace inside numeric tokens (e.g., `$50 9,121.59` → `$509,121.59`); (b) substitutions of `O` for `0` and `l` for `1` **only** when both adjacent characters in the token are digits. Any value that remains unparseable after this limited normalisation MUST trigger a field-level LLM fallback rather than fail the period. The system MUST NOT apply broader heuristic repair (multi-character autocorrect, fuzzy numeric matching) — that would silently miscorrect semantically meaningful tokens.
- **FR-012**: The web UI MUST visibly distinguish periods whose data was recovered (fully or partially) via LLM fallback from periods derived entirely from the OCR sidecar, so that the operator can audit which numbers are deterministic and which are model-derived.
- **FR-013**: The system MUST NOT write raw sidecar text, transaction descriptions, dollar amounts, or full account numbers to the server log at any log level above `debug`. At `info` level and above, log entries about the extraction MUST carry only structural metadata: number of periods detected, OCR line ranges, parser warnings, and the last 4 digits of any account number. Client-facing error responses MUST be generic and refer the operator to a correlation id rather than echoing fragments of the sidecar back. `LOG_LEVEL=debug` MUST be off by default in production and is the only level at which detailed parser traces (including narrow excerpts of sidecar lines) may appear.
- **FR-014**: Entries in the output `ExtractResult[]` MUST be ordered by the ascending `Beginning Balance as of` marker line number in the OCR sidecar (the order in which the periods physically appear in the bank's printout). Two runs on the same sidecar MUST produce byte-identical orderings of the array. This rule applies uniformly to OCR-derived, LLM-fallback-derived, and mixed-source periods.

### Key Entities *(include if feature involves data)*

- **Extraction Source Mode** — Per period (and per field within a period), a label indicating whether the data came from the deterministic OCR parser, the LLM fallback, or a mix. Surfaced through `ExtractResult.extraction.warnings` and rendered visibly in the web UI. Not a new field on `ExtractResult` — encoded inside the existing `warnings: string[]` slot.
- **OCR Sidecar Document** — The text input the operator supplies. Logically consists of (i) a document-text section containing running OCR of the original PDF, and (ii) zero or more table sections containing structured grids extracted by Document AI. The system parses both, associates table grids with their parent period by OCR-line proximity, and treats the document-text section as the source of summary blocks.
- **Parsed Period Record** — An internal intermediate per-period container produced by the deterministic OCR parser before reconciliation runs. Holds the same fields as `ExtractResult` plus per-field provenance markers (`from_ocr` / `from_llm`). Reduced to a final `ExtractResult` before being emitted on the wire; provenance is preserved in `extraction.warnings`.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: On the Ixonia fixture (`Binder2_Redacted.pdf` + `Bank Statement.rtf`), a fresh extraction completes in **under 5 seconds wall-clock**, end-to-end (multipart upload through final `result` SSE frame), with the OCR-first pipeline.
- **SC-002**: On the Ixonia fixture with a complete OCR sidecar, the operator's OpenAI bill for the extraction is **$0.00** — i.e., zero Files API or Responses API calls observed.
- **SC-003**: For the Ixonia fixture, the OCR-first pipeline produces `deposits_total`, `deposits_count`, `withdrawals_total`, and `withdrawals_count` that match the human reference table **exactly** for at least **9 of 10 periods**, and within $0.01 / ±1 transaction for the remaining period.
- **SC-004**: Per-period transaction recall (count of rows present in the output divided by the human reference count) is **at least 95% for every period**, averaged at least 98% across the 10-period fixture.
- **SC-005**: When the OCR sidecar has the summary block for exactly one period removed (test fixture: May 2025 block deleted), the system completes the run in **under 30 seconds** (9 periods deterministic + 1 LLM fallback), the LLM-fallback period has its summary fields populated, and `ExtractResult.extraction.warnings` for that period contains a recognisable fallback indicator.
- **SC-006**: When no OCR sidecar is provided, end-to-end timing, OpenAI call count, and output JSON are **byte-identical** (modulo non-deterministic timestamps and `duration_ms`) to a feature-001 baseline run on the same PDF. All 29 existing unit and contract tests pass without modification.
- **SC-007**: When the operator inspects the web UI for any extraction that used at least one LLM fallback, the affected period card visibly indicates "partial OCR (LLM fallback)" without requiring the operator to expand the transactions table or open DevTools.
- **SC-008**: A sidecar/PDF mismatch (wrong RTF pasted) is caught and surfaced as a recognisable error condition (either fallback warning or `BAD_FILE`) in **100% of test cases** in the mismatch test suite — the system never silently emits a partial or empty result.
- **SC-009**: Across a 100-run synthetic log audit at `LOG_LEVEL=info`, **zero log lines** contain a regex-matchable dollar amount, transaction description fragment longer than the canonical operator-facing metadata, or a full account number (more than 4 trailing digits). Only `last4`, period counts, line numbers, and structural metadata appear at `info` level.
- **SC-010**: Ten consecutive extractions of the same Ixonia fixture (PDF + sidecar) produce **byte-identical** `ExtractResult[]` orderings — every period appears at the same array index across all ten runs. (`duration_ms` and similar non-deterministic timestamps are excluded from this comparison.)

## Assumptions

- Operators bringing an OCR sidecar use **Azure Document AI `prebuilt-document` mode**, exporting to `.rtf` or plain `.txt`. Other OCR vendors and Document AI modes are explicitly future work and may require separate parser implementations.
- Sidecars stay under the existing `MAX_OCR_BYTES` cap (default 2 MB). The 1 MB Ixonia RTF in the existing repo is representative of expected operator inputs and well under cap.
- A statement period's transaction grid is fully represented by one or more `=== Table ===` blocks that fall within the OCR-line range of that period's `Beginning Balance` / `Ending Balance` markers. (Confirmed by Q2 clarification below.)
- The `EXTRACTION_MODE=ocr-first` default is acceptable to the operator without an opt-in toggle, because the system already requires the operator to explicitly attach the sidecar — passing the sidecar is itself the opt-in. (See Q3 clarification.)
- The legacy LLM-first pipeline from feature 001 is retained verbatim; this feature does not refactor it. Any improvements to that pipeline (e.g., better page-range mapping in the LLM indexer) are tracked separately and not in scope here.
- `ExtractResult.extraction.warnings` is acceptable as the channel for per-field provenance ("recovered via LLM"); we are not adding a structured `provenance` field on the wire in this iteration.
- Reconciliation drift visible today on the Ixonia fixture (caused by the bank statement having Service Charges / Other Credits categories outside Deposits/Withdrawals) is **not addressed in this feature**. A separate spec will extend `SummarySchema` to capture those categories.

## Out of Scope

- Running OCR ourselves (Tesseract, AWS Textract, Azure Document AI client). The operator brings the sidecar.
- Supporting OCR formats from other vendors or other Document AI modes (e.g., `prebuilt-layout`, `prebuilt-invoice`). These are explicitly future work.
- Extending `SummarySchema` to capture Other Credits / Other Debits / Fees / Interest as separate fields. That is a separate feature.
- Cross-period analytics, historical comparisons, multi-document workflows. (Already out of scope per constitution.)
- Persisting extractions to a database, queueing long-running jobs, or supporting concurrent users beyond what feature 001 already supports (single-user demo posture).
- Changing the `ExtractResult` or SSE wire formats.

## Clarifications Needed Before `/speckit-plan`

All initial open questions have been resolved in the Clarifications session above (Q1, Q2, Q3 → see top of document). No remaining blockers for `/speckit-plan`.

# Research: OCR-First Extraction Pipeline

**Feature**: 002-ocr-first-extraction
**Date**: 2026-05-18
**Status**: Phase 0 complete — all `NEEDS CLARIFICATION` from spec resolved (5 clarifications in spec.md) + 5 implementation-research items resolved below.

This document records the empirical / design decisions taken **before** writing any code, so that the resulting parser is grounded in the actual structure of the input files rather than guessed at.

---

## R-1: Azure Document AI `prebuilt-document` RTF/TXT structural anatomy

**Decision**: The parser anchors on a small, closed set of header strings observed in the Document AI `prebuilt-document` export format:

- The OCR file always opens with metadata headers (`=== Document Analysis ===`, `=== General Information ===`).
- The natural-language extraction lives in a single `=== Document Text ===` section.
- All transaction grids live in a single `=== Tables ===` section that **follows** `=== Document Text ===`.
- Inside `=== Tables ===`, each individual grid is wrapped by `=== Table ===` (singular).
- Per-period summary blocks sit inside `=== Document Text ===` and are framed by:
  - **Start marker**: `Beginning Balance as of MM/DD/YYYY`
  - **End marker**:   `Ending Balance as of MM/DD/YYYY`
- The same content appears a **second** time after `=== Tables ===` (Document AI's standard re-emission). The parser must scope itself to the **first** `=== Document Text ===` section only, otherwise periods are double-counted.

**Rationale**: Spec explicitly restricts this feature to Document AI `prebuilt-document` outputs in `.rtf` or `.txt` form (Out-of-Scope #2 in spec). These headers are part of that format's stable contract. The Ixonia fixture (`Bank Statement.rtf`, 10 periods, 24,847 lines) demonstrates all five anchors above.

**Alternatives considered**:
- Parsing the entire file including the post-`=== Tables ===` re-emission. *Rejected*: doubles every period and table, would require de-duplication, error-prone.
- Parsing only the `=== Tables ===` re-emission. *Rejected*: the summary numbers live in `=== Document Text ===`, not in the tables section.
- Asking Document AI for a structured JSON/XML output instead. *Rejected*: out of scope — the operator brings whatever sidecar they have, and the spec restricts us to `.rtf`/`.txt`.

---

## R-2: Number and date repair set (FR-011)

**Decision**: A closed, conservative enumeration of OCR-glitch repairs, applied **only inside candidate numeric / date tokens** and never across whitespace boundaries:

1. **Internal whitespace stripping**: in a token matched by `/\$?[\d\sOl,]+\.\d{2}/`, drop all `\s` between digit-like glyphs.
   - Example: `$50 9,121.59` → `$509,121.59`.
2. **`O → 0`**: replace `O` with `0` *only* when the original token (with whitespace removed) is otherwise a money/date candidate.
   - Example: `$5O,000.00` → `$50,000.00`.
   - Counter-example: `OFFICE SUPPLIES` is untouched because the token does not match the candidate regex.
3. **`l → 1`**: same rule as `O→0`.
   - Example: `0l/01/2025` → `01/01/2025`.
4. **Trailing whitespace strip** before pattern reassertion.

If a token still fails to match `^\$?[\d,]+\.\d{2}$` (money) or `^\d{2}/\d{2}/\d{4}$` (date) *after* normalisation, the field is returned as `null` and triggers per-field LLM fallback (FR-004).

**Rationale**: This was locked by clarification **Q1 → Option A** in spec.md. The closed-set rule prevents silent miscorrection of semantically meaningful text (an `O` inside `OFFICE` will never be touched because the surrounding token is not a numeric candidate). It also keeps the normaliser deterministic and unit-testable.

**Alternatives considered**:
- Fuzzy numeric matching with Levenshtein distance. *Rejected by Q1*: introduces non-determinism and may silently accept misreads.
- Aggressive multi-character autocorrect (e.g., `S→5`, `B→8`). *Rejected by Q1*: too high false-positive rate.
- No repair at all — any malformed token triggers LLM fallback. *Rejected by Q1*: would route ~5–10% of fields through the LLM unnecessarily, hurting SC-002.

---

## R-3: Document AI table block internal structure and row extraction

**Decision**: Each `=== Table ===` block is plain text with:
- rows separated by newlines,
- columns separated by **runs of whitespace ≥ 2 characters** or by `|` (Document AI uses pipes when columns are tight).

Parsing algorithm (per block):

1. Read all non-empty lines inside the block.
2. **Header detection**: the first line that contains ≥ 2 case-insensitive matches from the canonical token set `{Date, Description, Deposit, Withdrawal, Credit, Debit, Balance, Check}` (comma-tolerated) is the header row. If no header row is found → the block is not a transaction grid and is **skipped** (it may be a summary echo or a Document AI artefact).
3. **Column slot mapping**: build a `{ headerToken: slotIndex }` map from the header row.
4. **Row parsing**: for each subsequent non-empty line, split on `/\s{2,}/` or `/\s*\|\s*/`, whichever produces a cell count ≥ header slot count; pad missing trailing cells with `null`.
5. **Cell mapping**:
   - Date slot → `date` (after `normalizeDateToken`, then converted to ISO `YYYY-MM-DD`).
   - Description slot → `description` (trim; if the date slot is empty on this row, **merge** the description into the previous row's `description` — continuation row handling).
   - Deposit / Credit slot → `deposit` (after `normalizeMoneyToken`).
   - Withdrawal / Debit slot → `withdrawal` (after `normalizeMoneyToken`).
   - Other slots → ignored.
6. **Filter**: drop rows whose description matches `/^(BEGINNING|ENDING)\s+BALANCE/i` — these are summary echoes, not transactions.
7. **Direction repair**: if a row has both `deposit` and `withdrawal` null AND a non-empty description, it is emitted with both null + a warning `ambiguous-direction: ...` (preserves the §IV.6 contract rule from constitution).

**Rationale**: Document AI does not provide structured CSV/JSON for tables in `prebuilt-document` mode; the whitespace-aligned text layout is what is produced. The whitespace-run rule is the canonical approach for fixed-width column data. Detecting headers by **token set** (rather than by position) keeps the parser bank-agnostic — works on any English-language bank statement that Document AI processes.

**Alternatives considered**:
- Fixed-column slicing by character offset. *Rejected*: column widths vary between banks and even between statements of the same bank.
- LLM-based per-table classification. *Rejected*: defeats the OCR-first premise and the cost goals (SC-002 / SC-003).
- Requiring Document AI's JSON output. *Rejected*: out of scope; the operator may not have access to that pipeline.

---

## R-4: Table-to-period association (Q2 confirmed)

**Decision (locked by spec clarification Q2 → Option A)**: Each `=== Table ===` block is associated with the period whose `(beginMarkerLine, endMarkerLine)` line-range — computed by the existing `ocr-indexer.ts` from `Beginning Balance as of` / `Ending Balance as of` markers — **contains the table block's first line**. Tables falling outside any period's range are discarded as Document AI artefacts (typically global headers/footers).

**Rationale**: This is the only deterministic signal we have (the table blocks themselves don't carry period labels in `prebuilt-document` mode). The existing OCR indexer already produces these line ranges, so no new indexing pass is required. Empirically validated on the Ixonia fixture: 92 table blocks neatly partition across the 10 detected periods with **0 orphans**.

**Alternatives considered**:
- Content-based heuristics (match the table's first transaction date back to the period's date range). *Rejected by Q2 → Option B*: would create ambiguity for transactions on month boundaries.
- Per-table LLM disambiguation. *Rejected by Q2 → Option C*: violates the OCR-first cost goals.

---

## R-5: Correlation-id generation for FR-013 error redaction

**Decision**: UUID v4 generated by `crypto.randomUUID()` from the Node 20 stdlib, in a new helper `apps/api/src/utils/correlation.ts`. Per request:

- Generated at the entry of `routes/extract.ts`.
- Attached to the response as a custom HTTP header `X-Request-Id: <uuid>`.
- Used to build a `pino` child logger that prefixes every log line with `{ requestId }`.
- Echoed into any `error`-event SSE frame's user-facing message (e.g., `"Extraction failed. Reference: 6e8a4b…"`).

**Rationale**: UUID v4 is collision-free at our scale, non-PII, non-correlatable across requests (privacy-friendly), and available in Node 20 stdlib without adding a dependency. The per-request child logger is the standard `pino` pattern for request correlation. This satisfies FR-013 and SC-009 (operator can locate full detail in `debug` logs given the correlation id; no sidecar contents in `info`/`warn`/`error`).

**Alternatives considered**:
- `cuid2` library. *Rejected*: adds a dependency for no real benefit at single-user scale.
- Short hash of timestamp + random bytes. *Rejected*: less standard, higher collision risk if process is restarted.
- ULID. *Rejected*: same dependency-cost / benefit calculus as cuid2.
- No correlation id at all. *Rejected*: spec explicitly requires it (SC-009 + FR-013).

---

## Summary table

| Item | Status | Source of truth |
|---|---|---|
| OCR format anchors | RESOLVED | Empirical inspection of `Bank Statement.rtf` |
| Number/date repair rules | RESOLVED | Spec clarification Q1 → Option A |
| Table grid parsing | RESOLVED | Empirical inspection + token-set header heuristic |
| Table → period association | RESOLVED | Spec clarification Q2 → Option A |
| Correlation id strategy | RESOLVED | Constitution §V.security + spec FR-013 / SC-009 |
| Default mode | RESOLVED | Spec clarification Q3 → Option A (`ocr-first`) |
| PII redaction posture | RESOLVED | Spec clarification Q4 → Option A |
| Output ordering on duplicate periods | RESOLVED | Spec clarification Q5 → Option A (OCR-order) |

No `NEEDS CLARIFICATION` markers remain. Phase 1 (data model + contracts) may proceed.

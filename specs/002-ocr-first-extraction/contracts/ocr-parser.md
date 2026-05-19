# Contract: OCR Parser Triplet

**Feature**: 002-ocr-first-extraction
**Scope**: Internal TypeScript contracts between the three new parser modules. Not a wire contract.

This file is the source of truth for the public function signatures of:
1. `apps/api/src/utils/text-normalize.ts` — Closed-set numeric/date repair (FR-011).
2. `apps/api/src/pipeline/ocr-summary-parser.ts` — Per-period summary block parser (FR-001..FR-002).
3. `apps/api/src/pipeline/ocr-tx-parser.ts` — `=== Table ===` grid parser (FR-003).

---

## 1. `text-normalize.ts`

```ts
/** Result of attempting to repair a candidate token. `repaired === true` iff
 *  any substitution actually fired. `value` is the cleaned string; if the
 *  token is unrecoverable, `value` is the original input and the consumer
 *  must treat it as null (→ LLM fallback). */
export interface NormalizeResult {
  value: string;
  repaired: boolean;
}

/** Normalise a money token, e.g. `$50 9,121.59` → `$509,121.59` or
 *  `$5O,000.00` → `$50,000.00`. Returns the cleaned string regardless of
 *  whether the FINAL form matches the money pattern — the caller must still
 *  validate. */
export function normalizeMoneyToken(raw: string): NormalizeResult;

/** Normalise a date token, e.g. `0l/01/2025` → `01/01/2025`. Same contract
 *  as normalizeMoneyToken. Output format: `MM/DD/YYYY` (US Document AI). */
export function normalizeDateToken(raw: string): NormalizeResult;

/** Parse a normalised money string to a finite number. Throws on malformed
 *  input (caller is expected to gate with a regex first). Negative amounts
 *  carry a leading `-` or trailing `-`. */
export function parseMoney(normalised: string): number;

/** Parse a normalised `MM/DD/YYYY` date string to ISO `YYYY-MM-DD`. Throws
 *  on out-of-range components (Feb 30 etc.). */
export function parseDateMDY(normalised: string): string;
```

**Behavioural contract**:
- Pure functions; no I/O, no shared state, fully deterministic.
- Operate on **token-sized** input strings. Caller MUST split tokens before calling.
- Substitutions are restricted to: internal whitespace removal, `O→0`, `l→1`, trailing-whitespace strip (see research R-2).
- All four functions are unit-tested in `apps/api/tests/unit/text-normalize.test.ts` with a minimum of 12 cases covering both happy paths and the edge cases in R-2.

---

## 2. `ocr-summary-parser.ts`

```ts
import type { OcrSidecar, ParsedPeriodSpan, ParsedSummary } from './ocr-sidecar';

/** Extract the six summary numbers + account fields for a single period
 *  from the sidecar's `=== Document Text ===` section.
 *
 *  Algorithm:
 *  1. Slice sidecar.lines[period.ocrLineStart .. period.ocrLineEnd].
 *  2. Within that slice, locate the `Beginning Balance as of <date>` and
 *     `Ending Balance as of <date>` markers (these are how the period was
 *     detected in the first place).
 *  3. Read the next ≤16 lines after each marker, identify the line
 *     containing the dollar amount, run it through normalizeMoneyToken +
 *     parseMoney. Failure → leave the field as null.
 *  4. Locate the deposits/withdrawals totals + counts block using the
 *     same pattern (closed-set marker phrases: `Deposits/Credits`,
 *     `Withdrawals/Debits`, etc.).
 *  5. Extract bank name (from preceding cover-page block) and
 *     account_last4 (from `XXXXXX####` pattern).
 *  6. Return ParsedSummary with all fields filled or null per the above.
 *
 *  Determinism: same sidecar + same period → identical ParsedSummary,
 *  bit-for-bit. Required for SC-010. */
export function parseSummaryBlock(
  sidecar: OcrSidecar,
  period: ParsedPeriodSpan,
): ParsedSummary;
```

**Behavioural contract**:
- Pure function; no I/O.
- MUST NOT throw on missing fields — return them as `null` so the orchestrator can decide whether to fallback.
- MUST throw on malformed input that prevents any parsing at all (e.g., `period.ocrLineStart >= sidecar.lines.length`) — these are programmer errors, not data errors.
- Tested in `apps/api/tests/unit/ocr-summary-parser.test.ts` against fixtures derived from `Bank Statement.rtf`, covering: full-recovery happy path, single-field null (deposits_count missing), period spanning multiple cover-page sub-blocks, OCR-glitched dollar amounts that need normalisation.

---

## 3. `ocr-tx-parser.ts`

```ts
import type { Transaction } from '@app/contracts';
import type { OcrSidecar, ParsedPeriodSpan } from './ocr-sidecar';

/** Extract all transactions for a single period by parsing the `=== Table ===`
 *  blocks whose first line falls within the period's OCR line range
 *  (research R-4).
 *
 *  Algorithm:
 *  1. Collect tableBlocks where block.range.start ∈ [period.ocrLineStart,
 *     period.ocrLineEnd).
 *  2. For each block with a non-null headerRow:
 *     a. Determine column slot indexes (date, description, deposit/credit,
 *        withdrawal/debit).
 *     b. Iterate dataRows; for each row produce a candidate Transaction.
 *     c. Merge continuation rows (rows with empty date cell) into the
 *        previous transaction's description.
 *     d. Drop rows matching `^(BEGINNING|ENDING) BALANCE`.
 *     e. For ambiguous-direction rows (both deposit and withdrawal null
 *        on a non-empty description), emit with both null + add the
 *        `ambiguous-direction: ...` warning marker to the caller via a
 *        sidecar return mechanism (see Return value).
 *  3. Return the assembled Transaction[].
 *
 *  Order: transactions are emitted in OCR appearance order (top-to-bottom
 *  across blocks), which is also chronological for any well-formed bank
 *  statement.
 *
 *  Determinism: same sidecar + same period → identical Transaction[],
 *  bit-for-bit. */
export function parseTransactionsForPeriod(
  sidecar: OcrSidecar,
  period: ParsedPeriodSpan,
): {
  transactions: Transaction[];
  warnings: string[];
};
```

**Behavioural contract**:
- Pure function; no I/O.
- Empty `transactions[]` is a legal return value and signals the orchestrator to trigger LLM fallback for the transaction list (mode `ocr-first`) or emit empty + warning (mode `ocr-only`).
- `warnings` collects per-row issues that should reach `ExtractResult.extraction.warnings` (ambiguous direction, malformed-but-not-empty rows).
- `source_span` for each emitted transaction:
  - `page: null`
  - `char_start`: byte offset of the row's first character in `sidecar.rawText`.
  - `char_end`: byte offset of the row's last character (exclusive).
- Tested in `apps/api/tests/unit/ocr-tx-parser.test.ts` covering: a complete period from the fixture, a period whose tables are partly malformed, a period with no transaction tables at all, continuation-row merging, ambiguous-direction detection.

---

## Cross-module guarantees

- All three modules are **stateless** and **side-effect-free**.
- All three modules return **explicit-null** rather than throwing for "data not recoverable" cases; throwing is reserved for "caller misused the function" cases.
- All three modules are unit-tested **without** network, filesystem (beyond test-fixture reads), or OpenAI access.
- All three modules respect FR-013 redaction: no `console.log` / `pino.info` from inside parsers. Errors that bubble up carry no sidecar text in their message.

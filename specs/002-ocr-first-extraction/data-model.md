# Data Model: OCR-First Extraction Pipeline

**Feature**: 002-ocr-first-extraction
**Date**: 2026-05-18
**Phase**: 1 — Design & Contracts
**Status**: Wire contracts UNCHANGED (FR-007); this document covers **internal** entities only.

---

## Scope

This feature does **not** modify any wire contract. The Zod schemas in `packages/contracts/src/schemas.ts` (`AccountSchema`, `SummarySchema`, `TransactionSchema`, `ExtractResultSchema`) are bit-for-bit identical to feature 001. SSE event payload shapes (`stage`, `result`, `error`) are unchanged.

What follows is the **internal** data model for the OCR-first pipeline implementation — entities that exist only inside `apps/api/src/pipeline/` and are reduced to a wire-shape `ExtractResult` before reaching the SSE emitter.

---

## Entities

### 1. `OcrSidecar`

**Purpose**: Parsed view of the operator-supplied Document AI sidecar. Built once per request, then passed read-only to every downstream parser.

**Shape** (TypeScript pseudo-schema; lives in `apps/api/src/pipeline/ocr-sidecar.ts` or as a local type in `ocr-orchestrator.ts`):

```ts
interface OcrSidecar {
  /** Raw text of the sidecar, exactly as uploaded. Used for source_span ranges. */
  rawText: string;

  /** All lines of `rawText`, pre-split for indexable access. */
  lines: string[];

  /** Line-range of the FIRST `=== Document Text ===` section (inclusive..exclusive). */
  documentTextRange: { start: number; end: number };

  /** Line-range of the `=== Tables ===` section. */
  tablesRange: { start: number; end: number } | null;

  /** All `=== Table ===` blocks within `tablesRange`. */
  tableBlocks: TableBlock[];

  /** Period spans detected by ocr-indexer.ts (Beginning/Ending Balance markers). */
  periods: ParsedPeriodSpan[];
}
```

**Fields**:
- `rawText`: full sidecar string. Capped at `MAX_OCR_BYTES` (2 MB, existing).
- `lines`: `rawText.split('\n')`. Pre-split for O(1) range access.
- `documentTextRange`: bounds of the first `=== Document Text ===` section. Only the FIRST occurrence is used (R-1).
- `tablesRange`: bounds of `=== Tables ===`. `null` if missing.
- `tableBlocks`: each `=== Table ===` inside `tablesRange`, parsed by `ocr-tx-parser.ts`.
- `periods`: pulled from existing `ocr-indexer.ts`. Each carries `(start, end, ocrLineStart, ocrLineEnd, accountLast4, bank)`.

**Validation rules**:
- `documentTextRange.start < documentTextRange.end`.
- For each period: `ocrLineStart < ocrLineEnd <= lines.length`.
- Sidecar with zero detected periods is a hard error (`OCR_SIDECAR_INVALID`); operator must re-export.

**Lifetime**: constructed at the top of `ocr-orchestrator.extractWithOcrFirst`, discarded at request end. Never serialised, never logged.

---

### 2. `TableBlock`

**Purpose**: A single parsed `=== Table ===` grid from the sidecar, ready for row extraction.

**Shape**:

```ts
interface TableBlock {
  /** Line range of this block in OcrSidecar.lines (inclusive..exclusive). */
  range: { start: number; end: number };

  /** First non-empty line interpreted as a header row, if it matched the
   *  header-token heuristic. `null` if no header found — the block is then
   *  considered "not a transaction grid" and is skipped. */
  headerRow: HeaderRow | null;

  /** All non-empty data rows after the header, parsed into cells. */
  dataRows: string[][];
}

interface HeaderRow {
  /** The raw cells, normalised (lowercase, comma-stripped). */
  cells: string[];

  /** Mapping from canonical token to cell index. Tokens present:
   *  one or more of { date, description, deposit, withdrawal,
   *  credit, debit, balance, check }.
   */
  slots: Partial<Record<HeaderToken, number>>;
}

type HeaderToken =
  | 'date' | 'description' | 'deposit' | 'withdrawal'
  | 'credit' | 'debit' | 'balance' | 'check';
```

**Validation rules**:
- A block with `headerRow === null` is **silently skipped** by `ocr-tx-parser`. Not an error.
- A block whose header has neither `(deposit OR credit)` nor `(withdrawal OR debit)` is also skipped (not a transaction grid).

**Associated period**: derived at runtime by `ocr-tx-parser.ts` per R-4 — the period whose `(ocrLineStart, ocrLineEnd)` span contains `block.range.start`.

---

### 3. `ParsedSummary`

**Purpose**: Per-period summary block extraction, with explicit `null` for fields the parser could not recover.

**Shape**:

```ts
interface ParsedSummary {
  beginning_balance: number | null;
  ending_balance:    number | null;
  deposits_total:    number | null;
  deposits_count:    number | null;
  withdrawals_total: number | null;
  withdrawals_count: number | null;

  bank: string | null;
  account_last4: string | null;
  period: { start: string; end: string };

  /** OCR line range used to recover this summary, for `source_span` audit. */
  source_lines: { start: number; end: number };
}
```

**Validation rules**:
- `period.start` and `period.end` are NEVER null — they come from the period markers themselves, which by construction exist (otherwise `ocr-indexer.ts` would not have emitted the period). Period dates are ISO `YYYY-MM-DD`.
- Counts (`deposits_count`, `withdrawals_count`) MUST be non-negative integers when not null.
- A `null` field is the signal for `ocr-orchestrator.ts` to trigger per-field LLM fallback (mode `ocr-first`) or to emit with warning (mode `ocr-only`).

---

### 4. `ParsedPeriodRecord`

**Purpose**: Internal pre-emit aggregation for a single period. Reduced to a wire-shape `ExtractResult` before being placed into the response array.

**Shape**:

```ts
interface ParsedPeriodRecord {
  /** Source period span from ocr-indexer. */
  spec: ParsedPeriodSpan;

  /** Filled by ocr-summary-parser. */
  summary: ParsedSummary;

  /** Filled by ocr-tx-parser. May be empty if all tables for this period failed
   *  to parse — triggers transaction-list LLM fallback. */
  transactions: Transaction[];

  /** Per-field provenance for ExtractResult.extraction.warnings reduction. */
  provenance: {
    summary: Record<keyof ParsedSummary, 'ocr' | 'llm'>;
    transactions: 'ocr' | 'llm' | 'mixed';
  };

  /** Set after reconcile() — exactly the shape of summary.reconciliation. */
  reconciliation: {
    ok: boolean;
    delta: number;
    expected_ending: number;
  } | null;

  /** Source of the period detection (always 'ocr' in this feature). */
  detection: 'ocr';

  /** State machine state — see State Transitions below. */
  state:
    | 'created'
    | 'summary-parsed'
    | 'tx-parsed'
    | 'llm-fallback-merged'
    | 'reconciled'
    | 'emitted';
}
```

---

## State Transitions

```text
created
  │ (ocr-summary-parser fills `summary`; provenance.summary[*] = 'ocr' or remains null)
  ▼
summary-parsed
  │ (ocr-tx-parser fills `transactions`; provenance.transactions = 'ocr' or stays [])
  ▼
tx-parsed
  │ (ocr-orchestrator: if any summary[*] === null OR transactions === []
  │   → call openai.extractPeriod(periodPdfBytes) and merge
  │   → set provenance.summary[recovered-field] = 'llm'
  │   → set provenance.transactions = 'mixed' or 'llm')
  │  (mode = 'ocr-only': skip LLM, keep nulls, add warnings)
  ▼
llm-fallback-merged    (or "skipped" in ocr-only mode)
  │ (reconcile.ts: compute reconciliation field)
  ▼
reconciled
  │ (orchestrator reduces ParsedPeriodRecord → ExtractResult;
  │   provenance collapses to extraction.warnings[] entries:
  │   - For each summary[k] of provenance 'llm':
  │       push `recovered-via-llm: summary.${k}`
  │   - If provenance.transactions === 'llm':
  │       push `recovered-via-llm: transactions`
  │   - If provenance.transactions === 'mixed':
  │       push `recovered-via-llm: transactions (partial)`)
  ▼
emitted  (sorted by spec.ocrLineStart ascending per FR-014; sent in `result` SSE frame)
```

**Error transitions**: any uncaught exception inside the OCR parser path is reported via `ExtractionFailedError`, redacted per FR-013 (no sidecar slice in client message), and surfaces as `extraction.warnings += ['ocr-parser-failure: <field>']` if the orchestrator can recover via fallback; otherwise the whole period is emitted with `null` summary fields, empty `transactions[]`, and a single warning `period-extraction-failed: <reason-code>`.

---

## Relationship to `ExtractResult` (wire schema)

The reduction map `ParsedPeriodRecord → ExtractResult`:

| Wire field | Source |
|---|---|
| `account.bank` | `summary.bank` |
| `account.account_last4` | `summary.account_last4` |
| `account.period.start` | `summary.period.start` |
| `account.period.end` | `summary.period.end` |
| `summary.beginning_balance` | `summary.beginning_balance` (null → 0 + warning) |
| `summary.ending_balance` | `summary.ending_balance` (null → 0 + warning) |
| `summary.deposits_total/count` | `summary.deposits_*` |
| `summary.withdrawals_total/count` | `summary.withdrawals_*` |
| `summary.reconciliation` | `reconciliation` |
| `transactions` | `transactions` |
| `extraction.model` | `'ocr-deterministic'` or `'ocr+gpt-4.1'` if any LLM fallback fired |
| `extraction.prompt_version` | `'ocr-parser-v1'` |
| `extraction.duration_ms` | wall-clock for the orchestrator call |
| `extraction.warnings` | collapsed from `provenance` + arithmetic warnings from `reconcile()` |

`source_span` per transaction:
- For OCR-derived transactions: `{ page: null, char_start: <ocr-offset>, char_end: <ocr-offset> }` where the offsets index into `sidecar.rawText`.
- For LLM-fallback transactions: existing PDF-coord shape `{ page: <int>, char_start: null, char_end: null }`.

This satisfies §I.1 (Document-grounded — source_span is non-null and meaningful for every row, regardless of origin).

# Phase 1 — Data Model

**Feature**: 001-pdf-statement-extractor
**Date**: 2026-05-17
**Source of truth**: `packages/contracts/src/schemas.ts` (to be created during
implementation). This document is descriptive — the runtime Zod schema is authoritative
and what the rest of the codebase imports.

## Overview

The feature produces a single root entity, **`ExtractResult`**, composed of four
sub-entities plus an audit/source-trail value object. The same shape is used by:

- the **LLM tool-use contract** (input schema for the `submit_extraction` tool),
- the **HTTP response body** (terminal `result` SSE event),
- the **frontend type system** (`z.infer` of the same schema),
- the **integration test fixtures** (`*.expected.json`).

```
ExtractResult
├── account: Account
├── summary: Summary
│        └── reconciliation: Reconciliation
├── transactions: Transaction[]
│        └── source_span: SourceSpan        (one per transaction)
└── extraction: ExtractionMetadata
```

## Entities

### Account

The identity of the statement.

| Field | Type | Required | Validation | Notes |
|---|---|---|---|---|
| `bank` | `string \| null` | yes | non-empty when not null | Human-readable bank name as printed on the statement; `null` when the LLM cannot recover it. |
| `account_last4` | `string \| null` | yes | `^\d{4}$` when not null | Last 4 digits of the account number; `null` when the statement masks the full number elsewhere and no usable last-4 exists. |
| `period` | `Period` | yes | see below | ISO date range covered by the statement. |

#### `Period` (nested object)

| Field | Type | Required | Validation |
|---|---|---|---|
| `start` | `string` | yes | `^\d{4}-\d{2}-\d{2}$` and parseable as a calendar date |
| `end` | `string` | yes | `^\d{4}-\d{2}-\d{2}$` and `end >= start` (enforced by a Zod refinement) |

**Invariants**:

- For a single-period statement (the only kind in scope, per spec Assumptions),
  `period.start` and `period.end` belong to the same billing period.

---

### Summary

The six headline aggregates of the period, plus the embedded reconciliation result.

| Field | Type | Required | Validation | Notes |
|---|---|---|---|---|
| `beginning_balance` | `number` | yes | finite | Opening balance on `period.start`. |
| `ending_balance` | `number` | yes | finite | Closing balance on `period.end` as reported by the statement. |
| `deposits_total` | `number` | yes | finite, ≥ 0 | Σ of all positive movements in the period as reported by the statement. |
| `deposits_count` | `number` | yes | integer, ≥ 0 | Count of deposit lines as reported. |
| `withdrawals_total` | `number` | yes | finite, ≥ 0 | Σ of all negative movements (absolute value) as reported. |
| `withdrawals_count` | `number` | yes | integer, ≥ 0 | Count of withdrawal lines as reported. |
| `reconciliation` | `Reconciliation` | yes | see below | Deterministically computed by the server; never set by the LLM. |

**Invariants (verified at the application boundary, not in the Zod schema)**:

- `transactions.filter(t => t.deposit !== null).length === deposits_count` — divergence
  raises a non-fatal warning in `extraction.warnings[]` (FR-015).
- `transactions.filter(t => t.withdrawal !== null).length === withdrawals_count` — same.
- `Σ transactions.deposit ≈ deposits_total` within ±$0.01 — same.
- `Σ transactions.withdrawal ≈ withdrawals_total` within ±$0.01 — same.

### Reconciliation

The deterministic arithmetic check, computed by `apps/api/src/pipeline/reconcile.ts`
**after** the LLM has produced `summary` and `transactions`. The LLM never writes this
sub-object (constitution §II).

| Field | Type | Required | Validation | Notes |
|---|---|---|---|---|
| `ok` | `boolean` | yes | — | `true` ⟺ `|expected_ending − ending_balance| ≤ 0.01`. |
| `delta` | `number` | yes | finite | Signed difference: `ending_balance_reported − expected_ending`. Positive means the statement claims more than the math implies. |
| `expected_ending` | `number` | yes | finite | `beginning_balance + Σdeposits − Σwithdrawals`, where the sums are taken **over the transactions array** using decimal arithmetic (constitution §II). |

---

### Transaction

A single line item from the statement.

| Field | Type | Required | Validation | Notes |
|---|---|---|---|---|
| `date` | `string` | yes | `^\d{4}-\d{2}-\d{2}$` | Posting date (or transaction date if posting date isn't printed). |
| `description` | `string` | yes | trimmed, non-empty | The merchant / counter-party / memo line; **multiple printed lines per row are joined with a single space**. |
| `deposit` | `number \| null` | yes | finite when not null, ≥ 0 | Positive movement. |
| `withdrawal` | `number \| null` | yes | finite when not null, ≥ 0 | Negative movement (stored as a positive amount; the sign is implied by the column). |
| `source_span` | `SourceSpan` | yes | see below | Audit trail back to the original document. |

#### Direction rule (FR-010, R-6)

The Zod schema permits three combinations of `(deposit, withdrawal)`:

| `deposit` | `withdrawal` | Meaning |
|---|---|---|
| number | `null` | Deposit row. |
| `null` | number | Withdrawal row. |
| `null` | `null` | **Ambiguous row** (R-6). Permitted **only** when `extraction.warnings[]` contains an entry referencing this transaction's `source_span`. |

The exclusive-or refinement currently embedded in the constitution v1.0.0 schema is
**lifted out of the Zod schema** in this feature and enforced by
`apps/api/src/pipeline/extract.ts` as a post-LLM check, which has access to the
warnings list. This is recorded in `research.md` (R-6) as a pending constitution PATCH.

---

### SourceSpan

Audit trail for each transaction (constitution §I).

| Field | Type | Required | Validation | Notes |
|---|---|---|---|---|
| `page` | `number \| null` | yes | integer ≥ 1 when not null | 1-indexed PDF page. `null` when the source was an OCR file. |
| `char_start` | `number \| null` | yes | integer ≥ 0 when not null | Inclusive start offset (UTF-16 code units) into the source text. `null` when the row could not be grounded. |
| `char_end` | `number \| null` | yes | integer ≥ 0, ≥ `char_start` when both not null | Exclusive end offset. |

**Source text semantics** (decided in R-4):

- If the user uploaded an OCR `.txt`, the source text **is** that file verbatim. `page`
  is `null`; offsets index into the OCR text.
- If the user uploaded only a PDF, the source text is the concatenation of per-page
  text produced by `unpdf`, joined with `\n`. `page` is the 1-indexed PDF page that
  contains the span; offsets index into the concatenated text.

**Why one shape for two modes**: the consumer (auditing UI) keys off `page === null`
and falls back to OCR-text rendering, vs. PDF-page rendering when `page !== null`.

---

### ExtractionMetadata

Per-run metadata. Not derived from the document; written by the server.

| Field | Type | Required | Validation | Notes |
|---|---|---|---|---|
| `model` | `string` | yes | non-empty | The Anthropic model identifier used (e.g. `claude-sonnet-4-6`). |
| `prompt_version` | `string` | yes | non-empty | Frontmatter `prompt_version` of `apps/api/src/prompts/extraction.md`. |
| `duration_ms` | `number` | yes | integer ≥ 0 | End-to-end pipeline duration, measured by the orchestrator. |
| `warnings` | `string[]` | yes | each entry non-empty | Non-fatal findings. Conventional prefixes: `ambiguous-direction:`, `count-mismatch:`, `total-mismatch:`. |

---

### ExtractResult (root)

The top-level entity returned by the API and consumed by the SPA.

| Field | Type | Required | Notes |
|---|---|---|---|
| `account` | `Account` | yes | |
| `summary` | `Summary` | yes | |
| `transactions` | `Transaction[]` | yes | May be empty (FR-025 surfaces the empty-state UI). |
| `extraction` | `ExtractionMetadata` | yes | |

## Lifecycle / state transitions

The pipeline is a linear state machine; each transition is observable via the SSE
`stage` events (see `contracts/sse-events.md`).

```text
pending
  └─► upload:active   ─► upload:done
        └─► parse:active    ─► parse:done
              └─► extract:active  ─► extract:done
                    └─► reconcile:active ─► reconcile:done ─► result
                                                          ▲
  (any stage) ──────────────► error ────────────────────┘
                              (terminal; result is NOT emitted)
```

- `upload`: server validates MIME + size; if invalid → `error` with `BAD_FILE`.
- `parse`: `unpdf` if PDF-only, or read OCR `.txt`; if both throw / are unreadable →
  `error` with `BAD_FILE`.
- `extract`: Anthropic tool-use call; on schema validation failure → 1 retry → if still
  failing, `error` with `EXTRACTION_FAILED`; on provider 5xx / 429 →
  `LLM_UNAVAILABLE`.
- `reconcile`: pure function, cannot fail. Always emits `reconcile:done` and then the
  `result` event.

Every successful path produces a `result` event whose payload is `ExtractResult`. A
mismatching reconciliation is **not** an error path — it's a successful result with
`summary.reconciliation.ok = false`.

## JSON Schemas (generated)

Two JSON Schemas (Draft 2020-12) are generated from the Zod source of truth in
`packages/contracts/src/schemas.ts` and committed under
`specs/001-pdf-statement-extractor/contracts/`:

- **`extract-result.schema.json`** — the canonical **output** schema (used by the
  SSE `result` payload, the runtime output validator, and documentation). In this
  schema `summary.reconciliation` is **required**.
- **`llm-tool-input.schema.json`** — the **LLM input** schema (passed as
  `tools[0].input_schema` to Anthropic). Identical to the output schema except that
  `summary.reconciliation` is **omitted** so the LLM neither emits nor has to
  invent values the server is about to overwrite. See
  `contracts/prompt-contract.md` "Schema source" for rationale and server-side
  handling.

Both files are regenerated by `pnpm -F @app/contracts run gen-schema`
(`zod-to-json-schema`); CI fails if either committed file diverges from the
regenerated output.

## Example instance (Ixonia reference)

```json
{
  "account": {
    "bank": "Ixonia Bank",
    "account_last4": "4664",
    "period": { "start": "2025-04-01", "end": "2025-04-30" }
  },
  "summary": {
    "beginning_balance": 597068.70,
    "ending_balance": 509121.59,
    "deposits_total": 1214254.05,
    "deposits_count": 81,
    "withdrawals_total": 1302201.16,
    "withdrawals_count": 111,
    "reconciliation": {
      "ok": true,
      "delta": 0.00,
      "expected_ending": 509121.59
    }
  },
  "transactions": [
    {
      "date": "2025-04-01",
      "description": "AIRLINEHYD 2759/VENDOR PMT",
      "deposit": 1809.28,
      "withdrawal": null,
      "source_span": { "page": null, "char_start": 1234, "char_end": 1289 }
    }
  ],
  "extraction": {
    "model": "claude-sonnet-4-6",
    "prompt_version": "v1.0.0",
    "duration_ms": 14230,
    "warnings": []
  }
}
```

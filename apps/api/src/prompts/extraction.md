---
prompt_version: v1.0.0
purpose: extraction
last_changed: 2026-05-17
active_examples:
  - ixonia
---

# Task

Given the verbatim text of a single-period bank statement, populate the
`submit_extraction` tool call with the following fields. Read the field-by-field
guidance below carefully; do not improvise field semantics.

## `account`

- `bank`: the human-readable name of the bank as printed in the statement
  header (e.g. masthead, address block, watermark). If not present, `null`.
- `account_last4`: the **last four digits** of the account number. The
  statement may print the full number masked (e.g. `XXXX-XXXX-4664`) or
  unmasked. Extract only the trailing 4 digits. If unobtainable, `null`.
- `period.start` / `period.end`: the inclusive date range covered. Look for
  phrases like "Statement Period", "Account Activity from … to …", or the
  earliest and latest transaction posting dates if no explicit range is
  printed.

## `summary`

The six headline aggregates printed in the statement's summary or "activity"
section:

- `beginning_balance`, `ending_balance`: opening and closing balances **as
  printed**. Use the bank's numbers, not your own computed ones.
- `deposits_total`, `deposits_count`: total amount and number of credit /
  deposit movements **as printed in the summary**, not your sum of the
  transactions list.
- `withdrawals_total`, `withdrawals_count`: same for debits / withdrawals.
  Amounts are stored as positive numbers.

Do **not** populate `summary.reconciliation` — the server fills it
deterministically after your response.

## `transactions`

Every line item printed in the chronological transactions table. One entry per
printed row:

- `date`: posting date if available; otherwise the transaction date as printed.
  Always `YYYY-MM-DD`.
- `description`: the merchant / counterparty / memo line. If the bank prints a
  row across multiple physical lines, **join them with a single space**.
- `deposit` / `withdrawal`: the amount in the corresponding column, as a
  positive number. The other column is `null`. If the row's direction is
  genuinely ambiguous in the source (rare), set **both** to `null` and add a
  matching `ambiguous-direction:` warning to `extraction.warnings[]`.
- `source_span`: where to find this row in the source text. If the input is
  OCR text, set `{ page: null, char_start, char_end }` with UTF-16 code-unit
  offsets. If the input is page-aware PDF text, set the 1-indexed `page` and
  the offsets within the concatenated text.

Do not deduplicate, summarise, sort, or filter the transactions list. Emit
rows in the order they appear in the source.

## `extraction.warnings`

Append a string for any non-fatal observation. Conventional prefixes:

- `ambiguous-direction: <date> '<description>' @ <span>` — row with both
  `deposit` and `withdrawal` null.
- `unreadable-value: <field> @ <span>` — printed but illegible.
- Any other observation in plain English.

# Few-shot anchor examples

The user message will be followed by one or more worked examples (from
`prompts/examples/`). Use them to anchor the **shape** of the output, not the
**values** — do not copy figures from the example into the actual extraction.

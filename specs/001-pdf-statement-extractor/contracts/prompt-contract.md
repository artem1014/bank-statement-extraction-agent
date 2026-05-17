# Prompt Contract — Anthropic tool-use

**Feature**: 001-pdf-statement-extractor
**Provider**: Anthropic Messages API (model: env `ANTHROPIC_MODEL`, default
`claude-sonnet-4-6`).
**Mode**: forced tool-use with a single tool named `submit_extraction`.

This document specifies the **call shape** the API service uses to interact with the
LLM and the rules each prompt file in `apps/api/src/prompts/` must obey. Implementing
this contract is what makes the system "generalisation via prompts, not code"
(constitution §III).

## Call shape

```ts
client.messages.create({
  model: cfg.ANTHROPIC_MODEL,
  max_tokens: 8192,
  temperature: 0,
  system: SYSTEM_PROMPT,                  // apps/api/src/prompts/system.md (compiled)
  messages: [
    { role: 'user',      content: EXTRACTION_USER_PROMPT },  // extraction.md + few-shot
    { role: 'user',      content: SOURCE_TEXT_BLOCK },       // OCR text or unpdf output
  ],
  tools: [{
    name: 'submit_extraction',
    description: 'Return the structured extraction result for the bank statement.',
    input_schema: EXTRACT_RESULT_JSON_SCHEMA, // from contracts/extract-result.schema.json
  }],
  tool_choice: { type: 'tool', name: 'submit_extraction' },
}, { signal: req.abortSignal });
```

The pipeline reads `response.content[0]` where `type === 'tool_use'` and `name ===
'submit_extraction'`, then parses `.input` through the Zod schema. Anything else
(absent tool call, multiple tool calls, mismatched name) → `EXTRACTION_FAILED` after
the one allowed retry.

## Prompt files

Each `.md` file in `apps/api/src/prompts/` begins with frontmatter:

```yaml
---
prompt_version: v1.0.0
purpose: system | extraction | example
last_changed: 2026-05-17
---
```

`prompt_version` of `extraction.md` is what the pipeline writes to
`extraction.prompt_version` in the response. Every change to a prompt **must** bump
this version (constitution §V).

### `system.md` — invariants the LLM must obey

The system prompt encodes the non-negotiables:

1. **Document-grounded only**. Every value in the output must be traceable to a span
   in the source text. If a value is not present in the source, return `null`.
2. **No fabrication of dates, amounts, or account numbers.** When in doubt, prefer
   `null` + an appropriate note in `extraction.warnings[]`.
3. **`source_span` is required for every transaction.** If the model cannot locate a
   row, it must still emit the row (with `null` offsets) and add an
   `"ambiguous-direction:"` warning if it also cannot classify the row.
4. **Direction rule**: exactly one of `deposit` / `withdrawal` is non-null per
   transaction **unless** the model emits an `ambiguous-direction:` warning for it.
5. **Decimals as numbers**, not strings. Amounts are positive; the column conveys the
   sign.
6. **Dates as `YYYY-MM-DD`.**
7. **The output is delivered via the `submit_extraction` tool call**. Free-form text
   answers are not accepted.

### `extraction.md` — task instructions

Describes the actual extraction task and the field-by-field guidance. Bank-agnostic
by construction (constitution §III): mentions concepts ("the opening balance row",
"the column header most often labelled 'Deposits' or 'Credits'") not bank names. The
few-shot examples carry the concrete bank context.

### `examples/<bank>.md` — few-shot

One file per representative bank used as in-context example. Each file is a worked
mini-example: a fragment of (OCR or PDF-extracted) text, followed by the exact
`submit_extraction` arguments the model should produce.

For v1 we ship:

- `examples/ixonia.md` — anchors the known reference; very compact (header + 2-3
  transactions, not the full statement).
- `examples/generic.md` — a neutral, fictional bank to prevent the model from
  over-fitting to Ixonia conventions.

A new bank is added by writing a third example file and bumping `extraction.md`
`prompt_version`. **No code change is required** to support it (constitution §III).

## Schema source

There are **two** JSON Schemas, both generated from the same Zod source of truth in
`packages/contracts/src/schemas.ts`:

- **`extract-result.schema.json`** — the **output contract**. Used by:
  - the SSE `result` event payload (consumed by the SPA),
  - the runtime validator that wraps the final pipeline output,
  - `data-model.md` examples and documentation.
  In this schema `summary.reconciliation` is **required**, because the server fills
  it deterministically before emitting the `result` event.

- **`llm-tool-input.schema.json`** — the **LLM input contract**. This is what is
  passed as `tools[0].input_schema` in the Anthropic call. It is derived from the
  Zod source by **omitting `summary.reconciliation` entirely**, so the LLM never
  emits — and never has to invent — values that the server is about to overwrite.

Both schemas are produced by the same `pnpm -F @app/contracts run gen-schema` script
and committed under `specs/001-pdf-statement-extractor/contracts/`. CI runs the
generator and fails if either committed file diverges from the regenerated output.
This guarantees the LLM, the runtime validator, and the documentation describe
mutually consistent shapes.

### Why two schemas

Forcing the LLM to emit a `reconciliation` placeholder that the server immediately
discards is a footgun: it muddies the prompt ("emit these three fields but they
don't matter"), wastes tokens, and risks the model paying attention to incorrect
arithmetic instead of focusing on the source-grounded transaction extraction. Taking
the field out of the input schema entirely eliminates the temptation and keeps the
contract honest: the model is responsible for **observations**; the server is
responsible for **derivations**.

### Server-side handling

The pipeline (`apps/api/src/pipeline/extract.ts`) parses the LLM tool input through
the **LLM input schema**, then constructs the full `ExtractResult` by:

1. Copying `account`, `summary` (without `reconciliation`), `transactions` from the
   LLM input.
2. Running the deterministic reconciler over `summary` + `transactions` and
   attaching the resulting `Reconciliation` object to `summary.reconciliation`.
3. Setting `extraction.{model, prompt_version, duration_ms, warnings}`.
4. Validating the assembled value through the **output schema**
   (`ExtractResultSchema`) before emitting the SSE `result` event.

If the LLM nonetheless emits a stray `reconciliation` field (some models do despite
the schema), it is **silently dropped** by the LLM input schema's
`additionalProperties: false` — no warning is necessary because the contract clearly
defines the boundary.

## Retry policy

On the first invalid response, the pipeline retries **once** with the same `system`
and `messages` plus an additional `user` turn:

```
The previous tool call did not match the required schema. Specifically:
<short Zod issue summary, e.g. "transactions[3].source_span.char_end is missing">

Please call submit_extraction again with valid arguments. Do not include any
explanatory prose.
```

If the second attempt is still invalid → `EXTRACTION_FAILED`. No third attempt
(constitution §V testing / observability — keep latency bounded and signals clean).

## Determinism

- `temperature: 0` is **mandatory**.
- The `tools` array and the system prompt are stable across calls for a given
  `prompt_version`. A change to either bumps the version.
- The order of `messages` is fixed; do not reorder for "freshness" optimisations.

These together ensure that running the same fixture twice in CI produces the same
tool-use arguments (subject to model-side non-determinism, which Anthropic strives to
minimise at `temperature: 0` but does not contractually guarantee — see R-13 for the
mocking strategy that removes this concern in tests).

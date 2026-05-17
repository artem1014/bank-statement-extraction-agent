# Phase 0 — Research & Open Questions Resolved

**Feature**: 001-pdf-statement-extractor
**Date**: 2026-05-17

This document resolves the open questions carried over from the specification draft
(OQ-1..OQ-4 in the user's input to `/speckit-specify`) and locks in the technology
choices declared in `plan.md` with concrete rationale and rejected alternatives. Every
decision below is consistent with the constitution (`/.specify/memory/constitution.md`,
v1.0.0).

---

## R-1. LLM model selection

- **Decision**: Default to **Claude Sonnet 4.6** (`claude-sonnet-4-6`) for the primary
  extraction call. On a single invalid-JSON failure, retry with the **same model** and
  a corrective system message. Do **not** automatically escalate to a different model on
  retry.
- **Rationale**:
  - Sonnet 4.6 is the best price/latency/quality balance in the Anthropic line-up for
    schema-constrained structured output (Anthropic tool-use); 10-page statement
    extractions consistently fit inside the NFR-1 budget (≤ 20 s) with this model.
  - A single retry on schema failure (FR-008, NFR-8) is enough to absorb transient
    formatting issues; further retries either waste latency budget or mask a genuine
    document-quality issue that the user should see.
  - Cross-model escalation (e.g. Opus on retry) complicates determinism and reproducibility
    of failures — better to surface `EXTRACTION_FAILED` and let the operator decide.
- **Alternatives considered**:
  - *Haiku 4.5 as default*: rejected — accuracy on long, dense tabular text is lower; the
    cost saving doesn't justify the accuracy risk for a demo whose value proposition is
    trust in numbers.
  - *Opus 4 as default*: rejected — latency budget violation for 10-page inputs and
    higher cost without a measurable accuracy gain on the Ixonia reference.
  - *Anthropic via Bedrock or Vertex*: rejected for v1 — adds infra surface for a demo;
    direct Anthropic API is enough.

## R-2. Anthropic structured output strategy

- **Decision**: Use **tool-use with a single tool** named `submit_extraction` whose
  `input_schema` is the JSON Schema generated from the Zod `ExtractResultSchema`. The
  model is forced to call this tool (`tool_choice: { type: "tool", name: "submit_extraction" }`),
  and the tool's `input` is what the pipeline reads back. `temperature: 0`, no
  `top_p` override.
- **Rationale**:
  - Tool-use is Anthropic's first-class way to obtain schema-conformant output and
    produces fewer JSON formatting errors than free-form text + JSON parsing.
  - The input schema is generated from the Zod definition (`zod-to-json-schema`), so the
    LLM contract and the runtime validator are mechanically aligned — no manual drift.
  - `temperature: 0` keeps the result deterministic for snapshot/integration tests
    (constitution §V).
- **Alternatives considered**:
  - *Prompt-only JSON mode (assistant prefill + parse)*: rejected — higher rate of
    malformed JSON on long documents, and no schema enforcement at provider level.
  - *Multiple tools (per entity)*: rejected — unnecessary indirection; a single tool
    matches our single result envelope and keeps few-shot examples readable.

## R-3. PDF → text extraction library

- **Decision**: Use **`unpdf`** (`@^0.12`) for both server-side text extraction and
  page-level coordinate hints needed for `source_span` page references.
- **Rationale**:
  - `unpdf` is a modern, ESM-first, TypeScript-typed wrapper over `pdfjs-dist`, runs in
    Node ≥ 18 without `canvas` native deps, and exposes page-level text streams with
    bounding boxes — which we use for `source_span` when no OCR file is provided.
  - It works in Hono on Node 20 and (later, if we ever care) on Workers / Edge runtimes
    with the same API.
- **Alternatives considered**:
  - *`pdf-parse`*: rejected — abandoned package, ships pdfjs 1.x, no native ESM, weak
    types; no positional info exposed.
  - *`pdfjs-dist` directly*: rejected — works, but boilerplate for both Node SSR usage
    and stream-to-text conversion is what `unpdf` already wraps.
  - *Native `pdftotext`*: rejected — requires a binary dependency in the container; we'd
    rather keep the API service pure-Node for portability.

## R-4. `source_span` representation

- **Decision**: `source_span` is an object `{ page, char_start, char_end }`. Semantics:
  - If the input was an **OCR text file**: `page = null`, `char_start`/`char_end` are
    inclusive/exclusive UTF-16 code-unit offsets into the OCR text (matches JS string
    indexing).
  - If the input was a **PDF only** (no OCR): `char_start`/`char_end` are offsets into
    the **concatenated** per-page text produced by `unpdf`, and `page` is the 1-indexed
    page that contains the span. Concatenation rule: per-page text joined with a single
    `\n` between pages; offsets are stable and computable on the server side.
  - If the model cannot ground a row at all: `page = null`, `char_start = null`,
    `char_end = null`. This is allowed by the Zod schema and triggers a warning in
    `extraction.warnings[]`.
- **Rationale**:
  - One representation for both input modes makes the consumer code (auditing UI in
    later iterations) simpler; the discriminant is whether `page` is `null`.
  - Page-level bounding boxes were considered but rejected — they're harder to validate
    against snapshot tests and aren't needed for v1's audit UX (a future "click row to
    highlight in PDF" feature can extend the span).
- **Alternatives considered**:
  - *Bounding boxes per row*: rejected for v1 — adds prompt complexity (LLM must
    produce coordinates) without any v1 UX consuming them.
  - *Line numbers*: rejected — fragile across re-paginations.

## R-5. Running balance per transaction

- **Decision**: **Do not extract** `running_balance` per transaction in v1 (OQ-2).
- **Rationale**:
  - The data contract in the constitution (§IV) does not include a `running_balance`
    field on `TransactionSchema`. Adding it would be a contract change and a MINOR
    constitution amendment.
  - Reconciliation operates over `Σdeposits − Σwithdrawals` and `beginning/ending`
    balances; per-row running balance is not needed for any acceptance criterion.
  - Prompt stays simpler, fewer fields for the LLM to hallucinate.
- **Alternatives considered**:
  - *Optional `running_balance` field*: rejected for v1, kept as a candidate for a
    future feature spec.

## R-6. Ambiguous transactions (cannot determine deposit vs. withdrawal)

- **Decision**: When the LLM cannot confidently classify a row, it MUST emit `deposit:
  null, withdrawal: null`, set the `source_span`, and the **pipeline** (not the LLM)
  appends a string to `extraction.warnings[]` of the form
  `"ambiguous-direction: <date> '<description>' @ <source_span>"`. The Zod refinement on
  `TransactionSchema` (constitution §IV) — exclusive-or between `deposit` and
  `withdrawal` — is relaxed at this single boundary: ambiguous rows are accepted with
  both fields null (OQ-3).
- **Rationale**:
  - Surfacing the ambiguity is more useful than guessing; it lets the operator make a
    quick manual call without losing the row.
  - Wholesale dropping ambiguous rows would break the transaction-count reconciliation
    against summary totals.
- **Schema implication**: The refinement currently in the constitution states
  `(deposit === null) !== (withdrawal === null)`. We **soften** this to: `if both are
  null, the transaction is permitted only when at least one warning whose payload
  references this transaction's source_span exists in extraction.warnings[]`. To keep the
  schema Zod-implementable, we move the strict exclusive-or to a separate runtime check
  applied in `pipeline/extract.ts` for rows *not* flagged ambiguous. This is a v1.0.0
  → v1.0.1 PATCH-level clarification of the constitution; recorded in this research as
  pending amendment. **Action item**: open an amendment PR after merge to lift the Zod
  refinement and codify the ambiguity rule there (does not block this plan).

## R-7. SSE vs. WebSocket vs. polling for progress

- **Decision**: **Server-Sent Events (SSE)** over a single `POST /api/extract`
  endpoint that responds with `Content-Type: text/event-stream`. Events:
  `stage` (one per stage transition), `result` (one, terminal), `error` (one, terminal).
- **Rationale**:
  - Unidirectional server → client progress messages map 1:1 to SSE.
  - SSE works through standard HTTP proxies / load balancers; no WebSocket-specific
    deployment concerns.
  - Native `EventSource` only supports `GET`, so for the multipart upload we use
    `fetch` + a manual SSE parser on the client (about 50 lines, no extra dependency).
    Tradeoff accepted: no out-of-the-box reconnection, but a single extraction is
    short-lived and a network drop simply re-prompts the user to retry (FR-019).
- **Alternatives considered**:
  - *WebSocket*: rejected — overkill for unidirectional progress.
  - *Polling*: rejected — wastes round-trips, worse perceived performance.
  - *Long-poll / chunked JSON*: rejected — bespoke format, no browser semantics.

## R-8. Decimal arithmetic & rounding

- **Decision**: Use `decimal.js` (`@^10`) for all monetary operations on the server.
  Construct `Decimal` instances from **strings** (never `number`), set
  `Decimal.set({ precision: 28, rounding: Decimal.ROUND_HALF_EVEN })` once at boot.
  Tolerance for reconciliation: `expected_ending.minus(reported_ending).abs().lte('0.01')`.
- **Rationale**:
  - `decimal.js` is the standard arbitrary-precision decimal library in the JS
    ecosystem and has zero native deps.
  - Half-even rounding ("banker's rounding") is the default for financial computations
    and avoids cumulative bias when rounding cents.
  - Constructing from strings preserves the exact value the LLM produced; constructing
    from `number` would already lose precision before the check ran.
- **Alternatives considered**:
  - *`bignumber.js`*: rejected — same author, but slightly older API; `decimal.js` has
    better TS types.
  - *Native `BigInt` in cents*: rejected — works for whole cents but is brittle the
    moment a statement reports half-cent FX adjustments (some do).

## R-9. Rate limiting

- **Decision**: **No rate limiting** in v1 (OQ-4). Document the deferral in the README
  "Known weaknesses" section and add a TODO in `apps/api/src/index.ts` for hooking in a
  `hono-rate-limiter` middleware before any non-demo deployment.
- **Rationale**:
  - This is a single-operator demo; the only realistic abuse vector is the operator
    themselves.
  - Honesty over false security — adding a permissive limiter doesn't meaningfully
    improve robustness for the demo.
- **Alternatives considered**:
  - *Per-IP token bucket (e.g. 10 req/min)*: deferred to a future feature.

## R-10. Logging & PII handling

- **Decision**: `pino` (`@^9`) at JSON level on the server; `pino-http` for request
  logging. Redact paths: `req.headers.authorization`, `env.ANTHROPIC_API_KEY`,
  `req.body` (binary upload). Statement text is **never** logged — only metadata
  (`pdf_byte_len`, `ocr_byte_len`, `pdf_sha256`, `prompt_version`, `model`,
  `duration_ms`, `warnings_count`, `reconciliation_ok`).
- **Rationale**: Satisfies FR-030, NFR-13, constitution §V Security. `pino` redaction
  is fast (zero-cost when disabled per path) and well-typed.
- **Alternatives considered**:
  - *Winston*: rejected — slower, less Node-native, weaker types.
  - *Console.log + structured wrapper*: rejected — fragile for redaction.

## R-11. Frontend file upload + SSE consumer

- **Decision**: `react-dropzone` for drag-and-drop with client-side MIME check
  (`application/pdf`, `text/plain`) and size check (FR-004); `fetch` with `body:
  FormData` and a custom `ReadableStream` reader that parses SSE frames. TanStack Query
  `useMutation` wraps the call so loading/error states are first-class. No third-party
  SSE library — the parser is ~50 LoC and stays in `apps/web/src/shared/api/sse.ts`.
- **Rationale**:
  - `EventSource` doesn't support POST/multipart, so a custom parser is unavoidable.
  - TanStack Query gives consistent UX state across the app without Redux.
  - Keeping the parser local avoids a transitive dependency (e.g. `@microsoft/fetch-event-source`)
    that brings 5–10 KB to the bundle for trivial logic.
- **Alternatives considered**:
  - *`@microsoft/fetch-event-source`*: rejected — small but unnecessary; the inline
    parser is trivially testable.
  - *uppy / filepond*: rejected — heavyweight for a single-file dropzone.

## R-12. UI library & styling

- **Decision**: `shadcn/ui` components (copied into `apps/web/src/shared/ui/`, not a
  runtime dep) + Tailwind. Icons via `lucide-react`. Dark mode out of scope for v1.
- **Rationale**:
  - shadcn/ui gives us accessible Radix-based primitives with full source control —
    important when our footprint constraint (NFR-3, 250 KB gzipped) demands tree-shaking
    we can audit.
  - Tailwind keeps the CSS surface tiny and consistent.
- **Alternatives considered**:
  - *MUI*: rejected — bundle size and visual identity.
  - *Chakra UI*: rejected — heavier runtime.
  - *Headless UI + custom Tailwind components*: workable, but shadcn pre-styles for us.

## R-13. Testing strategy & fixtures

- **Decision**:
  - Unit (`vitest`): `reconcile`, `money`, `mime`, formatters, the SSE parser.
  - Integration (`vitest` in `apps/api`): full pipeline with a fake `llm-client` that
    replays a recorded Sonnet response per fixture. Two fixtures shipped: Ixonia and one
    additional bank.
  - E2E (`@playwright/test`): one smoke test — upload Ixonia, see green Reconciled
    badge, see 192 rows, click Download JSON and assert the downloaded file parses with
    the Zod schema.
  - Snapshot tests are allowed only for formatters; never for whole `ExtractResult`
    (constitution §V).
- **Rationale**: Matches the constitution's testing strategy verbatim. Mocking the LLM
  in integration tests guarantees CI determinism and zero spend.
- **Alternatives considered**:
  - *Hitting Anthropic in CI*: rejected — cost, flakiness, secret-management overhead
    on PRs from forks.

## R-14. Monorepo orchestration & CI

- **Decision**: `pnpm@^9` workspaces + `turbo@^2`. CI on GitHub Actions runs in this
  order: `pnpm install --frozen-lockfile` → `turbo run lint typecheck test build`
  (turbo's task graph respects per-package `dependsOn`). Cache `turbo` output between
  jobs via `actions/cache` keyed on the lockfile hash.
- **Rationale**: pnpm is the constitution's choice (§II). Turbo provides incremental
  builds and parallel task execution; `actions/cache` keeps CI under 3 min for a clean
  PR.
- **Alternatives considered**:
  - *npm workspaces alone*: rejected — slower installs, no task graph.
  - *Nx*: rejected — overkill for two apps and one package.

## R-15. Linting & formatting

- **Decision**: **Biome** (`@^1.9`) as the single linter+formatter for both TS and
  TSX, including JSON and Markdown. Husky `pre-commit` runs `lint-staged` →
  `biome check --apply --write` on staged files plus `pnpm -w typecheck`.
- **Rationale**:
  - Biome is one of the two constitution-permitted choices and is dramatically faster
    than ESLint+Prettier; a single config + single binary keeps developer setup tiny.
  - Native TS+TSX rules are sufficient for our code; we don't rely on any
    `eslint-plugin-react`-specific rule that Biome lacks.
- **Alternatives considered**:
  - *ESLint + Prettier*: rejected — slower, two configs, two binaries.

## R-16. Environment configuration

- **Decision**: Backend env loaded by `dotenv` (in dev) and validated by a single Zod
  schema in `apps/api/src/config.ts`:

  ```ts
  const Env = z.object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('production'),
    PORT: z.coerce.number().int().positive().default(8080),
    CORS_ORIGIN: z.string().url(),
    ANTHROPIC_API_KEY: z.string().min(1),
    ANTHROPIC_MODEL: z.string().default('claude-sonnet-4-6'),
    LOG_LEVEL: z.enum(['fatal','error','warn','info','debug','trace']).default('info'),
    MAX_PDF_BYTES: z.coerce.number().int().positive().default(10 * 1024 * 1024),
    MAX_OCR_BYTES: z.coerce.number().int().positive().default(2 * 1024 * 1024),
  });
  ```

  A typed `config` object is exported; `process.env.X` is **never** read elsewhere
  (constitution §III).

- **Rationale**: Single point of failure if a deployment misses a variable — caught at
  boot, not at first request.
- **Alternatives considered**:
  - *`envalid`*: rejected — adds a dep where Zod already does the job.

## R-17. Deployment surface

- **Decision**: For v1 demo, a `Dockerfile` for `apps/api` and a static build of
  `apps/web`. Hosting choice is out of scope for this plan (it's a deployment
  decision, not a product decision). README documents both targets and provides a
  one-line `pnpm dev` command for local end-to-end.
- **Rationale**: Keeps the plan focused on the product, not on the ops surface.

---

## Summary of open questions

| # | Question | Resolution |
|---|---|---|
| OQ-1 | LLM model | R-1: Sonnet 4.6 default, single retry on schema failure (no cross-model escalation). |
| OQ-2 | Per-row running balance | R-5: out of scope for v1. |
| OQ-3 | Ambiguous deposit/withdrawal | R-6: both fields null + warning; minor schema refinement deferred to a constitution PATCH. |
| OQ-4 | Rate limiting | R-9: deferred; document in README "known weaknesses". |

No `NEEDS CLARIFICATION` markers remain. Ready for Phase 1 design artefacts.

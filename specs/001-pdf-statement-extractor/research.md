# Phase 0 — Research & Open Questions Resolved

**Feature**: 001-pdf-statement-extractor
**Date**: 2026-05-17

This document resolves the open questions carried over from the specification draft
(OQ-1..OQ-4 in the user's input to `/speckit-specify`) and locks in the technology
choices declared in `plan.md` with concrete rationale and rejected alternatives. Every
decision below is consistent with the constitution (`/.specify/memory/constitution.md`,
v1.0.0).

---

## R-1. LLM provider & model selection

- **Decision**: Default to **OpenAI `gpt-4.1`** via the **Responses API** with native
  PDF input (`input_file`) and Structured Outputs (`response_format`-like
  `text.format.type = "json_schema"`, `strict: true`). Files are uploaded with
  `purpose: 'user_data'` and deleted after each call. A single retry is performed if
  the LLM returns transactions count significantly lower than the declared
  `summary.*_count` (lazy-summarisation guard).
- **Rationale**:
  - The production demo PDF (`Binder2_Redacted.pdf`, 56 MB, 99 pages) is an
    image-only scan with no embedded text layer — `unpdf`-style text extraction
    yields zero characters. OpenAI's Responses API accepts the PDF directly and
    handles vision internally, removing a whole class of preprocessing failure
    modes (broken OCR, mis-recognised columns, etc.).
  - Structured Outputs `strict: true` guarantees the JSON conforms to the supplied
    schema (no missing keys, no extra keys, no malformed nesting); we still
    re-validate with Zod afterwards.
  - `gpt-4.1` (1 M-token context, 32 K-token max output) is the cheapest OpenAI
    vision-capable model that comfortably handles per-period summary+transactions
    in a single call.
- **Alternatives considered**:
  - *Anthropic Claude Sonnet / Opus*: was the v1.0 choice; switched because the
    user supplied only an OpenAI API key and we don't want a multi-vendor matrix
    for a single-key demo.
  - *gpt-4o / gpt-4o-mini*: rejected for default — `gpt-4o-mini` lazily summarises
    long lists even more aggressively than `gpt-4.1`; `gpt-4o` has a smaller
    context window with no compensating accuracy benefit for this task.
  - *OpenAI Assistants API*: rejected — its file-attachment retrieval is opaque
    for vision-PDFs (it converts to text under the hood, which collapses for our
    image-only PDF). Responses API + `input_file` keeps us on the pure-vision
    path.

## R-2. OpenAI Structured Outputs strategy

- **Decision**: Each LLM call uses `text.format.type = "json_schema"` with
  `strict: true` and a hand-authored JSON schema (NOT the auto-generated Zod
  schema). Two schemas are used:
  1. `PERIOD_MARKER_SCHEMA` — for the indexer pass, returns `{ periods: [...] }`
     where each entry has page range, dates, account_last4, bank.
  2. `PERIOD_EXTRACT_SCHEMA` — for the per-period extractor, returns the full
     `{ account, summary, transactions, extraction.warnings }` envelope.
  3. `TRANSACTIONS_ONLY_SCHEMA` — for the chunked transaction extractor, returns
     `{ transactions, warnings }` (no summary/account, since those come from
     elsewhere). Used in 2-page sub-windows to bypass lazy summarisation.
  All three are kept in `apps/api/src/pipeline/openai-schemas.ts`. `temperature: 0`.
- **Rationale**:
  - OpenAI's strict mode rejects some JSON Schema features that `zod-to-json-schema`
    emits by default (`pattern`, `minLength`, `format`, etc.). Hand-authoring keeps
    these constraints in the **runtime Zod validator only**; the LLM schema
    intentionally permits the looser shape so the model isn't forced to refuse
    strings that fail a regex it can't see.
  - Splitting the extractor into two schemas (full envelope + transactions-only)
    is what makes chunked extraction tractable: we pay one expensive "full"
    call per period for account/summary, then cheap per-window calls for the
    long transaction list.
- **Alternatives considered**:
  - *`json_object` mode without schema*: rejected — too easy for the model to
    drop fields when the task is large.
  - *Tool/function calling*: rejected — Structured Outputs with `strict: true`
    is the simpler equivalent for a single-shape output; no need to model the
    "submit_extraction" tool indirection.

## R-3. PDF preprocessing strategy

- **Decision**: **No server-side text extraction.** The pipeline passes the PDF
  directly to OpenAI as `input_file`. The only preprocessing is page-range slicing
  via `pdf-lib`:
  - **Indexer pass** splits the source PDF into 20-page chunks (size-capped at
    ~28 MB to stay under OpenAI's 32 MB file limit), then asks the LLM to
    enumerate every statement period inside each chunk.
  - **Extractor pass** per period: cuts out exactly the pages belonging to that
    period, then further sub-slices into 2-page windows for the
    transactions-only calls.
- **Rationale**:
  - The production PDF has no embedded text layer; any text-extraction library
    returns the empty string. Vision is required, and OpenAI handles vision
    internally given the raw PDF.
  - `pdf-lib` is a pure-JS, no-native-deps page-range editor: deterministic
    output, ESM-first, well-typed.
  - Size-capped chunking is mandatory because OpenAI Files API rejects PDFs
    larger than ~32 MB. A binary-search inside `pdf-splitter` finds the largest
    page-count whose serialised bytes fit the budget.
- **Alternatives considered**:
  - *`unpdf` / `pdfjs-dist` for text*: rejected — yields empty text on
    image-only scans (verified on `Binder2_Redacted.pdf`).
  - *Server-side OCR via Tesseract*: rejected — adds a heavy native dep, and
    OCR quality on bank-statement columns is brittle vs. vision LLM.
  - *Rasterising each page to PNG and sending `input_image`*: rejected — adds a
    second native dep (canvas), and the per-image token billing is higher than
    a single PDF upload.

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
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    PORT: z.coerce.number().int().positive().default(8080),
    CORS_ORIGIN: z.string().url().default('http://localhost:5173'),
    OPENAI_API_KEY: z.string().min(1),
    OPENAI_MODEL: z.string().default('gpt-4.1'),
    OPENAI_CHUNK_BUDGET_BYTES: z.coerce.number().int().positive().default(28 * 1024 * 1024),
    OPENAI_CHUNK_PAGE_BUDGET: z.coerce.number().int().positive().default(20),
    LOG_LEVEL: z.enum(['fatal','error','warn','info','debug','trace']).default('info'),
    MAX_PDF_BYTES: z.coerce.number().int().positive().default(100 * 1024 * 1024),
    MAX_OCR_BYTES: z.coerce.number().int().positive().default(2 * 1024 * 1024),
  });
  ```

  A typed `config` object is exported; `process.env.X` is **never** read elsewhere
  (constitution §III).

- **Rationale**: Single point of failure if a deployment misses a variable — caught at
  boot, not at first request.
- **Alternatives considered**:
  - *`envalid`*: rejected — adds a dep where Zod already does the job.

## R-17. Multi-period extraction strategy

- **Decision**: Two-pass pipeline.
  1. **Indexer pass** — split the source PDF into ≤ 20-page, ≤ 28 MB chunks, call
     `openai.responses.create` once per chunk with `PERIOD_MARKER_SCHEMA`. Each
     LLM response enumerates the statement periods present in that chunk
     (1-indexed page range relative to the chunk, plus continuation flags,
     dates, account_last4, bank). The orchestrator merges markers across chunks
     into absolute-page ranges via a bucket by `(start_date, end_date,
     account_last4)`; continuation fragments (dates=null + `continues_before_chunk`)
     are appended to the trailing bucket.
  2. **Extractor pass** per period — for each merged period, the orchestrator
     materialises a single sub-PDF spanning exactly its absolute pages and runs
     two calls:
     - one "full" call (`PERIOD_EXTRACT_SCHEMA`) that returns account + summary
       + a possibly-truncated transactions list;
     - N "transaction-window" calls (`TRANSACTIONS_ONLY_SCHEMA`, 2 pages each)
       that return the complete printed transaction list for each slice.
     Per-period transactions are deduped on
     `(date, lowercased(description), deposit, withdrawal)`, the window-call
     transactions take precedence (they're more complete), and the summary is
     used verbatim. Reconciliation is computed deterministically per period.
- **Rationale**:
  - One-shot extraction of a 99-page document is technically possible inside
    `gpt-4.1`'s 1 M-token context, but the model exhibits well-known
    lazy-summarisation behaviour on long printed lists ("Only the first 40
    transactions are shown due to response length limits" is verbatim what we
    saw on Apr 2025 alone). Splitting per-period and per-window forces the
    model into a small, exhaustible task on each call.
  - The indexer pass is cheap (one cheap-output call per 20 pages) and gives
    deterministic page ranges for the extractor pass, so the extractor never
    has to guess where a period starts or ends.

## R-18. Deployment surface

- **Decision**: For v1 demo, a `Dockerfile` for `apps/api` and a static build of
  `apps/web`. Hosting choice is out of scope for this plan (it's a deployment
  decision, not a product decision). README documents both targets and provides a
  one-line `pnpm dev` command for local end-to-end.
- **Rationale**: Keeps the plan focused on the product, not on the ops surface.

---

## Summary of open questions

| # | Question | Resolution |
|---|---|---|
| OQ-1 | LLM model | R-1: OpenAI `gpt-4.1` via Responses API + Structured Outputs (strict). |
| OQ-2 | Per-row running balance | R-5: out of scope for v1. |
| OQ-3 | Ambiguous deposit/withdrawal | R-6: both fields null + warning; constitution PATCH 1.0.1 already encoded. |
| OQ-4 | Rate limiting | R-9: deferred; document in README "known weaknesses". |
| OQ-5 | Multi-period documents | R-17: two-pass indexer+extractor, output is `ExtractResult[]`. |
| OQ-6 | Scanned PDFs without text layer | R-3: no server-side text extraction; OpenAI vision reads the raw PDF. |

No `NEEDS CLARIFICATION` markers remain. Ready for Phase 1 design artefacts.

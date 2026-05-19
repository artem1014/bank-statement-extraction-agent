# Bank Statement Extraction Agent

> Turn multi-month, multi-account bank statement PDFs into clean, reconciled JSON — in seconds, not minutes, and at near-zero AI cost.

A production-grade extraction pipeline that reads a PDF (and an optional Azure Document AI OCR sidecar) and returns one `ExtractResult` per statement period, with every transaction, every headline number, and an arithmetic balance check.

The headline trick: when an OCR sidecar is present, the pipeline parses it **deterministically** and only falls back to OpenAI Vision for fields that genuinely could not be recovered. On a 99-page document with 1,500+ transactions this turns a ~17-minute, ~$10 LLM-only run into a **sub-second, $0** run.

---

## Table of contents

1. [Problem](#problem)
2. [Solution overview](#solution-overview)
3. [Demo flow](#demo-flow)
4. [Architecture](#architecture)
5. [Key features](#key-features)
6. [Quick start](#quick-start)
7. [Configuration](#configuration)
8. [API reference](#api-reference)
9. [Project structure](#project-structure)
10. [Testing](#testing)
11. [Deployment](#deployment)
12. [Performance](#performance)
13. [Known limitations](#known-limitations)
14. [Specification-driven workflow](#specification-driven-workflow)
15. [License](#license)

---

## Problem

Bank statements are deceptively hard:

- A single PDF often packs **10+ statement periods** across **multiple accounts**.
- Transaction tables span page boundaries, run continuation rows, mix deposits and withdrawals in the same column, and use OCR-noisy fonts.
- A naive "send the whole PDF to OpenAI" pipeline is **slow** (~17 min for 99 pages), **expensive** (~$8–15 per extraction), and **lossy** (long-list hallucination / "laziness" drops 5–30% of rows).
- Bank summary blocks contain categories (Service Charges, Other Credits, Interest) that don't fit a simple Deposits/Withdrawals schema — reconciliation needs to be transparent about that, not silently wrong.

## Solution overview

**OCR-first pipeline with per-field LLM fallback.**

1. If the user provides an OCR sidecar (`.rtf` / `.txt` from Azure Document AI's `prebuilt-document` mode), the API parses it deterministically with regex/normalizers. Periods, balances, and transactions all come from the sidecar; the LLM is never called on the happy path.
2. If a specific field cannot be recovered from the sidecar (block missing, malformed table), the orchestrator scopes a narrow OpenAI Vision call to just that period's PDF pages, and merges the recovered field back in.
3. Every period is reconciled with deterministic arithmetic (`beginning + Σdeposits − Σwithdrawals = ending`) and surfaced to the UI with a clear pass/fail indicator.

This keeps the wire contract from the original LLM-only pipeline (`ExtractResult[]`, SSE stage events) **byte-identical**, so the OCR-first path is a drop-in upgrade.

## Demo flow

1. User drops a PDF + OCR sidecar into the web UI.
2. The browser opens `POST /api/extract` and starts reading an SSE stream.
3. The API emits stage events as it works (`parse → extract → reconcile`).
4. The UI shows each statement period as a card with:
   - Bank, account last-4, period range
   - Beginning / Ending / Deposits / Withdrawals
   - A visible arithmetic check: `B + ΣD − ΣW = computed ending`, compared to the document's reported ending
   - A source badge: `OCR-deterministic` (zero LLM calls) or `OCR + LLM fallback` (one or more fields recovered via LLM)
   - Expandable transaction list

The whole round trip on the Ixonia fixture takes well under a second.

## Architecture

```
┌────────────────────────────────────────┐
│ Browser (React + Vite + Tailwind)      │
│  • DropZone (PDF + optional sidecar)   │
│  • SSE reader (fetch + ReadableStream) │
│  • PeriodCard with balance-check       │
└──────────────────┬─────────────────────┘
                   │ POST /api/extract  (multipart, returns text/event-stream)
                   ▼
┌────────────────────────────────────────┐
│ Hono API on Node 20                    │
│  • Correlation-ID per request          │
│  • Zod-validated env config            │
│  • Pino logger with PII redaction      │
└──────────────────┬─────────────────────┘
                   ▼
              extractDispatch
        (routes by EXTRACTION_MODE)
        ┌──────────┴────────────┐
        ▼                       ▼
extractWithOcrFirst       extractPdf  (legacy LLM-only)
 (OCR-first / OCR-only)
   • parseOcrSidecar
   • parseSummaryBlock × N
   • parseTransactionsForPeriod × N
     (balance-anchor table-to-period
      assignment)
   • runLlmFallback for null fields only
        ┌──────────┴────────────┐
        ▼                       ▼
   reconcile (deterministic arithmetic)
        ▼
   ExtractResult[]  ──►  SSE result frame
```

**Two contracts that hold everything together:**

- `packages/contracts` — shared Zod schemas (`ExtractResultSchema`, `StageEventSchema`, `ErrorBodySchema`) imported by both API and Web. Wire-format compatibility is a TypeScript-level constraint, not a convention.
- `.specify/memory/constitution.md` — immutable design principles (no cross-period analytics, no hallucinated numbers, reconciliation must surface drift explicitly).

## Key features

- **OCR-first deterministic extraction.** No LLM calls when the sidecar contains the data.
- **Per-field LLM fallback** scoped to specific PDF pages, not the whole document.
- **`EXTRACTION_MODE` env routing** (`ocr-first` / `ocr-only` / `llm-only`) — switch behavior at deploy time without code changes.
- **Balance-anchor table-to-period assignment** — correctly splits same-month statements on different accounts using the in-table `BEGINNING BALANCE` row as a disambiguator.
- **Server-Sent Events for progress** — long extractions stream stage updates back to the UI in real time.
- **Strict JSON-schema enforcement** on every LLM call (`response_format: json_schema, strict: true`, `temperature: 0`).
- **Correlation IDs and PII-redacting logger** — sensitive fields (`amount`, `description`, `sidecarText`) are never logged above `debug` level.
- **63 unit + integration tests** including no-regression on the legacy LLM-only path.
- **Spec-Driven Development workflow** (`/speckit-specify` → `/speckit-plan` → `/speckit-tasks` → `/speckit-implement`) with persistent artifacts in `specs/`.

## Quick start

### Prerequisites

- Node.js **20+**
- pnpm **9.x** (`corepack enable && corepack prepare pnpm@9.12.0 --activate`)
- An OpenAI API key with access to a vision-capable model (default: `gpt-4.1`)

### Local development

```bash
git clone https://github.com/artem1014/bank-statement-extraction-agent.git
cd bank-statement-extraction-agent
pnpm install

cp .env.example .env
# edit .env and set OPENAI_API_KEY=sk-...

# Terminal 1 — API on :8080 (also serves built SPA in production)
pnpm -F @app/api dev

# Terminal 2 — Vite dev server on :5173 with HMR (development only)
pnpm -F @app/web dev
```

Open <http://localhost:5173> and drop a PDF (plus optional `.rtf` / `.txt` sidecar).

### CLI

```bash
# OCR-first run (the happy path: sub-second, $0)
pnpm -F @app/api extract:cli ./Binder2_Redacted.pdf \
  --ocr "./Bank Statement.rtf" \
  --out ./out/result.json

# Force a specific mode
pnpm -F @app/api extract:cli ./Binder2_Redacted.pdf --mode llm-only

# Smoke test that prints a metrics table
pnpm -F @app/api smoke:ocr-first
```

## Configuration

All configuration is environment-driven and validated by Zod at boot. The app refuses to start if anything is malformed.

| Variable                     | Default                  | Purpose                                                                                                  |
| ---------------------------- | ------------------------ | -------------------------------------------------------------------------------------------------------- |
| `OPENAI_API_KEY`             | _(required)_             | OpenAI API key (used only for LLM fallback or `llm-only` mode).                                          |
| `OPENAI_MODEL`               | `gpt-4.1`                | Vision-capable model identifier.                                                                         |
| `EXTRACTION_MODE`            | `ocr-first`              | `ocr-first` (default), `ocr-only` (no LLM ever), or `llm-only` (ignores any sidecar — legacy behaviour). |
| `PORT`                       | `8080`                   | HTTP port.                                                                                               |
| `CORS_ORIGIN`                | `http://localhost:5173`  | Allowed origin for browser requests.                                                                     |
| `MAX_PDF_BYTES`              | `104857600` (100 MB)     | Hard limit on uploaded PDF size.                                                                         |
| `MAX_OCR_BYTES`              | `2097152` (2 MB)         | Hard limit on uploaded OCR sidecar size.                                                                 |
| `OPENAI_CHUNK_BUDGET_BYTES`  | `29360128` (28 MB)       | Max upload chunk for OpenAI Files API (used during LLM fallback page slicing).                           |
| `OPENAI_CHUNK_PAGE_BUDGET`   | `20`                     | Max PDF pages per LLM call.                                                                              |
| `LOG_LEVEL`                  | `info`                   | `fatal` / `error` / `warn` / `info` / `debug` / `trace` / `silent`. Above `debug` PII is redacted.       |
| `VITE_API_BASE_URL`          | _(empty)_                | If set on the web app, used as the API base URL (e.g. `https://api.example.com`).                        |

See [`.env.example`](./.env.example) for the canonical file.

## API reference

### `POST /api/extract`

**Content-Type:** `multipart/form-data`

| Field      | Type   | Required | Description                                                                       |
| ---------- | ------ | -------- | --------------------------------------------------------------------------------- |
| `pdf`      | File   | yes      | The bank statement PDF.                                                           |
| `ocr_text` | File   | no       | Azure Document AI sidecar (`.rtf` or `.txt`). Enables the OCR-first fast path.   |

**Response:** `text/event-stream`

The API streams Server-Sent Events. Three event types are emitted:

```text
event: stage
data: {"stage":"parse","status":"running"}

event: stage
data: {"stage":"extract","status":"running","detail":"mode=ocr-first: parsing 10 periods"}

event: result
data: {"periods":[ ...ExtractResult[] ]}
```

If the pipeline fails, the last frame is:

```text
event: error
data: {"code":"OCR_SIDECAR_INVALID","message":"...","requestId":"<uuid>"}
```

Every response includes an `X-Request-Id` header with a UUID — quote it when reporting issues; logs are indexed by it.

### Error codes (from `packages/contracts/src/errors.ts`)

- `BAD_FILE` — wrong file type, too large, or malformed multipart.
- `OCR_SIDECAR_INVALID` — sidecar had no recognisable periods.
- `OCR_SIDECAR_TOO_LARGE` — sidecar exceeded `MAX_OCR_BYTES`.
- `LLM_UNAVAILABLE` — OpenAI returned 5xx / 429 / network failure.
- `EXTRACTION_FAILED` — unexpected internal error.

### `GET /api/health`

Returns `200 OK` with a small JSON payload. Use this for liveness / readiness probes.

## Project structure

```
bank-statement-extraction-agent/
├── apps/
│   ├── api/                          # Hono backend
│   │   ├── src/
│   │   │   ├── pipeline/
│   │   │   │   ├── extract.ts        # extractDispatch — mode routing
│   │   │   │   ├── ocr-sidecar.ts    # parses .rtf / .txt
│   │   │   │   ├── ocr-summary-parser.ts
│   │   │   │   ├── ocr-tx-parser.ts  # incl. balance-anchor assignment
│   │   │   │   ├── ocr-orchestrator.ts
│   │   │   │   ├── pdf-splitter.ts   # pdf-lib page-range slicing
│   │   │   │   ├── openai-client.ts  # Responses API + strict json_schema
│   │   │   │   ├── reconcile.ts      # deterministic arithmetic
│   │   │   │   └── stage-emitter.ts  # SSE writer
│   │   │   ├── routes/
│   │   │   │   ├── extract.ts        # POST /api/extract
│   │   │   │   └── health.ts
│   │   │   ├── utils/
│   │   │   │   ├── text-normalize.ts # OCR repair for money/dates
│   │   │   │   ├── correlation.ts
│   │   │   │   └── logger.ts         # Pino + PII redaction
│   │   │   ├── domain/               # types + typed errors
│   │   │   ├── config.ts             # Zod-validated env
│   │   │   └── index.ts              # entry point
│   │   ├── tests/
│   │   │   ├── unit/                 # parsers, normalizers
│   │   │   └── integration/          # extractDispatch with stubbed OpenAI
│   │   └── scripts/                  # CLI + smoke harness
│   └── web/                          # React + Vite + Tailwind
│       └── src/
│           ├── features/extraction/
│           │   ├── components/       # DropZone, StageList, PeriodCard
│           │   ├── hooks/useExtract.ts
│           │   └── lib/sse.ts        # fetch + ReadableStream SSE reader
│           └── shared/               # ui (shadcn-style), lib, api
├── packages/
│   ├── contracts/                    # shared Zod schemas (wire contract)
│   └── tsconfig/                     # shared TS presets
├── specs/
│   ├── 001-pdf-statement-extractor/  # original LLM-only feature
│   └── 002-ocr-first-extraction/     # OCR-first + per-field fallback
├── .specify/memory/constitution.md   # immutable design principles
├── Dockerfile                        # single multi-stage image
└── README.md
```

## Testing

```bash
# All workspaces, all tests
pnpm test

# Just the API
pnpm -F @app/api test

# Watch mode (vitest --watch)
pnpm -F @app/api test --watch

# Smoke run against the fixture (no asserts, prints a table)
pnpm -F @app/api smoke:ocr-first
```

The test suite is split into two layers:

- **Unit** — parsers, normalizers, balance-anchor assignment, regex repair cases. Fast (< 100 ms each).
- **Integration** — boot `extractDispatch` with a stub OpenAI client that throws if called. The OCR-first happy-path tests assert that the LLM is never invoked. The partial-sidecar tests assert that LLM fallback fires for one specific period and leaves the other nine OCR-deterministic. The sidecar-mismatch test asserts that the heuristic surfaces a warning when the sidecar's `account_last4` cannot be found in the PDF.

All 63 tests must pass on every commit. Husky + Biome enforce formatting / linting on `git commit`.

## Deployment

The repo ships a working, single-container `Dockerfile` (multi-stage, ~80 MB final image) that builds all workspaces and serves both the API and the SPA static bundle on the same port.

### One-click: Render.com

1. Push to a public GitHub repo.
2. On [render.com](https://render.com): **New + → Web Service** and select the repo.
3. Render auto-detects the `Dockerfile`. Choose the free plan if you just want to demo.
4. Add a single environment variable: `OPENAI_API_KEY`.
5. Click **Create Web Service**. After ~5 minutes you'll get a public URL.

The free plan sleeps after 15 minutes of inactivity and cold-starts in ~30 seconds, which is fine for demos.

### Fly.io (CLI)

```bash
brew install flyctl
fly auth signup
fly launch --no-deploy            # generates fly.toml from Dockerfile
fly secrets set OPENAI_API_KEY=sk-...
fly deploy
```

### Local Docker

```bash
docker build -t bank-extractor .
docker run -p 8080:8080 -e OPENAI_API_KEY=sk-... bank-extractor
open http://localhost:8080
```

## Performance

Reference fixture: **Ixonia bank statement, 99 pages, 10 statement periods, ~1,500 transactions, 2 accounts**.

| Path                        | Wall clock | OpenAI cost  | Transaction recall |
| --------------------------- | ---------- | ------------ | ------------------ |
| Legacy LLM-only             | ~17 min    | ~$8–15       | 70–95%             |
| OCR-first (happy path)      | < 1 sec    | $0           | 95–100%            |
| OCR-first with one fallback | 5–10 sec   | ~$0.10–0.30  | 95–100%            |

The arithmetic check (`B + ΣD − ΣW = E`) passes exactly on ~half of the Ixonia periods. The remaining drift on this specific fixture is **structural**: the bank reports separate Service Charges / Other Credits / Other Debits / Interest categories that don't yet fit the `Deposits/Withdrawals`-only schema. This is surfaced loudly in the UI (orange badge, explanatory caption) and tracked as feature 003.

## Known limitations

- **Reconciliation drift on banks with non-Deposits/Withdrawals categories** (Service Charges, Other Credits, Other Debits, Fees, Interest). The numbers themselves are correct — the schema just doesn't decompose them yet. Planned for feature 003.
- **Continuation-row recall** — when Document AI splits a transaction across a page boundary, the second line may be merged into the previous description rather than promoted to its own row. Affects ~5% of rows on the reference fixture.
- **PDF-sidecar mismatch heuristic** is byte-sample-based; on fully image-only PDFs without any extractable text, it may emit a false-positive `sidecar-pdf-mismatch` warning. Extraction is not blocked by this warning.
- **Only Azure Document AI `prebuilt-document`** sidecars are supported (`.rtf` and `.txt`). Other OCR vendors are explicitly future work.

## Specification-driven workflow

Every feature in this repo went through a four-stage process before any code was written:

1. `/speckit-specify` — user stories, functional + non-functional requirements, acceptance criteria, open questions.
2. `/speckit-clarify` — resolve open questions interactively, lock decisions into the spec.
3. `/speckit-plan` — technical context, constitution check, research, data model, internal contracts.
4. `/speckit-tasks` — break the plan into atomic, dependency-ordered tasks.

Artifacts live in `specs/<feature-id>/`. The spec is the source of truth; code that drifts from the spec is treated as a bug.

## License

ISC

## Credits

Built as a portfolio / interview-demo project on top of TypeScript, Hono, React, Vite, Zod, pdf-lib, pnpm workspaces, Turborepo, and the OpenAI Responses API. OCR sidecars are produced by Azure AI Document Intelligence (`prebuilt-document` mode).

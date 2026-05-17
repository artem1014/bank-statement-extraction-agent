# Implementation Plan: PDF Bank Statement Extractor

**Branch**: `001-pdf-statement-extractor` | **Date**: 2026-05-17 | **Spec**: [spec.md](./spec.md)
**Input**: Feature specification from `/specs/001-pdf-statement-extractor/spec.md`

## Summary

Web-приложение для извлечения структурированного JSON из single-period PDF банковской
выписки. Пользователь загружает PDF (опц. + OCR-текст), бэкенд восстанавливает текст,
вызывает Anthropic Claude с tool-use для schema-enforced вывода, валидирует ответ
через Zod, детерминированно выполняет арифметическую сверку (`beginning + Σdep − Σwd =
ending` с допуском $0.01) и стримит прогресс по 4 стадиям через Server-Sent Events.
Фронтенд показывает Account/Summary карточки, баннер сверки и searchable/sortable
таблицу транзакций; кнопки Copy JSON / Download JSON отдают канонический результат.

**Технический подход** (см. `research.md` для обоснования): TypeScript-only монорепо
на `pnpm workspaces` + `turbo`, бэкенд на Hono (Node.js 20), фронт на Vite + React 18
+ Tailwind + shadcn/ui + TanStack Query/Table, единый Zod-контракт в
`packages/contracts`. Денежная арифметика — через `decimal.js`. PDF → текст через
`unpdf`. Логирование — `pino` (с redact для секретов). Тесты — `vitest` + Playwright
e2e. CI на GitHub Actions: `lint → typecheck → test → build`.

## Technical Context

**Language/Version**: TypeScript 5.4+ (strict mode: `noImplicitAny`, `strictNullChecks`, `noUncheckedIndexedAccess`)
**Runtime**: Node.js 20+ LTS (backend), modern evergreen browsers (frontend)
**Primary Dependencies**:

- Backend: `hono@^4`, `@anthropic-ai/sdk@^0.27`, `unpdf@^0.12`, `zod@^3.23`, `decimal.js@^10`, `pino@^9`, `pino-http@^10`
- Frontend: `react@^18`, `react-dom@^18`, `vite@^5`, `tailwindcss@^3`, `@tanstack/react-query@^5`, `@tanstack/react-table@^8`, `react-dropzone@^14`, `@radix-ui/*` (через shadcn/ui), `lucide-react`
- Shared: `zod@^3.23`
- Tooling: `pnpm@^9`, `turbo@^2`, `biome@^1.9`, `vitest@^2`, `@playwright/test@^1.46`, `husky@^9`, `lint-staged@^15`

**Storage**: None. Загруженные файлы обрабатываются in-memory и не персистируются (FR-028, constitution §V Security).
**Testing**: `vitest` (unit + integration), `@testing-library/react` (component), `@playwright/test` (one e2e smoke)
**Target Platform**: Linux container for the API (Docker), static hosting for the SPA (e.g. Cloudflare Pages / Vercel / Netlify / S3+CloudFront — deployment target out of scope, but the build is a plain static bundle).
**Project Type**: Web application (frontend + backend) within a TypeScript monorepo
**Performance Goals**:

- p95 `/api/extract` end-to-end ≤ 20s for ≤10-page statements (NFR-1, SC-004)
- Frontend TTI ≤ 2s desktop / 4G (NFR-2)
- Frontend initial JS bundle ≤ 250 KB gzipped (NFR-3)

**Constraints**:

- Document-grounded only (constitution §I) — no fabricated values; every transaction carries `source_span`.
- Reconciliation is deterministic in code, not in LLM (constitution §II).
- No bank-specific code paths (constitution §III) — generalisation via prompts/schema only.
- Strict typing end-to-end via shared Zod schema (constitution §IV).
- LLM call: `temperature: 0`, fixed seed if supported (constitution §V).
- In-memory file handling, ≤10 MB PDF / ≤2 MB OCR (FR-004, NFR-9).
- Last 2 versions of Chrome/Firefox/Safari/Edge (NFR-14).

**Scale/Scope**: Single-operator demo tool. Concurrency target: ~10 simultaneous extractions on a 1 vCPU / 1 GB container (sufficient for evaluator scenario). Not a multi-tenant SaaS.

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

| Constitution requirement | Status | How this plan satisfies it |
|---|---|---|
| **I. Document-grounded only** | ✅ Pass | All values in `ExtractResult` come from the LLM constrained by Zod; each `Transaction` carries `source_span` (page+region or OCR char range). Missing/ambiguous values → `null` + entry in `extraction.warnings[]`. Tool-use schema explicitly requires `source_span`. |
| **II. Reconciliation non-negotiable** | ✅ Pass | `apps/api/src/pipeline/reconcile.ts` runs *after* the LLM call, uses `decimal.js` arithmetic, sets `summary.reconciliation = { ok, delta, expected_ending }` and never throws on mismatch. HTTP stays 200, UI shows red banner (FR-014/024). |
| **III. Generalisation via prompts & schema** | ✅ Pass | No bank-specific code paths in `pipeline/`. All recognition heuristics live in versioned `apps/api/prompts/*.md` (`prompt_version` returned in response). Few-shot examples in `prompts/examples/`. |
| **IV. Strict typing end-to-end** | ✅ Pass | Single Zod source in `packages/contracts/src/schemas.ts`; types inferred via `z.infer` and consumed by both `apps/api` and `apps/web`. LLM response parsed through the same Zod schema; invalid → `SchemaValidationError` after 1 retry (FR-008). |
| **V. Deterministic where possible** | ✅ Pass | LLM client called with `temperature: 0`. `reconcile.ts`, `money.ts` and formatters are pure functions; covered by deterministic unit/snapshot tests. |
| **§II. Architecture (data flow)** | ✅ Pass | Pipeline stages match the diagram: preprocess → chunk → llm → schema-validate → reconcile → enrich. Each stage emits an SSE event for UI progress (FR-017). |
| **§III. Tech stack** | ✅ Pass | Backend stack (Node 20 + Hono + TS + Anthropic SDK + Zod + decimal.js + pino + vitest) and frontend stack (Vite + React 18 + TS + TanStack Query/Table + shadcn/ui + Tailwind + vitest + Playwright) match the constitution. Linter: Biome (one of two permitted options). |
| **§V Code quality / strict TS** | ✅ Pass | `tsconfig` base in `packages/tsconfig` with `strict: true`, `noUncheckedIndexedAccess`, etc.; functions ≤ 50 lines (enforced by review, not by lint to avoid false positives). |
| **§V Testing strategy** | ✅ Pass | Unit tests required for `reconcile.ts`, `money.ts`; integration tests for the pipeline with mocked LLM and ≥ 2 fixtures (Ixonia + 1 other bank); 1 Playwright smoke. |
| **§V Prompt management** | ✅ Pass | Prompts in `apps/api/src/prompts/*.md`, each with `prompt_version` frontmatter; few-shot examples in `prompts/examples/`. |
| **§V Error handling** | ✅ Pass | Typed errors: `BAD_FILE`, `EXTRACTION_FAILED`, `LLM_UNAVAILABLE`, `RECONCILIATION_FAILED` (data-field, not HTTP). No stack traces in user-facing responses (FR-027). |
| **§V Security** | ✅ Pass | MIME validation server-side (FR-003); 10 MB cap (FR-004); in-memory only (FR-028); CORS limited to web origin (FR-029); logs redact secrets (`pino` redact paths) and never include statement contents (FR-030, NFR-13); Anthropic key only via env (FR-031). |
| **§V Performance budgets** | ✅ Pass | p95 ≤ 20s extract (NFR-1) — within typical Sonnet 4.6 latency for 10-page input; bundle target ≤ 250 KB gzipped enforced by `vite build` size check in CI. |
| **§VII Out of scope** | ✅ Pass | No auth, no DB, no non-PDF formats, no categorisation, no multi-period support. Plan stays inside the perimeter. |

**Verdict**: All gates pass. No complexity violations to track.

## Project Structure

### Documentation (this feature)

```text
specs/001-pdf-statement-extractor/
├── plan.md              # This file (Phase 0/1 output)
├── spec.md              # Created by /speckit-specify
├── research.md          # Phase 0 output — open questions resolved
├── data-model.md        # Phase 1 output — entity model + Zod schema
├── quickstart.md        # Phase 1 output — dev/test/build instructions
├── contracts/
│   ├── http.md          # POST /api/extract, GET /api/health
│   ├── sse-events.md    # Server-Sent Events shape
│   ├── extract-result.schema.json   # JSON Schema (generated from Zod)
│   └── prompt-contract.md           # LLM tool-use contract
├── checklists/
│   └── requirements.md  # From /speckit-specify
└── tasks.md             # Phase 2 output (/speckit-tasks — NOT created here)
```

### Source Code (repository root)

```text
.
├── apps/
│   ├── api/                                  # Hono backend
│   │   ├── src/
│   │   │   ├── index.ts                      # app entry, env config bootstrap
│   │   │   ├── config.ts                     # env via zod (typed)
│   │   │   ├── routes/
│   │   │   │   ├── extract.ts                # POST /api/extract (SSE stream)
│   │   │   │   └── health.ts                 # GET /api/health
│   │   │   ├── pipeline/
│   │   │   │   ├── extract.ts                # orchestrator
│   │   │   │   ├── preprocess.ts             # PDF → text via unpdf
│   │   │   │   ├── chunk.ts                  # page chunking helper
│   │   │   │   ├── llm-client.ts             # Anthropic SDK adapter
│   │   │   │   ├── reconcile.ts              # deterministic balance check
│   │   │   │   └── stage-emitter.ts          # SSE progress helper
│   │   │   ├── prompts/
│   │   │   │   ├── system.md                 # role + non-negotiables
│   │   │   │   ├── extraction.md             # how to extract (single bank-agnostic)
│   │   │   │   └── examples/
│   │   │   │       ├── ixonia.md             # few-shot — known bank
│   │   │   │       └── generic.md            # few-shot — neutral bank
│   │   │   ├── domain/
│   │   │   │   ├── errors.ts                 # BadFile, ExtractionFailed, LlmUnavailable
│   │   │   │   └── types.ts                  # re-export from @app/contracts
│   │   │   └── utils/
│   │   │       ├── money.ts                  # Decimal helpers
│   │   │       ├── logger.ts                 # pino instance with redact
│   │   │       └── mime.ts                   # magic-byte sniffing
│   │   ├── tests/
│   │   │   ├── unit/
│   │   │   │   ├── reconcile.test.ts
│   │   │   │   ├── money.test.ts
│   │   │   │   └── mime.test.ts
│   │   │   ├── integration/
│   │   │   │   ├── extract.test.ts           # pipeline with mocked LLM
│   │   │   │   └── sse.test.ts               # SSE event ordering
│   │   │   └── fixtures/
│   │   │       ├── ixonia.pdf
│   │   │       ├── ixonia.ocr.txt
│   │   │       ├── ixonia.expected.json
│   │   │       ├── unseen-bank-1.pdf
│   │   │       └── unseen-bank-1.expected.json
│   │   ├── Dockerfile
│   │   ├── package.json
│   │   └── tsconfig.json
│   │
│   └── web/                                  # Vite + React 18 SPA
│       ├── src/
│       │   ├── main.tsx
│       │   ├── App.tsx
│       │   ├── features/extraction/
│       │   │   ├── api/
│       │   │   │   └── useExtract.ts         # SSE consumer + TanStack Query mutation
│       │   │   ├── components/
│       │   │   │   ├── FileDropzone.tsx
│       │   │   │   ├── ProgressStages.tsx
│       │   │   │   ├── AccountCard.tsx
│       │   │   │   ├── SummaryCard.tsx
│       │   │   │   ├── ReconciliationBanner.tsx
│       │   │   │   ├── TransactionsTable.tsx
│       │   │   │   └── ResultActions.tsx     # Copy JSON / Download JSON
│       │   │   └── hooks/
│       │   │       └── useFileUpload.ts
│       │   ├── shared/
│       │   │   ├── ui/                       # shadcn-generated primitives
│       │   │   ├── lib/
│       │   │   │   ├── format.ts             # money + date formatting
│       │   │   │   └── download.ts
│       │   │   └── api/
│       │   │       └── client.ts             # fetch wrapper + SSE helper
│       │   └── styles/
│       │       └── globals.css
│       ├── public/
│       ├── tests/
│       │   ├── unit/
│       │   │   ├── format.test.ts
│       │   │   └── TransactionsTable.test.tsx
│       │   └── e2e/
│       │       └── extract-ixonia.spec.ts    # Playwright smoke
│       ├── index.html
│       ├── vite.config.ts
│       ├── playwright.config.ts
│       ├── package.json
│       └── tsconfig.json
│
├── packages/
│   ├── contracts/                            # Single source of truth (Zod + JSON Schema)
│   │   ├── src/
│   │   │   ├── schemas.ts                    # Account, Summary, Reconciliation, Transaction, ExtractResult
│   │   │   ├── errors.ts                     # ErrorCode union
│   │   │   ├── sse.ts                        # StageEvent / ResultEvent / ErrorEvent
│   │   │   └── index.ts
│   │   ├── tests/
│   │   │   └── schemas.test.ts               # round-trip parse tests
│   │   ├── package.json
│   │   └── tsconfig.json
│   │
│   └── tsconfig/                             # shared tsconfig base
│       ├── base.json
│       ├── node.json
│       └── react.json
│
├── .github/workflows/
│   └── ci.yml                                # lint → typecheck → test → build
├── biome.json
├── pnpm-workspace.yaml
├── turbo.json
├── package.json                              # root workspace
└── .env.example                              # ANTHROPIC_API_KEY, PORT, CORS_ORIGIN
```

**Structure Decision**: Web application (constitution §II). Implemented as a TypeScript monorepo with `apps/api`, `apps/web`, and a shared `packages/contracts` package that owns Zod schemas and inferred types. A shared `packages/tsconfig` keeps strict-TS settings consistent across packages. `pnpm workspaces` + `turbo` provide install/build/cache orchestration. Source of truth for the data contract is `packages/contracts/src/schemas.ts` (constitution §IV).

## Complexity Tracking

> No constitution violations. Nothing to justify.

| Violation | Why Needed | Simpler Alternative Rejected Because |
|-----------|------------|--------------------------------------|
| *(none)* | — | — |

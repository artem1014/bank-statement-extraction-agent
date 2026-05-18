# Quickstart — PDF Bank Statement Extractor

**Feature**: 001-pdf-statement-extractor
**Audience**: a developer cloning the repo for the first time, or an evaluator
preparing the demo session described in spec §SC-008 / constitution §VI.

This document is a runbook. It does not duplicate the architecture (see
`plan.md`) or the data contract (see `data-model.md`).

## Prerequisites

| Tool | Version | Why |
|---|---|---|
| Node.js | 20.x LTS | Backend runtime; matches CI matrix. |
| pnpm | ≥ 9 | Workspace package manager (constitution §II). |
| git | any modern | Source control. |
| Docker (optional) | 24+ | For `docker run` of the API container, otherwise unused. |
| An Anthropic API key | — | Required to actually call the LLM. Tests run without one (LLM is mocked in integration tests). |

Install `pnpm` if missing:

```bash
corepack enable
corepack prepare pnpm@latest --activate
```

## First-time setup

```bash
git clone https://github.com/artem1014/bank-statement-extraction-agent.git
cd bank-statement-extraction-agent
git checkout 001-pdf-statement-extractor

pnpm install --frozen-lockfile

cp .env.example .env
$EDITOR .env
```

Fill in at minimum:

```ini
ANTHROPIC_API_KEY=sk-ant-...
CORS_ORIGIN=http://localhost:5173
```

All other variables have sensible defaults (see `apps/api/src/config.ts`).

## Run it locally (dev mode, both apps)

```bash
pnpm dev
```

This runs (via `turbo run dev --parallel`):

- `apps/api` on `http://localhost:8080` (Hono with file-watch reload),
- `apps/web` on `http://localhost:5173` (Vite dev server with HMR),
- `packages/contracts` in watch mode (tsc emit so the two apps see fresh types).

Open `http://localhost:5173`. The landing page shows the drag-and-drop zone described
in spec §User Story 1.

## End-to-end smoke (Ixonia fixture)

The repo ships the Ixonia reference fixture under
`apps/api/tests/fixtures/`. To run the canonical demo path **with a real LLM call**:

1. Ensure `pnpm dev` is running with a valid `ANTHROPIC_API_KEY`.
2. In the browser, drop `apps/api/tests/fixtures/ixonia.pdf` and (optionally)
   `apps/api/tests/fixtures/ixonia.ocr.txt` into the dropzone.
3. Click **Extract Statement**.
4. Watch the four progress stages reach `done`.
5. Verify:
   - Account card: **Ixonia Bank ••••4664   Apr 1 – Apr 30, 2025**.
   - Summary card: six values match the reference (see spec §AC-1).
   - Reconciliation badge is **green** (`ok: true`).
   - Transactions table contains exactly **192** rows.
   - **Copy JSON** copies a payload that validates against
     `specs/001-pdf-statement-extractor/contracts/extract-result.schema.json`.

Total wall-clock time should be **≤ 20 s** (SC-004).

## Tests

```bash
pnpm lint          # biome check
pnpm typecheck     # tsc --noEmit across workspaces
pnpm test          # vitest, all packages
pnpm test:e2e      # Playwright smoke (requires `pnpm build` + `pnpm preview`)
```

Granular variants:

```bash
pnpm -F @app/api test               # backend unit + integration only
pnpm -F @app/web test               # frontend unit + component tests only
pnpm -F @app/contracts test         # shared schema round-trip tests
```

Integration tests **do not** hit Anthropic; the `llm-client` adapter is replaced by a
recorded-response fake (one recording per fixture). See R-13 in `research.md`.

## Build & run production

```bash
pnpm build         # turbo build — emits apps/api/dist and apps/web/dist
pnpm start         # node apps/api/dist/index.js
```

Or with Docker (API only; the SPA is a static bundle):

```bash
docker build -t bse-api -f apps/api/Dockerfile .
docker run --rm -p 8080:8080 --env-file .env bse-api
```

Serve `apps/web/dist` from any static host and point `VITE_API_BASE_URL` at the API.

## Regenerating the JSON Schema

After editing `packages/contracts/src/schemas.ts`:

```bash
pnpm -F @app/contracts run gen-schema
```

This rewrites
`specs/001-pdf-statement-extractor/contracts/extract-result.schema.json`. CI fails the
build if this command produces a diff (i.e. the committed schema is stale).

## Adding support for a new bank

Per constitution §III: **no code change is required**. The procedure is:

1. Add a new few-shot example: `apps/api/src/prompts/examples/<bank-slug>.md`
   following the template (frontmatter + a small fragment of source text + the
   `submit_extraction` tool arguments).
2. Reference the new file from `apps/api/src/prompts/extraction.md` (the file lists
   the active few-shot examples).
3. Bump `prompt_version` in the frontmatter of `extraction.md` (e.g. `v1.0.0` →
   `v1.1.0`).
4. Add an `apps/api/tests/fixtures/<bank-slug>/{pdf,expected.json,ocr.txt?}` and a new
   integration test case wiring them up.
5. Run `pnpm test` and confirm both the new test and the existing ones still pass.
6. Open a PR titled `feat(prompts): support <Bank Name>`. Code review verifies no
   files outside `apps/api/src/prompts/`, `apps/api/tests/fixtures/`, and the test
   file itself were changed (this is the mechanical "no bank-specific code" check).

If at any point the temptation arises to special-case a bank in `pipeline/*.ts` — stop
and re-write the prompt instead.

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| `ANTHROPIC_API_KEY missing` at boot | `.env` not loaded or variable missing | Recreate from `.env.example`. The server fails fast at boot rather than at first request. |
| Browser shows `BAD_FILE` immediately on upload | Client-side magic-byte check failed (file isn't a PDF) | Re-export the source PDF, ensure it begins with `%PDF-`. |
| Browser stays on `extract: active` for > 60 s, no UI updates | Backend connection dropped silently — likely a reverse proxy buffering SSE | Disable response buffering for `/api/extract` (e.g. nginx `proxy_buffering off;`) or run without the proxy. |
| Reconciliation badge is red but transactions look correct | LLM returned values that don't sum to `ending_balance` within $0.01 | This is the expected behaviour (User Story 2). Inspect the warnings list and the printed delta; the JSON is still valid and downloadable. |
| `pnpm dev` shows TypeScript errors from `@app/contracts` | The contracts package hasn't emitted yet | Wait a few seconds, or run `pnpm -F @app/contracts build` once. |
| CI fails on `contracts schema check` | Committed `extract-result.schema.json` is out of date | Run `pnpm -F @app/contracts run gen-schema` and commit the regenerated file. |

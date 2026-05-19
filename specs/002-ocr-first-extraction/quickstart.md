# Quickstart: OCR-First Extraction Pipeline

**Feature**: 002-ocr-first-extraction
**Audience**: Developers picking up this feature for implementation, review, or smoke-testing.
**Prerequisite**: Feature 001 working in your local environment (`pnpm install && pnpm typecheck && pnpm test` should be green on `main`).

---

## 0. Environment

Add the new env var to your `.env`:

```sh
# .env
OPENAI_API_KEY=sk-...
MAX_PDF_BYTES=104857600      # 100 MB
MAX_OCR_BYTES=2097152        # 2 MB (existing)
EXTRACTION_MODE=ocr-first    # NEW — defaults to ocr-first if omitted
```

Valid values for `EXTRACTION_MODE`: `ocr-first` (default), `ocr-only`, `llm-only`. See `contracts/extraction-mode.md` for the full routing matrix.

---

## 1. Install + sanity-check

```sh
pnpm install
pnpm typecheck
pnpm test
```

Expected: **29 baseline tests pass** (the existing feature-001 suite, unchanged), plus the new suites described in §4 below as you implement them. Once the feature is complete, total green count is **29 + 14 = 43** unit tests + 3 new integration tests.

---

## 2. Run the OCR-first happy path via CLI

```sh
pnpm -F @app/api extract:cli \
  ./Binder2_Redacted.pdf \
  --ocr "./Bank Statement.rtf" \
  --out ./out/v2.json
```

**Acceptance** (matches SC-001..SC-005 from spec):

- Wall-clock duration printed at the end: **≤ 5 seconds**.
- `cat ./out/v2.json | jq 'length'` → `10`.
- `cat ./out/v2.json | jq '[.[] | .extraction.warnings | length] | add'` shows the total fallback count; on the full-Ixonia fixture this should be **0** (no LLM calls fired) — verify with `cat ./out/v2.json | jq '[.[] | .extraction.model] | unique'` returning `["ocr-deterministic"]`.
- `cat ./out/v2.json | jq '[.[] | .summary.reconciliation.ok]'` shows the same reconciliation pattern as feature 001's `out/Binder2_ocr.json` — drift is **structural** (per period 002 spec's §"Out of Scope #3" note about SummarySchema), not a parser bug.

---

## 3. Run the partial-sidecar fallback path

Test the per-period LLM-fallback escalator (SC-005):

```sh
# Make a copy of the sidecar with the May 2025 summary block surgically removed.
cp "Bank Statement.rtf" "Bank Statement.may-removed.rtf"
# Manually delete the block between "Beginning Balance as of 05/01/2025" and
# "Ending Balance as of 05/31/2025" in your editor, OR use the helper script:
pnpm -F @app/api scripts:make-fallback-fixture \
  --in "Bank Statement.rtf" \
  --remove-period 2025-05 \
  --out "Bank Statement.may-removed.rtf"

pnpm -F @app/api extract:cli \
  ./Binder2_Redacted.pdf \
  --ocr "./Bank Statement.may-removed.rtf" \
  --out ./out/v2-partial.json
```

**Acceptance**:

- All 10 periods present.
- Exactly **one** period (May 2025) has `extraction.model` containing `ocr+gpt-4.1` and `extraction.warnings` containing entries of the form `recovered-via-llm: summary.*`.
- The other 9 periods retain `extraction.model === 'ocr-deterministic'` and zero `recovered-via-llm:` warnings.
- Wall-clock duration: ~5 s + one LLM round-trip (~30–60 s on a 6-page period).

---

## 4. Test suites you should expect

| Suite | File | What it proves |
|---|---|---|
| `text-normalize.test.ts` | `apps/api/tests/unit/text-normalize.test.ts` | FR-011 closed-set repair rules; covers `O→0`, `l→1`, internal whitespace, ambiguous-token rejection |
| `ocr-summary-parser.test.ts` | `apps/api/tests/unit/ocr-summary-parser.test.ts` | FR-001/FR-002 summary recovery on real-fixture slices |
| `ocr-tx-parser.test.ts` | `apps/api/tests/unit/ocr-tx-parser.test.ts` | FR-003 table-grid parsing, continuation-row merging, ambiguous-direction handling |
| `extract-ocr-first.test.ts` | `apps/api/tests/integration/extract-ocr-first.test.ts` | SC-001/SC-002/SC-004 — full Ixonia fixture, zero LLM calls, ≤5s |
| `extract-partial-sidecar.test.ts` | `apps/api/tests/integration/extract-partial-sidecar.test.ts` | SC-005 — single-period LLM fallback merges in, other 9 stay OCR-only |
| `extract-sidecar-mismatch.test.ts` | `apps/api/tests/integration/extract-sidecar-mismatch.test.ts` | FR-008 — sidecar from a different PDF is detected and reported |

All integration tests use the existing fixture `Binder2_Redacted.pdf` + `Bank Statement.rtf` from the repo root.

---

## 5. Run the Web UI end-to-end

```sh
pnpm -F @app/api dev    # terminal 1
pnpm -F @app/web dev    # terminal 2
```

In the browser:
1. Drag `Binder2_Redacted.pdf` into the PDF dropzone.
2. Drag `Bank Statement.rtf` into the OCR dropzone.
3. Click **Extract**.

**Expected UI behaviour**:
- The progress stage list shows `mode-resolved` (`ocr-first`), `indexing-complete` (10 periods), and 10 × `period-done` events within ~5 s.
- Each `PeriodCard` shows the badge **"OCR-deterministic"** (or **"OCR + LLM fallback"** when any field for that period was LLM-recovered) — per FR-012.
- "Download JSON" produces the same payload as `./out/v2.json` from §2.

---

## 6. Verify mode switching

```sh
EXTRACTION_MODE=llm-only pnpm -F @app/api extract:cli \
  ./Binder2_Redacted.pdf \
  --ocr "./Bank Statement.rtf" \
  --out ./out/v2-llm-only.json
```

**Expected**:
- Sidecar is **ignored**.
- Every `ExtractResult.extraction.warnings` contains `llm-only-mode-ignored-sidecar`.
- Wall-clock duration matches the feature-001 baseline (~17 minutes for 99-page Ixonia).
- Output (modulo timestamps) matches `./out/Binder2_ocr.json` from feature 001 — proving SC-006 (no regression to the legacy path).

```sh
EXTRACTION_MODE=ocr-only pnpm -F @app/api extract:cli \
  ./Binder2_Redacted.pdf \
  --ocr "./Bank Statement.rtf" \
  --out ./out/v2-ocr-only.json
```

**Expected**:
- Zero OpenAI calls (even if sidecar is partial).
- Any field that OCR couldn't recover surfaces as `null` + warning `ocr-only-missing: <field>`.

---

## 7. Debug the redaction (FR-013)

Trigger a deliberate failure to inspect log output:

```sh
LOG_LEVEL=info \
EXTRACTION_MODE=ocr-first \
  pnpm -F @app/api extract:cli ./Binder2_Redacted.pdf --ocr ./does-not-exist.rtf
```

**Expected**:
- Stderr shows the user-facing error message ending in `Reference: <uuid>`.
- `info`+ log lines contain the `requestId` field but **no** raw sidecar contents.

```sh
LOG_LEVEL=debug \
EXTRACTION_MODE=ocr-first \
  pnpm -F @app/api extract:cli ./Binder2_Redacted.pdf --ocr "./Bank Statement.rtf"
```

**Expected**:
- `debug` log lines contain bounded sidecar slices (per-period line ranges, hash of first 200 chars).
- The same `requestId` correlates the request from start to finish.

---

## 8. Common pitfalls

| Symptom | Likely cause | Fix |
|---|---|---|
| `EXTRACTION_MODE` is set but ignored | env not loaded — check `dotenv` is loading `.env` from repo root | run `pnpm -F @app/api extract:cli --help` to see resolved config |
| Single-period output instead of 10 | sidecar is from the wrong PDF, or `MAX_OCR_BYTES` truncated it | check `MAX_OCR_BYTES`; verify sidecar size with `wc -c` |
| OCR happy path but reconciliation drift on every period | this is **expected** on Ixonia — the bank statement has Other Credits / Other Debits categories not covered by the current `SummarySchema`. Feature 003 (not in this scope) will fix the schema. | n/a — surface the drift, don't suppress it |
| All 10 periods routed to LLM fallback | `EXTRACTION_MODE` is set to `llm-only`, or sidecar didn't parse | check the `mode-resolved` SSE event in the Web UI / `info` logs |

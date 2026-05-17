# Feature Specification: PDF Bank Statement Extractor

**Feature Branch**: `001-pdf-statement-extractor`
**Created**: 2026-05-17
**Status**: Draft
**Input**: User description: «Extract structured JSON from a PDF bank statement (single- or multi-period) with web UI, progress stages, and deterministic reconciliation. Output is an array of per-period results.»

## User Scenarios & Testing *(mandatory)*

### User Story 1 — Extract a single-period statement into a usable summary and transaction list (Priority: P1)

A financial analyst receives a one-month PDF bank statement (optionally accompanied by an OCR text file) and needs to obtain, within seconds, a structured representation of the account, the period, the six headline totals (beginning/ending balance, deposits total & count, withdrawals total & count) and the full list of transactions in a searchable, sortable table — without manual re-keying, and without losing trust in the numbers.

**Why this priority**: This is the entire reason the product exists. Without this path working end-to-end on a real statement, no other capability is meaningful. It is also the slice that an evaluator will exercise first in the demo session.

**Independent Test**: Drop the Ixonia sample PDF + its OCR text into the upload area, click Extract, and verify the result page shows the correct bank, last-4 digits, period, all six summary values matching the reference exactly, a green «reconciled» badge, and 192 transactions in the table.

**Acceptance Scenarios**:

1. **Given** the user is on the landing page and has a valid single-period PDF statement (≤ 10 MB), **When** they drop the file and trigger extraction, **Then** within 20 seconds they see an Account card, a Summary card with reconciliation badge, and a Transactions table populated with every transaction from the statement.
2. **Given** the extraction has completed successfully, **When** the user clicks «Copy JSON» or «Download JSON», **Then** the canonical structured result is placed on the clipboard or saved as `<bank>_<period>.json` and conforms to the project data contract (see Key Entities below).
3. **Given** the user provided both a PDF and a corresponding OCR text file, **When** extraction runs, **Then** the OCR text is treated as the primary text source (PDF used only for metadata) and the resulting transactions contain a `source_span` reference for every row.
4. **Given** the user provided only a PDF, **When** extraction runs, **Then** text is recovered from the PDF itself and the same structured result is produced (with `source_span` referencing page coordinates rather than OCR character offsets).

---

### User Story 2 — Surface reconciliation mismatches loudly (Priority: P1)

When the arithmetic identity `beginning + Σdeposits − Σwithdrawals = ending` does not hold for the extracted result, the analyst must immediately see that the numbers do not tie, with the delta shown, instead of silently receiving a wrong JSON. The result is still returned (it is a valid report of a data problem, not a system failure).

**Why this priority**: A statement extractor that silently returns wrong totals is worse than one that refuses to run. Trust in the numbers is the core promise of the product, and reconciliation is the only deterministic guard against hallucinated arithmetic.

**Independent Test**: Feed a slightly modified Ixonia statement that breaks the totals by exactly $2.00, run extraction, and verify a red «Reconciliation failed» banner appears above the table showing `delta = $2.00` and the expected vs. actual ending balance — while the JSON result is still produced and downloadable.

**Acceptance Scenarios**:

1. **Given** an extracted result whose `beginning + Σdeposits − Σwithdrawals` matches `ending` within 1 cent, **When** the result is rendered, **Then** a green «Reconciled» badge is shown and no warning banner appears.
2. **Given** an extracted result whose computed ending differs from the statement's ending by more than 1 cent, **When** the result is rendered, **Then** a red banner is shown above the transactions table explaining the expected vs. actual ending balance and the signed delta, and the badge area shows a clear failure indicator.
3. **Given** any extraction (matched or mismatched), **When** the user inspects the JSON, **Then** the `summary.reconciliation` object is present and contains `{ ok, delta, expected_ending }`.
4. **Given** transactions whose `Σdeposits` or `Σwithdrawals` do not match the corresponding total/count fields in the summary, **When** the result is rendered, **Then** a warning is included in the extraction warnings list (visible to the user) but the result is still returned.

---

### User Story 3 — Generalize to previously unseen banks without code changes (Priority: P2)

An evaluator runs the tool on two bank statements that the team has never seen during development. The tool must produce a valid, reconciled (or honestly-failing) structured result for both, without any code modification — only prompt or schema adjustments are permitted between samples (and only outside of a live demo).

**Why this priority**: This is the differentiator versus naive parsers. P2 because the system must first work correctly on a known sample (P1) before generalization can be evaluated meaningfully; in evaluation order, it comes after the happy path.

**Independent Test**: Take two bank statements from banks other than Ixonia, run extraction with the unchanged codebase, and verify that for each: (a) the account/period are correctly identified, (b) at least 90% of summary fields match the human-reviewed reference, and (c) reconciliation either passes or honestly reports the delta.

**Acceptance Scenarios**:

1. **Given** a single-period PDF statement from a bank that was not present in the development fixtures, **When** the user runs extraction, **Then** the system produces a structured result that conforms to the data contract without any code modification.
2. **Given** two such unseen-bank statements processed back to back, **When** their results are compared to human-prepared references, **Then** ≥ 90 % of summary fields match exactly and reconciliation behaviour (pass/fail with correct delta) is correct in both cases.

---

### User Story 4 — Show real-time progress and recoverable errors (Priority: P3)

While extraction is running, the user should see clear progress through the pipeline (upload → text recovery → AI extraction → reconciliation) so that a 10–20 second wait does not feel like a hang, and if something fails, the message must be plain-language and actionable, never a stack trace.

**Why this priority**: Improves perceived performance and user trust, and is required for the demo to feel polished, but the core value (P1, P2) can be demonstrated without it if pressed.

**Independent Test**: Throttle a network connection or upload an unreadable PDF and verify that (a) every stage of normal processing renders its `pending → active → done` state, (b) error states render in plain language with a «Try again» action, and (c) no technical error text or stack trace is ever shown.

**Acceptance Scenarios**:

1. **Given** an in-progress extraction, **When** the client renders the progress view, **Then** four stages — Upload, Parse PDF, Extract with AI, Reconcile — are displayed with three possible states each (`pending`, `active`, `done`), and the currently active stage is visually distinct.
2. **Given** an active stage that has been running for more than 5 seconds, **When** the progress view updates, **Then** a «still working…» annotation appears under that stage.
3. **Given** a failure during any stage, **When** the failure is reported, **Then** the offending stage turns red, a plain-language message is shown (`BAD_FILE`, `EXTRACTION_FAILED`, `LLM_UNAVAILABLE`, or generic connection problem) and a «Try again» button is offered for retriable errors. No stack trace, internal error code, or framework-level detail is shown.

---

### Edge Cases

- **Password-protected or corrupted PDF**: Detect at the earliest opportunity and surface a `BAD_FILE` user-facing error. Do not retry.
- **Statement with zero transactions** in the period: Result is still valid; transactions table renders an empty-state message; summary counts are zero; reconciliation must still hold (beginning == ending) or be reported.
- **PDF exceeds the 10 MB limit** (or OCR text exceeds the 2 MB limit): Validation blocks the request client-side before upload, with a plain-language message.
- **OCR file does not correspond to the PDF**: System cannot detect mismatch perfectly; uses OCR as text source per assumption, and any resulting reconciliation failure is surfaced via the standard mismatch banner (User Story 2).
- **Ambiguous transaction line** where deposit vs. withdrawal cannot be determined: Both fields are null, the row is still listed, and a warning is added to the extraction warnings list. The user sees the warning and can investigate.
- **Multi-period statement** (more than one billing period in a single PDF): In scope. The pipeline detects every statement period in the document (indexer pass) and extracts each independently; the API result is an ordered `ExtractResult[]` with one entry per period. Cross-period analytics (balance trends, period-to-period diffing) remain out of scope — the array is just per-period extractions concatenated, not a unified ledger.
- **Non-English statement**: Out of scope; behaviour is undefined. The system MAY still succeed but is not evaluated against such inputs.
- **LLM provider is unavailable or rate-limited**: User-facing `LLM_UNAVAILABLE` message with a «Try again» action; no partial result is shown.
- **Invalid structured response from the AI** (does not match the contract): One automatic retry with a corrective prompt; if it still fails, surface `EXTRACTION_FAILED` to the user.
- **Network drops mid-extraction**: User sees a connection-problem message and a «Try again» action; no partial UI state is left behind.

## Requirements *(mandatory)*

### Functional Requirements

**Upload & input validation**

- **FR-001**: System MUST accept a single PDF file via drag-and-drop or a file picker.
- **FR-002**: System MUST optionally accept a second plain-text file containing OCR output for the same PDF.
- **FR-003**: System MUST validate that the uploaded primary file is actually a PDF (by content, not only by extension), and that the optional OCR file is plain text.
- **FR-004**: System MUST enforce a 10 MB size limit on the PDF and a 2 MB size limit on the OCR text file, and MUST reject oversize files before any extraction work begins, with a plain-language message.
- **FR-005**: System MUST display each uploaded file's name and size before extraction starts, and MUST allow the user to remove an uploaded file and replace it.

**Extraction pipeline**

- **FR-006**: System MUST recover the textual content of the statement from the OCR file when provided, and from the PDF itself when no OCR file is provided.
- **FR-007**: System MUST send the recovered text to an AI extraction service and request a structured result that matches the canonical data contract (see Key Entities).
- **FR-008**: System MUST validate the AI's structured response against the canonical data contract before accepting it; an invalid response triggers exactly one automatic retry, after which an `EXTRACTION_FAILED` error is surfaced.
- **FR-009**: System MUST record, in the result, the model identifier used, the prompt version, the total processing duration, and any non-fatal warnings collected during the run.
- **FR-010**: System MUST associate every transaction in the result with a `source_span` that points back to the originating location in the recovered text (OCR character range or PDF page+region), so each value is auditable to the source document.
- **FR-011**: System MUST NOT contain bank-specific recognition logic in code; support for a new bank MUST be achievable through prompt and/or schema updates only.

**Reconciliation**

- **FR-012**: After a valid AI response is obtained, the system MUST deterministically (not via the AI) compute `expected_ending = beginning_balance + Σ(transactions.deposit) − Σ(transactions.withdrawal)` and compare it to the AI-reported `ending_balance` with a tolerance of ±$0.01.
- **FR-013**: System MUST populate the result's `summary.reconciliation` with `{ ok, delta, expected_ending }` regardless of whether the totals reconcile.
- **FR-014**: System MUST treat reconciliation failure as a successful extraction with a data-quality finding (the request still completes successfully); it MUST NOT block the response.
- **FR-015**: System MUST also compare `Σ(transactions.deposit)` and `Σ(transactions.withdrawal)` (and their counts) against the corresponding summary totals/counts. Any divergence MUST be recorded as a non-fatal warning in the extraction warnings list.
- **FR-016**: All monetary arithmetic performed by the system MUST use decimal arithmetic with explicit precision; binary floating-point arithmetic MUST NOT be used for monetary values.

**Progress reporting (UI)**

- **FR-017**: During extraction, the system MUST report progress through four named stages — Upload, Parse PDF, Extract with AI, Reconcile — and the UI MUST render the current state (`pending`, `active`, `done`, `error`) of each.
- **FR-018**: If any single stage takes longer than 5 seconds, the UI MUST display a «still working…» annotation for that stage.
- **FR-019**: On failure during any stage, the UI MUST render that stage in an error state and offer a «Try again» action for retriable errors.

**Result display (UI)**

- **FR-020**: Upon successful extraction, the UI MUST display:
  - an Account card showing the bank name, the masked last 4 digits of the account number, and the human-readable period range,
  - a Summary card showing the six headline values and a clear reconciliation status indicator (success/failure),
  - a Transactions table listing every extracted transaction.
- **FR-021**: All monetary values displayed in the UI MUST use thousands separators and exactly two decimal places (e.g., `$1,214,254.05`); deposits and withdrawals MUST be visually distinguishable (deposits as positive/green, withdrawals as negative/red, following standard financial convention).
- **FR-022**: The Transactions table MUST support: column sorting (default sorting is by date, ascending) and an in-page text search that filters rows by description in real time without server round-trips.
- **FR-023**: The UI MUST provide a «Copy JSON» action that copies the full canonical result to the clipboard, and a «Download JSON» action that downloads the result as `<bank>_<period>.json`.
- **FR-024**: When `summary.reconciliation.ok` is false, the UI MUST display a prominent banner above the transactions table explaining the expected vs. actual ending balance and the signed delta.
- **FR-025**: When the transactions list is empty, the UI MUST render a clear empty-state message rather than an empty table.

**Errors & messaging**

- **FR-026**: The system MUST surface only these user-facing error categories and MUST translate every internal error into one of them: invalid/corrupt file, AI extraction failed after retry, AI provider unavailable, connection problem.
- **FR-027**: The system MUST NOT expose stack traces, raw error messages, internal error codes, or implementation details (framework names, library names, model names) to end users.

**Privacy & security**

- **FR-028**: Uploaded files MUST be processed in memory only; they MUST NOT be persisted to disk or to any database between requests, and MUST be discarded after the response is produced.
- **FR-029**: Cross-origin access to the extraction service MUST be limited to the application's own web origin.
- **FR-030**: Logs produced by the system MUST NOT contain the full content of any statement; they MUST be limited to metadata such as input size, content hash, model identifier and processing duration.
- **FR-031**: Credentials for any external AI provider MUST be configured via environment variables and MUST NEVER appear in logs or in the user-facing response.

### Key Entities *(include if feature involves data)*

The canonical structured result returned to the user (and downloadable as JSON) consists of the following entities. The detailed shape (field names, types, regex patterns) is fixed by the project data contract referenced in the constitution.

- **Account** — describes whose statement this is: the bank name, the masked last 4 digits of the account number, and the period covered (start and end dates).
- **Summary** — the six headline aggregates of the period: beginning balance, ending balance, total deposits and deposit count, total withdrawals and withdrawal count, plus the embedded **Reconciliation** record below.
- **Reconciliation** — the deterministic check of arithmetic identity, expressed as `{ ok, delta, expected_ending }` so that any consumer can immediately see whether the numbers tie and, if not, by how much.
- **Transaction** — a single line item: the date, the description, the deposit amount **or** the withdrawal amount (exactly one of the two must be non-null), and a **SourceSpan** pointing back to where the row was found in the original document.
- **SourceSpan** — the audit trail for each value: either a character offset range in the OCR text or a page+region reference in the PDF.
- **ExtractionMetadata** — model identifier used for this run, prompt version, total processing duration, and a list of non-fatal warnings collected during the run.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: For the reference Ixonia sample (`Binder2_Redacted.pdf`, 99 pages, 10 statement periods), the API returns an `ExtractResult[]` of length 10. For each period the six summary values match the human-curated etalon row exactly. For the canonical Apr 2025 period specifically: deposits_count = 81, deposits_total = $1,214,254.05, withdrawals_count = 111, withdrawals_total = $1,302,201.16, transactions array length = 192, reconciliation badge green. Wall-clock end-to-end ≤ 60s × periods.
- **SC-002**: For two additional bank statements never seen during development, the system produces structured results without any code change; at least 90 % of summary fields match the human-curated references and reconciliation behaviour (pass or correctly-reported delta) is correct in 100 % of cases.
- **SC-003**: For an intentionally-mistuned statement (totals off by exactly $2.00), the system returns a result with the mismatch banner shown, `delta = $2.00`, and the user is able to download the JSON anyway.
- **SC-004**: 95 % of single-period statements up to 10 pages complete extraction in under 60 seconds, measured end-to-end from upload to result display. For multi-period documents the budget applies per period.
- **SC-005**: The user perceives progress: during any successful run, no single visible stage stays in the `active` state for more than 15 seconds without showing the «still working…» annotation, and the overall progress UI is updated within 200 ms of each stage transition.
- **SC-006**: For each of the failure modes listed in FR-026, the user sees a plain-language message and (where applicable) a working «Try again» action; in no case is a stack trace, raw error or internal code shown.
- **SC-007**: A first-time user, given only the landing page and a PDF file, successfully obtains a structured result on the first attempt without external instructions, in ≥ 90 % of usability sessions.
- **SC-008**: The project's `README` reports self-measured accuracy on at least three banks (Ixonia + two others) as a table with columns: bank, summary accuracy, transaction-count match, reconciliation status — together with a candid list of known weaknesses.

## Assumptions

- **Scope covers both single-period and multi-period statements.** A "statement period" is one bank-statement document; the pipeline indexes every period in the PDF (look for "Statement Period" / "Statement Date" headers, fresh cover pages, new "Beginning Balance" markers) and runs the extractor independently on each. Cross-period inference (balance trends, period-to-period diffing, deduplicating transactions across periods) is out of scope: the response is `ExtractResult[]` and consumers do their own aggregation.
- **English-language statements only.** Behaviour on statements in other languages is undefined; the test corpus is English.
- **The product is a web UI on top of a server-side extraction service.** A command-line front door or public HTTP API is not a deliverable of this feature; the extraction service exists only to back the UI.
- **Single user, no authentication, no persistence between requests.** This is a demo / single-operator tool. There is no login, no per-user state, and no stored history of past extractions.
- **The AI provider is an external service** accessed over the network and may occasionally be unavailable or rate-limited. The product accepts this as a transient condition and surfaces it as `LLM_UNAVAILABLE`.
- **Determinism where possible.** Identical inputs should produce identical outputs across runs, to the extent the underlying AI permits; tests for deterministic parts of the pipeline (reconciliation, formatting) can rely on this.
- **Audit trail is mandatory.** Every transaction returned by the system is expected to carry a `source_span`. A result without source spans is considered defective even if the numbers happen to be correct.
- **Out of scope (explicitly):** multi-user / authentication, history persistence (database), non-PDF input formats (CSV, OFX, HTML), transaction categorisation or analytics, custom-trained models, rate-limiting (for the demo), running-balance extraction per transaction, automatic correction of reconciliation mismatches.

## Dependencies

- Access to an external AI provider capable of returning structured (schema-conformant) output. Credentials for that provider must be available in the deployment environment.
- A reference Ixonia statement (PDF + OCR text) plus a human-curated reference result, available as a development fixture.
- At least two additional bank statements (PDF, ideally with OCR) plus human-curated reference results, to validate cross-bank generalisation per SC-002.

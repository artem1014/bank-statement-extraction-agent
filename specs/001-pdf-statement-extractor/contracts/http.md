# HTTP Contract

**Feature**: 001-pdf-statement-extractor
**Base URL**: `${VITE_API_BASE_URL}` (dev: `http://localhost:8080`)
**Auth**: none (single-operator demo, constitution §VII)
**CORS**: `Access-Control-Allow-Origin` set to the value of the server-side
`CORS_ORIGIN` env variable; credentials disallowed.

All responses use UTF-8. JSON bodies use `application/json; charset=utf-8`. The
`/api/extract` endpoint returns `text/event-stream` (see `sse-events.md`).

## `POST /api/extract`

Run extraction over an uploaded statement.

### Request

- **Method**: `POST`
- **Path**: `/api/extract`
- **Headers**:
  - `Accept: text/event-stream`
- **Body**: `multipart/form-data` with the following parts:

| Part name | Required | Content-Type | Constraints |
|---|---|---|---|
| `pdf` | yes | `application/pdf` (verified by magic bytes) | ≤ `MAX_PDF_BYTES` (default 10 MiB). |
| `txt` | no | `text/plain; charset=utf-8` | ≤ `MAX_OCR_BYTES` (default 2 MiB). When present, used as the primary text source (FR-007). |

The server **does not** read `Content-Type` from the client — it sniffs the magic
bytes of `pdf` and rejects with `BAD_FILE` if the leading bytes are not `%PDF-` (FR-003).

### Response — happy path

- **Status**: `200 OK`
- **Content-Type**: `text/event-stream`
- **Body**: a sequence of SSE events; terminated by either a `result` event or an
  `error` event. See `sse-events.md` for the precise event grammar.

A reconciliation failure is **not** an HTTP error — the response is still `200` with a
`result` event whose payload has `summary.reconciliation.ok = false` (FR-014).

### Response — error before streaming starts

Returned only when the request itself is structurally invalid (no body, missing `pdf`
part, oversize, wrong magic bytes). After the SSE stream has begun (i.e. the first
`stage` event has been emitted), all errors are surfaced as SSE `error` events with
status `200`, not as HTTP error responses.

| Pre-stream HTTP status | Condition |
|---|---|
| `400 Bad Request` | Missing `pdf` part, or `pdf`/`txt` failed magic-byte / charset check. Body: `{ "code": "BAD_FILE", "message": "<plain English>" }`. |
| `413 Payload Too Large` | `pdf` > `MAX_PDF_BYTES` or `txt` > `MAX_OCR_BYTES`. Body: `{ "code": "BAD_FILE", "message": "..." }`. |
| `415 Unsupported Media Type` | Request was not `multipart/form-data`. |
| `500 Internal Server Error` | Unexpected error before any stage emitted. Body: `{ "code": "EXTRACTION_FAILED", "message": "Something went wrong. Please try again." }`. **Never** contains stack traces or internal details (FR-027). |

### Cancellation

If the client closes the connection (e.g. user navigates away), the server aborts the
Anthropic call (using the SDK's `AbortSignal`) and skips emitting any further events.
No partial result is persisted; in-memory file buffers are released.

### Idempotency

Not provided. v1 has no server-side state; an idempotency-key header is reserved as a
future extension and currently ignored.

---

## `GET /api/health`

Lightweight health probe used by CI / container orchestration.

### Request

- **Method**: `GET`
- **Path**: `/api/health`
- **Headers**: none required.

### Response

- **Status**: `200 OK`
- **Content-Type**: `application/json; charset=utf-8`
- **Body**:

  ```json
  { "ok": true, "version": "<package.json version>" }
  ```

The endpoint does **not** verify reachability of the Anthropic API. A separate
`/api/health/llm` could be added later if needed; left out for v1 because exposing
provider availability publicly is a leak.

---

## Error code catalogue

All `code` values used in JSON error bodies and SSE `error` events:

| Code | Meaning | Retriable? |
|---|---|---|
| `BAD_FILE` | Upload was missing, wrong type, oversize, password-protected, or unreadable. | No — user must change the file. |
| `EXTRACTION_FAILED` | The AI returned a structurally invalid response after one retry. | Yes — UI offers "Try again". |
| `LLM_UNAVAILABLE` | The AI provider returned 429 / 5xx or the call timed out. | Yes — UI offers "Try again". |

`RECONCILIATION_FAILED` is intentionally **not** in this catalogue — it is a data
field (`summary.reconciliation.ok = false`), not an HTTP/SSE error (FR-014, FR-024).

User-facing messages corresponding to each code are owned by the frontend (FR-026,
FR-027), keeping copy editing in one place.

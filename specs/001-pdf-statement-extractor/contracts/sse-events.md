# Server-Sent Events Contract

**Feature**: 001-pdf-statement-extractor
**Endpoint**: `POST /api/extract` (see `http.md`)
**Content-Type**: `text/event-stream; charset=utf-8`
**Encoding**: UTF-8, one event per `event:` block separated by a blank line, per the
HTML SSE spec.

Each event has:

- an `event:` line declaring the event name (one of `stage`, `result`, `error`),
- a single `data:` line containing a JSON object terminated by `\n\n`.

The connection is closed by the server immediately after a terminal event (`result`
or `error`). The connection is **never** kept open beyond the extraction.

## Event grammar

### `stage`

Emitted at every stage transition (entering `active`, transitioning to `done` or
`error`). Frontend consumes these to drive the progress UI (FR-017–FR-019).

```text
event: stage
data: { "stage": "<stage>", "status": "<status>" }
```

| Field | Type | Domain |
|---|---|---|
| `stage` | string | `"upload" \| "parse" \| "extract" \| "reconcile"` |
| `status` | string | `"active" \| "done" \| "error"` |

**Emission order** (happy path):

```text
stage upload     active
stage upload     done
stage parse      active
stage parse      done
stage extract    active
stage extract    done
stage reconcile  active
stage reconcile  done
result           { ...ExtractResult }
```

**Emission order** (failure during `extract`):

```text
stage upload     active
stage upload     done
stage parse      active
stage parse      done
stage extract    active
stage extract    error
error            { "code": "EXTRACTION_FAILED", "message": "..." }
```

A stage emits at most one `active`, one `done`, and at most one `error`. The server
guarantees that for any path the sequence is monotonic — once a stage is `done` or
`error`, it does not re-enter.

### `result`

Terminal event for a successful run. Emitted exactly once when present.

```text
event: result
data: { ...ExtractResult }
```

Payload conforms to `extract-result.schema.json` (and to the Zod
`ExtractResultSchema`). A reconciliation mismatch is still a `result` event with
`summary.reconciliation.ok = false`.

### `error`

Terminal event for a failed run. Emitted exactly once when present.

```text
event: error
data: { "code": "<ErrorCode>", "message": "<plain English>" }
```

| Field | Type | Domain |
|---|---|---|
| `code` | string | `"BAD_FILE" \| "EXTRACTION_FAILED" \| "LLM_UNAVAILABLE"` |
| `message` | string | Plain English, non-empty, no stack trace (FR-027). |

The frontend maps `code` to the user-facing message it owns (FR-026); `message` is
used as the fallback display string for codes the client does not recognise (e.g. a
future extension).

## Stream guarantees

- **Ordering**: events are delivered in the order shown above. Out-of-order delivery
  is not permitted.
- **Atomicity per event**: each `event:` + `data:` block is flushed together; clients
  may rely on `\n\n` as the boundary.
- **No heartbeats** in v1. Extractions are short-lived (≤ 30 s wall-clock), so the
  cost of adding `: ping\n\n` comments is not justified yet.
- **Cancellation**: when the client disconnects, the server aborts the upstream
  Anthropic call. No `result` or `error` event is delivered after disconnection.

## Client parsing

`apps/web/src/shared/api/sse.ts` provides a minimal parser:

```ts
export type StageEvent  = { type: 'stage';  stage: Stage; status: StageStatus };
export type ResultEvent = { type: 'result'; result: ExtractResult };
export type ErrorEvent  = { type: 'error';  code: ErrorCode; message: string };
export type AnyEvent    = StageEvent | ResultEvent | ErrorEvent;

export async function* readSse(res: Response): AsyncGenerator<AnyEvent> { /* … */ }
```

The parser strips trailing whitespace, ignores comment lines (`:`-prefixed), accepts
only the three documented event names, and validates `data:` payloads against the
runtime Zod schema before yielding. Unknown events terminate the stream with a
synthesised `error` event (`code: 'EXTRACTION_FAILED'`, `message: 'Unexpected server
response.'`).

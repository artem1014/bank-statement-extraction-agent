import type { ErrorBody, ExtractResult, StageEventData } from '@app/contracts';

export interface ResultPayload {
  periods: ExtractResult[];
}

export type SseEvent =
  | { type: 'stage'; data: StageEventData }
  | { type: 'result'; data: ResultPayload }
  | { type: 'error'; data: ErrorBody };

export interface SseStreamOptions {
  url: string;
  body: FormData;
  signal?: AbortSignal;
}

async function* readSseFrames(
  stream: ReadableStream<Uint8Array>,
): AsyncGenerator<{ event: string; data: string }> {
  const reader = stream.getReader();
  const decoder = new TextDecoder('utf-8');
  let buffer = '';
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let separatorIdx = buffer.indexOf('\n\n');
      while (separatorIdx !== -1) {
        const frame = buffer.slice(0, separatorIdx);
        buffer = buffer.slice(separatorIdx + 2);
        const parsed = parseFrame(frame);
        if (parsed) yield parsed;
        separatorIdx = buffer.indexOf('\n\n');
      }
    }
  } finally {
    reader.releaseLock();
  }
}

function parseFrame(frame: string): { event: string; data: string } | null {
  let event = 'message';
  const dataLines: string[] = [];
  for (const line of frame.split('\n')) {
    if (line.startsWith('event:')) event = line.slice(6).trim();
    else if (line.startsWith('data:')) dataLines.push(line.slice(5).trimStart());
  }
  if (dataLines.length === 0) return null;
  return { event, data: dataLines.join('\n') };
}

export async function* extractStream(opts: SseStreamOptions): AsyncGenerator<SseEvent> {
  const res = await fetch(opts.url, {
    method: 'POST',
    body: opts.body,
    headers: { Accept: 'text/event-stream' },
    signal: opts.signal,
  });
  if (!res.ok || !res.body) {
    yield {
      type: 'error',
      data: {
        code: res.status === 503 ? 'LLM_UNAVAILABLE' : 'EXTRACTION_FAILED',
        message: `Server returned HTTP ${res.status}.`,
      },
    };
    return;
  }
  for await (const { event, data } of readSseFrames(res.body)) {
    try {
      const parsed = JSON.parse(data);
      if (event === 'stage') yield { type: 'stage', data: parsed as StageEventData };
      else if (event === 'result') yield { type: 'result', data: parsed as ResultPayload };
      else if (event === 'error') yield { type: 'error', data: parsed as ErrorBody };
    } catch {
      yield {
        type: 'error',
        data: { code: 'EXTRACTION_FAILED', message: 'Malformed server-sent event payload.' },
      };
      return;
    }
  }
}

import type { ErrorBody, ExtractResult, StageName, StageStatus } from '../domain/types.js';

export interface SseSink {
  write(chunk: string): void | Promise<void>;
  close(): void | Promise<void>;
}

function frame(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

export class StageEmitter {
  private closed = false;
  private readonly emitted = new Map<StageName, Set<StageStatus>>();

  constructor(private readonly sink: SseSink) {}

  async emitStage(stage: StageName, status: StageStatus): Promise<void> {
    if (this.closed) return;
    const seen = this.emitted.get(stage) ?? new Set<StageStatus>();
    if (seen.has(status)) return;
    seen.add(status);
    this.emitted.set(stage, seen);
    await this.sink.write(frame('stage', { stage, status }));
  }

  async emitResult(result: ExtractResult): Promise<void> {
    if (this.closed) return;
    await this.sink.write(frame('result', result));
    await this.close();
  }

  async emitError(body: ErrorBody): Promise<void> {
    if (this.closed) return;
    await this.sink.write(frame('error', body));
    await this.close();
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.sink.close();
  }
}

import type { Config } from '../config.js';

export interface ExtractOptions {
  abortSignal?: AbortSignal;
  promptVersion: string;
  systemPrompt: string;
  userPrompt: string;
  sourceText: string;
}

export interface LlmClient {
  extract(opts: ExtractOptions): Promise<unknown>;
  readonly model: string;
}

export function createAnthropicClient(_config: Config): LlmClient {
  return {
    model: _config.ANTHROPIC_MODEL,
    extract: () => {
      throw new Error(
        'createAnthropicClient.extract: not yet implemented — see tasks T062. Use a fake client in tests.',
      );
    },
  };
}

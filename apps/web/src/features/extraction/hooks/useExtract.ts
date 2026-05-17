import type {
  ErrorBody,
  ExtractResult,
  StageEventData,
  StageName,
  StageStatus,
} from '@app/contracts';
import { useCallback, useRef, useState } from 'react';
import { extractStream } from '../lib/sse.js';

const STAGES = ['upload', 'parse', 'extract', 'reconcile'] as const satisfies readonly StageName[];

export interface StageProgress {
  stage: StageName;
  status: StageStatus;
  detail?: string;
}

export interface ExtractState {
  state: 'idle' | 'streaming' | 'success' | 'error';
  stages: StageProgress[];
  results: ExtractResult[];
  error: ErrorBody | null;
}

const API_BASE = (import.meta.env.VITE_API_BASE_URL as string | undefined) ?? '';

function initialStages(): StageProgress[] {
  return STAGES.map((stage) => ({ stage, status: 'pending' as StageStatus }));
}

function reduceStage(
  prev: StageProgress[],
  evt: StageEventData & { detail?: string },
): StageProgress[] {
  return prev.map((p) =>
    p.stage === evt.stage ? { stage: evt.stage, status: evt.status, detail: evt.detail } : p,
  );
}

export function useExtract(): {
  start: (pdf: File, ocr?: File | null) => Promise<void>;
  cancel: () => void;
} & ExtractState {
  const [state, setState] = useState<ExtractState>({
    state: 'idle',
    stages: initialStages(),
    results: [],
    error: null,
  });
  const abortRef = useRef<AbortController | null>(null);

  const start = useCallback(async (pdf: File, ocr?: File | null) => {
    abortRef.current?.abort();
    const ctrl = new AbortController();
    abortRef.current = ctrl;

    setState({ state: 'streaming', stages: initialStages(), results: [], error: null });

    const form = new FormData();
    form.append('pdf', pdf, pdf.name);
    if (ocr) form.append('ocr_text', ocr, ocr.name);

    try {
      for await (const evt of extractStream({
        url: `${API_BASE}/api/extract`,
        body: form,
        signal: ctrl.signal,
      })) {
        if (evt.type === 'stage') {
          setState((s) => ({ ...s, stages: reduceStage(s.stages, evt.data) }));
        } else if (evt.type === 'result') {
          setState((s) => ({ ...s, state: 'success', results: evt.data.periods }));
        } else if (evt.type === 'error') {
          setState((s) => ({ ...s, state: 'error', error: evt.data }));
        }
      }
    } catch (err) {
      if ((err as Error).name === 'AbortError') return;
      setState((s) => ({
        ...s,
        state: 'error',
        error: { code: 'EXTRACTION_FAILED', message: (err as Error).message ?? 'Network error' },
      }));
    }
  }, []);

  const cancel = useCallback(() => {
    abortRef.current?.abort();
    setState((s) => ({ ...s, state: 'idle' }));
  }, []);

  return { ...state, start, cancel };
}

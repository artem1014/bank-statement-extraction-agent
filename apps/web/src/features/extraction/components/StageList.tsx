import type { StageName, StageStatus } from '@app/contracts';
import type { StageProgress } from '../hooks/useExtract.js';

const LABELS: Record<StageName, string> = {
  upload: 'Upload',
  parse: 'Preprocess (split into chunks)',
  extract: 'Extract via OpenAI',
  reconcile: 'Reconcile balances',
};

const DOT: Record<StageStatus, string> = {
  pending: 'bg-muted',
  active: 'bg-blue-500 animate-pulse',
  done: 'bg-green-500',
  error: 'bg-red-500',
};

interface Props {
  stages: StageProgress[];
}

export function StageList({ stages }: Props): JSX.Element {
  return (
    <ol className="space-y-2">
      {stages.map((p) => (
        <li key={p.stage} className="flex items-center gap-3 text-sm">
          <span className={`inline-block h-2.5 w-2.5 rounded-full ${DOT[p.status]}`} />
          <span className="font-medium">{LABELS[p.stage]}</span>
          {p.detail && <span className="text-muted-foreground truncate">— {p.detail}</span>}
        </li>
      ))}
    </ol>
  );
}

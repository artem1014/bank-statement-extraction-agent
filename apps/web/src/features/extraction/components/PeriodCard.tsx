import { formatIsoDate, formatLast4, formatMoney, formatPeriod } from '@/shared/lib/format';
import { Badge, Card, CardContent, CardHeader, CardTitle } from '@/shared/ui';
import type { ExtractResult } from '@app/contracts';
import { useState } from 'react';

interface Props {
  result: ExtractResult;
  index: number;
}

export function PeriodCard({ result, index }: Props): JSX.Element {
  const [expanded, setExpanded] = useState(false);
  const { account, summary, transactions } = result;
  const { reconciliation } = summary;

  return (
    <Card>
      <CardHeader>
        <div className="flex items-start justify-between gap-4">
          <div>
            <CardTitle className="text-lg">
              {index + 1}. {formatPeriod(account.period.start, account.period.end)}
            </CardTitle>
            <p className="mt-0.5 text-sm text-muted-foreground">
              {account.bank ?? 'Unknown bank'} · {formatLast4(account.account_last4)}
            </p>
          </div>
          <Badge variant={reconciliation.ok ? 'default' : 'destructive'}>
            {reconciliation.ok ? 'Balanced' : `Drift ${formatMoney(reconciliation.delta)}`}
          </Badge>
        </div>
      </CardHeader>

      <CardContent className="space-y-4">
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <Metric label="Beginning" value={formatMoney(summary.beginning_balance)} />
          <Metric label="Ending" value={formatMoney(summary.ending_balance)} />
          <Metric
            label={`Deposits (${summary.deposits_count})`}
            value={formatMoney(summary.deposits_total)}
            tone="positive"
          />
          <Metric
            label={`Withdrawals (${summary.withdrawals_count})`}
            value={formatMoney(summary.withdrawals_total)}
            tone="negative"
          />
        </div>

        {!reconciliation.ok && (
          <div className="rounded border border-destructive/40 bg-destructive/5 p-3 text-xs">
            <p className="font-medium text-destructive">Reconciliation drift</p>
            <p className="mt-1 text-destructive/90">
              Expected ending balance: {formatMoney(reconciliation.expected_ending)} · reported{' '}
              {formatMoney(summary.ending_balance)} · delta {formatMoney(reconciliation.delta)}
            </p>
          </div>
        )}

        <div>
          <button
            type="button"
            onClick={() => setExpanded((v) => !v)}
            className="text-sm font-medium text-primary hover:underline"
          >
            {expanded ? 'Hide' : 'Show'} {transactions.length} transactions
          </button>
        </div>

        {expanded && transactions.length > 0 && (
          <div className="max-h-96 overflow-auto rounded border">
            <table className="w-full text-left text-xs">
              <thead className="sticky top-0 border-b bg-muted/80 text-muted-foreground backdrop-blur">
                <tr>
                  <th className="px-2 py-1.5">Date</th>
                  <th className="px-2 py-1.5">Description</th>
                  <th className="px-2 py-1.5 text-right">Deposit</th>
                  <th className="px-2 py-1.5 text-right">Withdrawal</th>
                  <th className="px-2 py-1.5 text-right">Page</th>
                </tr>
              </thead>
              <tbody>
                {transactions.map((t, i) => (
                  <tr key={`${t.date}-${i}`} className="border-b last:border-0">
                    <td className="whitespace-nowrap px-2 py-1.5 font-mono">
                      {formatIsoDate(t.date)}
                    </td>
                    <td className="px-2 py-1.5">{t.description}</td>
                    <td className="px-2 py-1.5 text-right font-mono text-green-700">
                      {t.deposit != null ? formatMoney(t.deposit) : ''}
                    </td>
                    <td className="px-2 py-1.5 text-right font-mono text-red-700">
                      {t.withdrawal != null ? formatMoney(t.withdrawal) : ''}
                    </td>
                    <td className="px-2 py-1.5 text-right font-mono text-muted-foreground">
                      {t.source_span?.page ?? ''}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function Metric({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone?: 'positive' | 'negative';
}): JSX.Element {
  const color =
    tone === 'positive'
      ? 'text-green-700'
      : tone === 'negative'
        ? 'text-red-700'
        : 'text-foreground';
  return (
    <div>
      <p className="text-[11px] uppercase tracking-wide text-muted-foreground">{label}</p>
      <p className={`mt-0.5 font-mono text-sm font-semibold ${color}`}>{value}</p>
    </div>
  );
}

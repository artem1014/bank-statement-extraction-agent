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
  const { account, summary, transactions, extraction } = result;

  const computedEnding =
    summary.beginning_balance + summary.deposits_total - summary.withdrawals_total;
  const diff = computedEnding - summary.ending_balance;
  const balances = Math.abs(diff) < 0.01;

  const llmWarnings = extraction.warnings.filter((w) => w.startsWith('recovered-via-llm:'));
  const sourceBadge =
    extraction.model === 'ocr-deterministic' && llmWarnings.length === 0
      ? { label: 'OCR-deterministic', tone: 'ocr' as const }
      : llmWarnings.length > 0
        ? { label: 'OCR + LLM fallback', tone: 'mixed' as const }
        : { label: extraction.model, tone: 'llm' as const };

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
          <div className="flex flex-col items-end gap-1">
            <Badge variant={balances ? 'default' : 'destructive'}>
              {balances ? 'Balances' : 'Doesn’t balance'}
            </Badge>
            <span
              className={`rounded-full px-2 py-0.5 text-[10px] font-medium ${
                sourceBadge.tone === 'ocr'
                  ? 'bg-green-100 text-green-800'
                  : sourceBadge.tone === 'mixed'
                    ? 'bg-amber-100 text-amber-800'
                    : 'bg-slate-100 text-slate-700'
              }`}
            >
              {sourceBadge.label}
            </span>
          </div>
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

        <div
          className={`rounded border p-3 text-xs ${
            balances ? 'border-emerald-200 bg-emerald-50/60' : 'border-amber-300 bg-amber-50'
          }`}
        >
          <p className={`font-medium ${balances ? 'text-emerald-800' : 'text-amber-900'}`}>
            {balances ? 'Balance check passes' : 'Balance check does not match document'}
          </p>
          <p className={`mt-1 font-mono ${balances ? 'text-emerald-900/80' : 'text-amber-900/90'}`}>
            {formatMoney(summary.beginning_balance)}
            {'  +  '}
            {formatMoney(summary.deposits_total)}
            {'  −  '}
            {formatMoney(summary.withdrawals_total)}
            {'  =  '}
            <span className="font-semibold">{formatMoney(computedEnding)}</span>
          </p>
          <p className={`mt-1 ${balances ? 'text-emerald-900/70' : 'text-amber-900/80'}`}>
            {balances ? (
              <>
                Matches ending balance in document:{' '}
                <span className="font-mono">{formatMoney(summary.ending_balance)}</span>
              </>
            ) : (
              <>
                Document reports ending{' '}
                <span className="font-mono font-semibold">
                  {formatMoney(summary.ending_balance)}
                </span>{' '}
                — difference <span className="font-mono font-semibold">{formatMoney(diff)}</span>{' '}
                (likely Other Credits / Other Debits / Fees not in summary).
              </>
            )}
          </p>
        </div>

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

import { downloadBlob } from '@/shared/lib/download';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/shared/ui';
import { Button } from '@/shared/ui';
import { useState } from 'react';
import { DropZone } from './features/extraction/components/DropZone';
import { PeriodCard } from './features/extraction/components/PeriodCard';
import { StageList } from './features/extraction/components/StageList';
import { useExtract } from './features/extraction/hooks/useExtract';

export function App(): JSX.Element {
  const ex = useExtract();
  const [filename, setFilename] = useState<string | null>(null);

  const busy = ex.state === 'streaming';
  const totalTransactions = ex.results.reduce((acc, r) => acc + r.transactions.length, 0);

  return (
    <div className="min-h-screen bg-background">
      <header className="border-b">
        <div className="container flex h-14 items-center justify-between">
          <h1 className="text-base font-semibold tracking-tight">Bank Statement Extractor</h1>
          {ex.results.length > 0 && (
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                const json = JSON.stringify({ periods: ex.results }, null, 2);
                const blob = new Blob([json], { type: 'application/json' });
                const name = filename ? filename.replace(/\.pdf$/i, '') : 'extraction';
                downloadBlob(blob, `${name}.json`);
              }}
            >
              Download JSON
            </Button>
          )}
        </div>
      </header>

      <main className="container space-y-6 py-8">
        <Card className="mx-auto max-w-3xl">
          <CardHeader>
            <CardTitle>Drop your PDF statement</CardTitle>
            <CardDescription>
              Multi-period bank statements supported. OpenAI-powered extraction with deterministic
              balance reconciliation.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <DropZone
              busy={busy}
              onSubmit={(pdf, ocr) => {
                setFilename(pdf.name);
                void ex.start(pdf, ocr);
              }}
            />
          </CardContent>
        </Card>

        {(busy || ex.state === 'error') && (
          <Card className="mx-auto max-w-3xl">
            <CardHeader>
              <CardTitle className="text-base">
                {busy ? 'Extracting…' : 'Extraction failed'}
              </CardTitle>
            </CardHeader>
            <CardContent>
              <StageList stages={ex.stages} />
              {ex.error && (
                <p className="mt-4 rounded border border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive">
                  <span className="font-mono text-xs">{ex.error.code}</span> — {ex.error.message}
                </p>
              )}
            </CardContent>
          </Card>
        )}

        {ex.results.length > 0 && (
          <>
            <div className="mx-auto max-w-5xl">
              <h2 className="text-lg font-semibold">
                {ex.results.length} period{ex.results.length === 1 ? '' : 's'} · {totalTransactions}{' '}
                transactions total
              </h2>
            </div>
            <div className="mx-auto grid max-w-5xl gap-4">
              {ex.results.map((r, i) => (
                <PeriodCard
                  key={`${r.account.account_last4 ?? 'x'}-${r.account.period.start}-${i}`}
                  result={r}
                  index={i}
                />
              ))}
            </div>
          </>
        )}
      </main>
    </div>
  );
}

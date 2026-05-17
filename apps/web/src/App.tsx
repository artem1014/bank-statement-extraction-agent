import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/shared/ui';

export function App(): JSX.Element {
  return (
    <div className="min-h-screen bg-background">
      <header className="border-b">
        <div className="container flex h-14 items-center justify-between">
          <h1 className="text-base font-semibold tracking-tight">Bank Statement Extractor</h1>
          <a
            href="https://github.com/artem1014/bank-statement-extraction-agent"
            target="_blank"
            rel="noreferrer"
            className="text-sm text-muted-foreground hover:text-foreground"
          >
            GitHub
          </a>
        </div>
      </header>

      <main className="container py-10">
        <Card className="mx-auto max-w-3xl">
          <CardHeader>
            <CardTitle>Drop your PDF statement</CardTitle>
            <CardDescription>
              Drag-and-drop a single-period bank statement (PDF, ≤ 10 MB). Optionally include an OCR{' '}
              <code>.txt</code> for higher accuracy.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className="rounded-lg border border-dashed p-10 text-center text-muted-foreground">
              The drop zone, progress, and results UI will be wired up in the US1 implementation
              phase (tasks T065–T073).
            </div>
          </CardContent>
        </Card>
      </main>
    </div>
  );
}

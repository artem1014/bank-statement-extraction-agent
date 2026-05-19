import { Button } from '@/shared/ui';
import { type ChangeEvent, type DragEvent, useCallback, useId, useRef, useState } from 'react';

interface Props {
  busy: boolean;
  onSubmit: (pdf: File, ocr: File | null) => void;
}

export function DropZone({ busy, onSubmit }: Props): JSX.Element {
  const pdfInputId = useId();
  const ocrInputId = useId();
  const pdfInputRef = useRef<HTMLInputElement>(null);
  const ocrInputRef = useRef<HTMLInputElement>(null);
  const [pdf, setPdf] = useState<File | null>(null);
  const [ocr, setOcr] = useState<File | null>(null);
  const [dragging, setDragging] = useState(false);

  const onDrop = useCallback((e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setDragging(false);
    const files = Array.from(e.dataTransfer.files);
    const newPdf = files.find(
      (f) => f.type === 'application/pdf' || f.name.toLowerCase().endsWith('.pdf'),
    );
    const newOcr = files.find(
      (f) => f !== newPdf && (f.type.startsWith('text/') || /\.(txt|rtf|json)$/i.test(f.name)),
    );
    if (newPdf) setPdf(newPdf);
    if (newOcr) setOcr(newOcr);
  }, []);

  const onPdfPick = useCallback((e: ChangeEvent<HTMLInputElement>) => {
    setPdf(e.target.files?.[0] ?? null);
  }, []);
  const onOcrPick = useCallback((e: ChangeEvent<HTMLInputElement>) => {
    setOcr(e.target.files?.[0] ?? null);
  }, []);

  return (
    <div className="space-y-4">
      <div
        onDragOver={(e) => {
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={onDrop}
        className={`rounded-lg border-2 border-dashed p-10 text-center transition-colors ${
          dragging ? 'border-primary bg-primary/5' : 'border-muted-foreground/25'
        }`}
      >
        <p className="text-sm text-muted-foreground">
          Drag-and-drop a PDF here, or pick files below.
        </p>
        <p className="mt-2 text-xs text-muted-foreground">
          Optional: include an OCR sidecar (<code>.txt</code> / <code>.rtf</code>) for deterministic
          period indexing.
        </p>
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <div>
          <label htmlFor={pdfInputId} className="text-sm font-medium">
            PDF
          </label>
          <input
            ref={pdfInputRef}
            id={pdfInputId}
            type="file"
            accept="application/pdf"
            onChange={onPdfPick}
            className="mt-1 block w-full text-sm text-muted-foreground file:mr-3 file:rounded file:border file:px-3 file:py-1.5 file:text-sm file:font-medium hover:file:bg-accent"
          />
          {pdf && (
            <p className="mt-1 text-xs text-muted-foreground">
              {pdf.name} · {(pdf.size / 1024 / 1024).toFixed(2)} MB
            </p>
          )}
        </div>
        <div>
          <label htmlFor={ocrInputId} className="text-sm font-medium">
            OCR sidecar (optional)
          </label>
          <input
            ref={ocrInputRef}
            id={ocrInputId}
            type="file"
            accept=".txt,.rtf,.json,text/plain,application/rtf"
            onChange={onOcrPick}
            className="mt-1 block w-full text-sm text-muted-foreground file:mr-3 file:rounded file:border file:px-3 file:py-1.5 file:text-sm file:font-medium hover:file:bg-accent"
          />
          {ocr && (
            <p className="mt-1 text-xs text-muted-foreground">
              {ocr.name} · {(ocr.size / 1024).toFixed(1)} KB
            </p>
          )}
        </div>
      </div>

      {pdf && !ocr && (
        <div className="rounded border border-amber-300 bg-amber-50 p-3 text-xs text-amber-900">
          <p className="font-medium">No OCR sidecar attached — falling back to LLM-only mode.</p>
          <p className="mt-1 text-amber-900/80">
            Every page will be sent to OpenAI Vision. On a 99-page document expect{' '}
            <span className="font-semibold">~17 minutes</span> and{' '}
            <span className="font-semibold">~$8–15</span> in API cost. Attach a <code>.rtf</code> /{' '}
            <code>.txt</code> sidecar from Azure Document AI to switch to the fast OCR-first path
            (seconds, $0).
          </p>
        </div>
      )}

      <div className="flex justify-end">
        <Button disabled={!pdf || busy} onClick={() => pdf && onSubmit(pdf, ocr)}>
          {busy ? 'Extracting…' : ocr ? 'Extract (OCR-first)' : 'Extract (LLM-only)'}
        </Button>
      </div>
    </div>
  );
}

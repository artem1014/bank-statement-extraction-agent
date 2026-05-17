import type { ExtractResult } from '@app/contracts';

function slugify(input: string | null): string {
  if (!input) return 'statement';
  return input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)+/g, '');
}

export function buildJsonFilename(result: ExtractResult): string {
  const bank = slugify(result.account.bank);
  const period = `${result.account.period.start}_${result.account.period.end}`;
  return `${bank}_${period}.json`;
}

export function downloadJson(result: ExtractResult): void {
  const blob = new Blob([JSON.stringify(result, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = buildJsonFilename(result);
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

export async function copyJsonToClipboard(result: ExtractResult): Promise<void> {
  await navigator.clipboard.writeText(JSON.stringify(result, null, 2));
}

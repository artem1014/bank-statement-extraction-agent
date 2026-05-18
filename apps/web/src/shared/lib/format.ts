const MONEY_FORMATTER = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

const DATE_FORMATTER = new Intl.DateTimeFormat('en-US', {
  year: 'numeric',
  month: 'short',
  day: 'numeric',
  timeZone: 'UTC',
});

const SHORT_DATE_FORMATTER = new Intl.DateTimeFormat('en-US', {
  month: 'short',
  day: 'numeric',
  timeZone: 'UTC',
});

export function formatMoney(amount: number | null | undefined): string {
  if (amount === null || amount === undefined || !Number.isFinite(amount)) return '—';
  return MONEY_FORMATTER.format(amount);
}

export function formatIsoDate(iso: string): string {
  return DATE_FORMATTER.format(new Date(`${iso}T00:00:00Z`));
}

export function formatPeriod(start: string, end: string): string {
  const sameYear = start.slice(0, 4) === end.slice(0, 4);
  const startLabel = sameYear
    ? SHORT_DATE_FORMATTER.format(new Date(`${start}T00:00:00Z`))
    : DATE_FORMATTER.format(new Date(`${start}T00:00:00Z`));
  const endLabel = DATE_FORMATTER.format(new Date(`${end}T00:00:00Z`));
  return `${startLabel} – ${endLabel}`;
}

export function formatLast4(last4: string | null | undefined): string {
  if (!last4) return '••••';
  return `••••${last4}`;
}

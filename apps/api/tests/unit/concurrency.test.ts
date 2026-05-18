import { describe, expect, it } from 'vitest';
import { mapWithConcurrency } from '../../src/utils/concurrency.js';

describe('mapWithConcurrency', () => {
  it('preserves input order', async () => {
    const out = await mapWithConcurrency([1, 2, 3, 4, 5], 2, async (n) => n * 10);
    expect(out).toEqual([10, 20, 30, 40, 50]);
  });

  it('never exceeds the concurrency limit', async () => {
    let active = 0;
    let max = 0;
    await mapWithConcurrency(
      Array.from({ length: 20 }, (_, i) => i),
      3,
      async () => {
        active++;
        max = Math.max(max, active);
        await new Promise((r) => setTimeout(r, 5));
        active--;
        return 1;
      },
    );
    expect(max).toBeLessThanOrEqual(3);
  });

  it('handles empty input', async () => {
    const out = await mapWithConcurrency<number, number>([], 4, async (n) => n);
    expect(out).toEqual([]);
  });

  it('throws on non-positive limit', async () => {
    await expect(mapWithConcurrency([1], 0, async (n) => n)).rejects.toThrow();
  });

  it('propagates errors from the mapper', async () => {
    await expect(
      mapWithConcurrency([1, 2, 3], 2, async (n) => {
        if (n === 2) throw new Error('boom');
        return n;
      }),
    ).rejects.toThrow('boom');
  });
});

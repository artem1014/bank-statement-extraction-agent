import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseOcrSidecar } from '../../src/pipeline/ocr-sidecar.js';

const FIXTURE = resolve(import.meta.dirname, '..', '..', '..', '..', 'Bank Statement.rtf');

describe('parseOcrSidecar', () => {
  it('returns empty sidecar shape on minimal input', () => {
    const s = parseOcrSidecar('=== Document Text ===\nhello\n');
    expect(s.documentTextRange).not.toBeNull();
    expect(s.tablesRange).toBeNull();
    expect(s.tableBlocks).toEqual([]);
    expect(s.periods).toEqual([]);
  });

  it('separates Document Text from Tables sections', () => {
    const text = [
      '=== Document Analysis ===',
      'Model used: prebuilt-document',
      '',
      '=== Document Text ===',
      'some prose',
      'Beginning Balance as of 04/01/2025',
      '$597,068.70',
      'Ending Balance as of 04/30/2025',
      '$509,121.59',
      '',
      '=== Tables ===',
      '',
      '=== Table ===',
      'Date | Description | Deposits | Withdrawals | Balance',
      '----',
      'Apr 01 | TEST DEPOSIT | 100.00 |  | 597,168.70',
      '',
    ].join('\n');
    const s = parseOcrSidecar(text, 1);
    expect(s.documentTextRange.start).toBeGreaterThan(0);
    expect(s.tablesRange).not.toBeNull();
    expect(s.tableBlocks.length).toBe(1);
    const t = s.tableBlocks[0];
    expect(t).toBeDefined();
    if (!t) return;
    expect(t.headerRow).not.toBeNull();
    expect(t.headerRow?.slots.date).toBe(0);
    expect(t.headerRow?.slots.description).toBe(1);
    expect(t.headerRow?.slots.deposit).toBe(2);
    expect(t.headerRow?.slots.withdrawal).toBe(3);
    expect(t.dataRows.length).toBe(1);
  });

  it.runIf(existsSync(FIXTURE))(
    'parses the real Ixonia Bank Statement.rtf: 10 periods and >=80 table blocks',
    () => {
      const raw = readFileSync(FIXTURE, 'utf8');
      const s = parseOcrSidecar(raw, 99);
      expect(s.periods.length).toBe(10);
      expect(s.tableBlocks.length).toBeGreaterThanOrEqual(80);
      const headeredTables = s.tableBlocks.filter((b) => b.headerRow !== null);
      expect(headeredTables.length).toBeGreaterThanOrEqual(10);
    },
  );
});

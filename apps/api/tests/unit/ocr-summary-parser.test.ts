import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseOcrSidecar } from '../../src/pipeline/ocr-sidecar.js';
import { parseSummaryBlock } from '../../src/pipeline/ocr-summary-parser.js';

const FIXTURE = resolve(import.meta.dirname, '..', '..', '..', '..', 'Bank Statement.rtf');

describe('parseSummaryBlock', () => {
  it('returns nulls for fields when block is missing', () => {
    const s = parseOcrSidecar(
      [
        '=== Document Text ===',
        'Beginning Balance as of 04/01/2025',
        'Ending Balance as of 04/30/2025',
        '',
      ].join('\n'),
      1,
    );
    expect(s.periods.length).toBe(1);
    const p = s.periods[0];
    if (!p) throw new Error('expected one period');
    const summary = parseSummaryBlock(s, p);
    expect(summary.beginning_balance).toBeNull();
    expect(summary.ending_balance).toBeNull();
    expect(summary.deposits_count).toBeNull();
  });

  it('repairs Document AI internal-space glitch like "$509, 121.59"', () => {
    const s = parseOcrSidecar(
      [
        '=== Document Text ===',
        'Beginning Balance as of 05/01/2025',
        '$509, 121.59',
        '+ Deposits and Credits (95)',
        '$926,416.11',
        '- Withdrawals and Debits (142)',
        '$1,271,197.35',
        'Ending Balance as of 05/31/2025',
        '$164,340.35',
      ].join('\n'),
      1,
    );
    expect(s.periods.length).toBe(1);
    const p = s.periods[0];
    if (!p) throw new Error('expected one period');
    const summary = parseSummaryBlock(s, p);
    expect(summary.beginning_balance).toBeCloseTo(509121.59, 2);
    expect(summary.ending_balance).toBeCloseTo(164340.35, 2);
    expect(summary.deposits_total).toBeCloseTo(926416.11, 2);
    expect(summary.deposits_count).toBe(95);
    expect(summary.withdrawals_total).toBeCloseTo(1271197.35, 2);
    expect(summary.withdrawals_count).toBe(142);
  });

  it('parses inline-and-next-line balance amounts', () => {
    const s = parseOcrSidecar(
      [
        '=== Document Text ===',
        'Balance Summary',
        'Beginning Balance as of 04/01/2025',
        '$597,068.70',
        '+ Deposits and Credits (81)',
        '$1,214,254.05',
        '- Withdrawals and Debits (111)',
        '$1,302,201.16',
        'Ending Balance as of 04/30/2025',
        '$509,121.59',
      ].join('\n'),
      1,
    );
    expect(s.periods.length).toBe(1);
    const p = s.periods[0];
    if (!p) throw new Error('expected one period');
    const summary = parseSummaryBlock(s, p);
    expect(summary.beginning_balance).toBeCloseTo(597068.7, 2);
    expect(summary.ending_balance).toBeCloseTo(509121.59, 2);
    expect(summary.deposits_total).toBeCloseTo(1214254.05, 2);
    expect(summary.deposits_count).toBe(81);
    expect(summary.withdrawals_total).toBeCloseTo(1302201.16, 2);
    expect(summary.withdrawals_count).toBe(111);
  });

  it.runIf(existsSync(FIXTURE))('parses every period in the real Ixonia fixture', () => {
    const raw = readFileSync(FIXTURE, 'utf8');
    const s = parseOcrSidecar(raw, 99);
    expect(s.periods.length).toBe(10);
    for (const p of s.periods) {
      const summary = parseSummaryBlock(s, p);
      expect(summary.beginning_balance).not.toBeNull();
      expect(summary.ending_balance).not.toBeNull();
      expect(summary.deposits_total).not.toBeNull();
      expect(summary.deposits_count).not.toBeNull();
      expect(summary.withdrawals_total).not.toBeNull();
      expect(summary.withdrawals_count).not.toBeNull();
    }
  });

  it.runIf(existsSync(FIXTURE))('matches the April 2025 reference numbers exactly', () => {
    const raw = readFileSync(FIXTURE, 'utf8');
    const s = parseOcrSidecar(raw, 99);
    const april = s.periods.find((p) => p.start_date === '2025-04-01');
    expect(april).toBeDefined();
    if (!april) return;
    const summary = parseSummaryBlock(s, april);
    expect(summary.beginning_balance).toBeCloseTo(597068.7, 2);
    expect(summary.ending_balance).toBeCloseTo(509121.59, 2);
    expect(summary.deposits_total).toBeCloseTo(1214254.05, 2);
    expect(summary.deposits_count).toBe(81);
    expect(summary.withdrawals_total).toBeCloseTo(1302201.16, 2);
    expect(summary.withdrawals_count).toBe(111);
  });
});

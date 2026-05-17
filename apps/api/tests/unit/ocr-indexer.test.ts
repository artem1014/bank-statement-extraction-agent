import { describe, expect, it } from 'vitest';
import { mapOcrPeriodsToPageRanges, parseOcrPeriods } from '../../src/pipeline/ocr-indexer.js';

const FIXTURE = `
=== Document Analysis ===
Model used: prebuilt-document
=== Document Text ===
Ixonia Bank
Account Number XXXXXX4664 Statement Date 04/30/2025 Statement Thru Date 04/30/2025 Page 1 of 9
Beginning Balance as of 04/01/2025
Some transactions...
Ending Balance as of 04/30/2025
Page 9 of 9
Ixonia Bank
Account Number XXXXXX4664 Statement Date 05/30/2025 Statement Thru Date 06/01/2025 Page 1 of 11
Beginning Balance as of 05/01/2025
More transactions...
Ending Balance as of 05/31/2025
Page 11 of 11
Ixonia Bank
Account Number XXXXXX4623 Statement Date 09/30/2024 Statement Thru Date 09/30/2024 Page 1 of 3
Beginning Balance as of 09/01/2024
A tiny statement
Ending Balance as of 09/30/2024
Page 3 of 3
=== Tables ===
Beginning Balance as of 04/01/2025
Ending Balance as of 04/30/2025
`;

describe('ocr-indexer.parseOcrPeriods', () => {
  it('finds all three periods, ignoring the Tables section duplicates', () => {
    const periods = parseOcrPeriods(FIXTURE);
    expect(periods).toHaveLength(3);
    expect(periods[0]).toMatchObject({
      start_date: '2025-04-01',
      end_date: '2025-04-30',
      account_last4: '4664',
      bank: 'Ixonia Bank',
    });
    expect(periods[1]).toMatchObject({
      start_date: '2025-05-01',
      end_date: '2025-05-31',
      account_last4: '4664',
    });
    expect(periods[2]).toMatchObject({
      start_date: '2024-09-01',
      end_date: '2024-09-30',
      account_last4: '4623',
    });
  });

  it('returns no periods when the OCR has no balance markers', () => {
    expect(parseOcrPeriods('hello world')).toEqual([]);
  });
});

describe('ocr-indexer.mapOcrPeriodsToPageRanges', () => {
  it('maps periods to absolute page ranges using "Page X of Y" markers', () => {
    const periods = parseOcrPeriods(FIXTURE);
    const mapped = mapOcrPeriodsToPageRanges(FIXTURE, periods, 23);
    expect(mapped).toHaveLength(3);
    expect(mapped[0]).toMatchObject({ absoluteStartPage: 1, absoluteEndPage: 9 });
    expect(mapped[1]).toMatchObject({ absoluteStartPage: 10, absoluteEndPage: 20 });
    expect(mapped[2]).toMatchObject({ absoluteStartPage: 21, absoluteEndPage: 23 });
  });

  it('absorbs drift in the last period when sums do not match totalPdfPages', () => {
    const periods = parseOcrPeriods(FIXTURE);
    const mapped = mapOcrPeriodsToPageRanges(FIXTURE, periods, 25);
    expect(mapped[2]?.absoluteEndPage).toBe(25);
  });
});

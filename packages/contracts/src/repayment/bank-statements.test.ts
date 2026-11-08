import { describe, expect, it } from 'vitest';
import {
  mapStatementRows,
  parseStatementAmount,
  parseStatementDay,
  readCsv,
} from './bank-statements.js';

describe('a bank statement read (task 6-3)', () => {
  it('amounts in any digits and separators, rials or tomans', () => {
    expect(parseStatementAmount('۱۲٬۵۰۰٬۰۰۰', 'rial')).toBe(12_500_000n);
    expect(parseStatementAmount('١٢٥٠', 'toman')).toBe(12_500n);
    expect(parseStatementAmount('1,250,000', 'rial')).toBe(1_250_000n);
    expect(parseStatementAmount('-500', 'rial')).toBeNull();
    expect(parseStatementAmount('12.5', 'rial')).toBeNull();
    expect(parseStatementAmount('', 'rial')).toBeNull();
  });

  it('days in Jalali or Gregorian, any digits', () => {
    expect(parseStatementDay('۱۴۰۵/۰۷/۱۴')).toBe('2026-10-06');
    expect(parseStatementDay('1405-7-14')).toBe('2026-10-06');
    expect(parseStatementDay('2026/10/06')).toBe('2026-10-06');
    expect(parseStatementDay('1405/13/01')).toBeNull();
    expect(parseStatementDay('2026-02-30')).toBeNull();
    expect(parseStatementDay('دیروز')).toBeNull();
  });

  it('maps rows, keeps a row that does not fit as invalid, skips empty ones', () => {
    const rows = [
      ['تاریخ', 'مبلغ', 'پیگیری', 'شرح'],
      ['۱۴۰۵/۰۷/۱۴', '۵۰۰٬۰۰۰', 'TRK ۱۲۳', 'واریز'],
      ['', '', '', ''],
      ['1405/07/15', 'abc', 'TRK 9', ''],
    ];
    const mapped = mapStatementRows(rows, {
      dateColumn: 0,
      amountColumn: 1,
      refColumn: 2,
      descriptionColumn: 3,
      amountUnit: 'toman',
      headerRow: true,
    });
    expect(mapped).toEqual([
      {
        rowNo: 2,
        paidOn: '2026-10-06',
        amountRial: 5_000_000n,
        bankRef: 'TRK ۱۲۳',
        bankRefNorm: 'TRK123',
        description: 'واریز',
        invalid: null,
      },
      expect.objectContaining({ rowNo: 4, invalid: 'bad_amount', amountRial: null }),
    ]);
  });

  it('reads CSV with quotes, doubled quotes, CRLF and a BOM', () => {
    expect(readCsv('﻿a,"b,c","d""e"\r\n1,2,3\n', 10)).toEqual([
      ['a', 'b,c', 'd"e'],
      ['1', '2', '3'],
    ]);
    expect(() => readCsv('a\nb\nc\n', 2)).toThrow(RangeError);
  });
});

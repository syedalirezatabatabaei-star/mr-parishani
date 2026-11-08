import { describe, expect, it } from 'vitest';
import { formatRial, formatToman, groupedDigits, parseRial } from './money.js';

describe('money for people (ADR-035)', () => {
  it('shows whole tomans as tomans', () => {
    expect(formatToman(12_500_000n)).toBe('۱٬۲۵۰٬۰۰۰ تومان');
    expect(formatToman('90')).toBe('۹ تومان');
    expect(formatToman(0n)).toBe('۰ تومان');
  });

  it('never drops the rials a toman cannot hold', () => {
    expect(formatToman(246_914n)).toBe('۲۴٬۶۹۱ تومان و ۴ ریال');
    expect(formatToman('6')).toBe('۰ تومان و ۶ ریال');
    expect(formatToman(-15n)).toBe('−۱ تومان و ۵ ریال');
  });

  it('shows rials exactly, grouped by three', () => {
    expect(formatRial(1_234_567n)).toBe('۱٬۲۳۴٬۵۶۷ ریال');
    expect(groupedDigits(1000)).toBe('۱٬۰۰۰');
  });

  it('refuses what is not a whole rial', () => {
    expect(() => formatToman(1.5)).toThrow(RangeError);
    expect(() => formatToman('12.5')).toThrow(RangeError);
  });

  it('reads rials typed in any digits and separators', () => {
    expect(parseRial('۱٬۲۳۴٬۵۶۷')).toBe(1_234_567n);
    expect(parseRial('1,234 567')).toBe(1_234_567n);
    expect(parseRial('١٢٣')).toBe(123n);
    expect(parseRial('12.5')).toBeNull();
    expect(parseRial('')).toBeNull();
  });

  it('a sum of parts shown is the sum of the whole, to the rial', () => {
    // Share 1,234,570 rials, down payment 20%: the parts shown add up exactly.
    const share = 1_234_570n;
    const down = (share * 2000n) / 10_000n;
    const loan = share - down;
    expect(formatToman(down)).toBe('۲۴٬۶۹۱ تومان و ۴ ریال');
    expect(formatToman(loan)).toBe('۹۸٬۷۶۵ تومان و ۶ ریال');
    expect(down + loan).toBe(share);
  });
});

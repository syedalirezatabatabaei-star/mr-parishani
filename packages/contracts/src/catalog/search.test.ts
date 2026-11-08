import { describe, expect, it } from 'vitest';
import { searchKey, searchQuerySchema } from './search.js';

describe('searchKey (doc 08 §15 test 12)', () => {
  it('makes «علي» and «علی», «۱۴۰۵», «١٤٠٥» and «1405» the same', () => {
    expect(searchKey('علي')).toBe(searchKey('علی'));
    expect(searchKey('كلينيك')).toBe('کلینیک');
    expect(searchKey('۱۴۰۵')).toBe('1405');
    expect(searchKey('١٤٠٥')).toBe('1405');
  });

  it('treats a half-space as a space, folds case and spaces, and is idempotent', () => {
    expect(searchKey('علی‌رضا')).toBe('علی رضا');
    expect(searchKey('  Dr.   ALI ')).toBe('dr. ali');
    const once = searchKey('دكتر  علي‌رضا ۱۲');
    expect(searchKey(once)).toBe(once);
  });
});

describe('searchQuerySchema', () => {
  const parse = (query: Record<string, string>) => searchQuerySchema.parse(query);

  it('normalizes every term, so the four spellings of test 12 are one search', () => {
    expect(parse({ q: 'علي' })).toEqual(parse({ q: 'علی' }));
    expect(parse({ q: '۱۴۰۵' })).toEqual(parse({ q: '1405' }));
    expect(parse({ doctorName: 'علي', centerName: 'كلينيك ۱۴۰۵' })).toEqual({
      doctorName: 'علی',
      centerName: 'کلینیک 1405',
    });
  });

  it('reads prices as whole rials and pages in any digit script', () => {
    expect(
      parse({ minPriceRial: '۵۰۰۰۰۰', maxPriceRial: '900000', page: '۲', pageSize: '20' }),
    ).toEqual({ minPriceRial: 500_000n, maxPriceRial: 900_000n, page: 2, pageSize: 20 });
  });

  it('refuses a reversed price range, oversized pages and one-letter terms', () => {
    expect(searchQuerySchema.safeParse({ minPriceRial: '9', maxPriceRial: '1' }).success).toBe(
      false,
    );
    expect(searchQuerySchema.safeParse({ pageSize: '21' }).success).toBe(false);
    expect(searchQuerySchema.safeParse({ page: '0' }).success).toBe(false);
    expect(searchQuerySchema.safeParse({ q: 'ع' }).success).toBe(false);
    expect(searchQuerySchema.safeParse({ cityCode: 'Tehran' }).success).toBe(false);
    expect(searchQuerySchema.safeParse({ freeBy: '2026-10-05' }).success).toBe(true);
    expect(searchQuerySchema.safeParse({ freeBy: 'tomorrow' }).success).toBe(false);
  });
});

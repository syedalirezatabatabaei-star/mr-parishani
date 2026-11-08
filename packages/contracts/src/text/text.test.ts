import { describe, expect, it } from 'vitest';
import { normalizeDigits, toPersianDigits } from './digits.js';
import { normalizeMobile } from './mobile.js';
import { isValidNationalId, normalizeNationalId } from './national-id.js';
import { normalizePersianText } from './persian.js';

const ZWNJ = '\u200C';

describe('digits', () => {
  it('turns Persian and Arabic digits into ASCII', () => {
    expect(normalizeDigits('۰۱۲۳۴۵۶۷۸۹')).toBe('0123456789');
    expect(normalizeDigits('٠١٢٣٤٥٦٧٨٩')).toBe('0123456789');
    expect(normalizeDigits('قسط ۳ از ١٢')).toBe('قسط 3 از 12');
  });

  it('turns ASCII digits into Persian for display', () => {
    expect(toPersianDigits('1405/06/28')).toBe('۱۴۰۵/۰۶/۲۸');
    expect(toPersianDigits(1200)).toBe('۱۲۰۰');
    expect(toPersianDigits(12_000_000_000n)).toBe('۱۲۰۰۰۰۰۰۰۰۰');
  });
});

describe('normalizePersianText', () => {
  it.each([
    ['علي', 'علی'], // Arabic yeh
    ['موسى', 'موسی'], // alef maksura
    ['كاظم', 'کاظم'], // Arabic kaf
    ['ﻛﺎﻇﻢ', 'کاظم'], // presentation forms
    ['مـــحمد', 'محمد'], // tatweel
    ['پلاک ۱۲ و ٣٤', 'پلاک 12 و 34'],
    ['  علی   رضایی  ', 'علی رضایی'],
    ['علی\u00A0\tرضایی', 'علی رضایی'], // NBSP and tab
    [`می${ZWNJ}${ZWNJ}روم`, `می${ZWNJ}روم`],
    [`می ${ZWNJ}روم`, 'می روم'], // ZWNJ next to a space
    [`${ZWNJ}علی${ZWNJ}`, 'علی'],
    ['علی\u200Bرضا', 'علیرضا'], // zero-width space
    ['\u200Fعلی\u200E', 'علی'], // bidi marks
    ['خط یک  \r\n  خط دو', 'خط یک\nخط دو'],
  ])('%j → %j', (input, expected) => {
    expect(normalizePersianText(input)).toBe(expected);
  });

  it('keeps diacritics and a correct half-space', () => {
    expect(normalizePersianText(`کتاب${ZWNJ}ها`)).toBe(`کتاب${ZWNJ}ها`);
    expect(normalizePersianText('مُحَمَّد')).toBe('مُحَمَّد');
  });

  it('makes Arabic and Persian spellings equal', () => {
    expect(normalizePersianText('علي كريمي')).toBe(normalizePersianText('علی کریمی'));
  });

  it('is idempotent', () => {
    const samples = [`  كاظم  ${ZWNJ} زاده ـ ۱۲۳\r\n\n  ${ZWNJ}${ZWNJ}ي `, 'ﻛﺎﻇﻢ\u200B\u200F', ''];
    for (const s of samples) {
      const once = normalizePersianText(s);
      expect(normalizePersianText(once)).toBe(once);
    }
  });
});

describe('normalizeMobile', () => {
  it.each([
    '9121234567',
    '09121234567',
    '+989121234567',
    '00989121234567',
    '989121234567',
    '0912 123 4567',
    '0912-123-4567',
    '(0912) 123.4567',
    '۰۹۱۲۱۲۳۴۵۶۷',
    '٠٩١٢١٢٣٤٥٦٧',
    '+۹۸ ۹۱۲ ۱۲۳ ۴۵۶۷',
  ])('%j → 9121234567', (input) => {
    expect(normalizeMobile(input)).toBe('9121234567');
  });

  it.each([
    '912123456', // too short
    '091212345678', // too long
    '02112345678', // landline
    '8121234567',
    '+19121234567',
    '0912abc4567',
    '',
  ])('rejects %j', (input) => {
    expect(normalizeMobile(input)).toBeNull();
  });

  it('is idempotent', () => {
    const once = normalizeMobile('+98 912 123 4567');
    expect(once).not.toBeNull();
    expect(normalizeMobile(once ?? '')).toBe(once);
  });
});

describe('national ID', () => {
  // Checked by hand against the algorithm:
  //   0084575948: s = 212, r = 3, check = 11 − 3 = 8
  //   0000000140: s = 11,  r = 0, check = 0
  //   0000000061: s = 12,  r = 1, check = 1
  //   0000000019: s = 2,   r = 2, check = 9
  //   0123456789: s = 156, r = 2, check = 11 − 2 = 9
  it.each(['0084575948', '0000000140', '0000000061', '0000000019', '0123456789'])(
    '%s is valid',
    (id) => {
      expect(isValidNationalId(id)).toBe(true);
    },
  );

  it.each([
    '0084575949', // wrong check digit
    '0084575940',
    '1111111111', // passes the checksum, but repeated digits are not issued
    '0000000000',
    '084575948', // the validator itself is strict: only normalizeNationalId pads
    '00845759480',
    '008457594a',
    '',
  ])('%j is invalid', (id) => {
    expect(isValidNationalId(id)).toBe(false);
  });

  it('normalizes digits and separators and keeps leading zeros', () => {
    expect(normalizeNationalId('۰۰۸۴۵۷۵۹۴۸')).toBe('0084575948');
    expect(normalizeNationalId('٠٠٨٤٥٧٥٩٤٨')).toBe('0084575948');
    expect(normalizeNationalId('008-457594-8')).toBe('0084575948');
    expect(normalizeNationalId(' 008 457 5948 ')).toBe('0084575948');
  });

  it('restores leading zeros lost from 8- or 9-digit input, then checks the checksum', () => {
    // Two zeros lost.
    expect(normalizeNationalId('84575948')).toBe('0084575948');
    expect(normalizeNationalId('۸۴۵۷۵۹۴۸')).toBe('0084575948');
    // One zero lost.
    expect(normalizeNationalId('084575948')).toBe('0084575948');
    expect(normalizeNationalId('123456789')).toBe('0123456789');
    expect(normalizeNationalId('123-456789')).toBe('0123456789');
  });

  it.each([
    '0084575949', // ten digits, wrong check digit
    '84575949', // eight digits, wrong check digit after padding
    '123456788', // nine digits, wrong check digit after padding
    '4575948', // seven digits: too short to pad
    '1', // too short to pad
    '00845759480', // eleven digits
    '12345678901',
    '00000000', // pads to 0000000000: repeated digits
    '8457594a',
    '',
  ])('returns null for %j', (input) => {
    expect(normalizeNationalId(input)).toBeNull();
  });

  it('is idempotent', () => {
    for (const input of ['۰۰۸-۴۵۷۵۹۴-۸', '84575948', '123456789']) {
      const once = normalizeNationalId(input);
      expect(once).not.toBeNull();
      expect(normalizeNationalId(once ?? '')).toBe(once);
    }
  });
});

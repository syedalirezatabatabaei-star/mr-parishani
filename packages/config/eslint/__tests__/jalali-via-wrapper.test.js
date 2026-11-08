// @ts-check
import { RuleTester } from 'eslint';
import tseslint from 'typescript-eslint';
import { describe, it } from 'vitest';
import { jalaliViaWrapper } from '../rules/jalali-via-wrapper.js';

RuleTester.describe = describe;
RuleTester.it = it;

const ruleTester = new RuleTester({ languageOptions: { parser: tseslint.parser } });

/** @param {string} name */
const library = (name) => [{ messageId: 'library', data: { name } }];
const intlCalendar = [{ messageId: 'intlCalendar' }];
/** @param {string} locale */
const persianLocale = (locale) => [{ messageId: 'persianLocale', data: { locale } }];

ruleTester.run('jalali-via-wrapper', jalaliViaWrapper, {
  valid: [
    // The wrapper is the way in.
    "import { toJalali, formatJalaliDate } from '@sepehr/contracts';",
    // Unrelated packages whose names merely contain the word.
    "import x from 'jalaali-js-extra';",
    // Gregorian or explicit non-Persian calendars.
    "new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Tehran' });",
    "new Intl.DateTimeFormat('fa-IR-u-ca-gregory');",
    "new Intl.DateTimeFormat('fa-IR', { calendar: 'gregory' });",
    "date.toLocaleDateString('en-GB');",
    // Number formatting in Persian is fine.
    "new Intl.NumberFormat('fa-IR').format(1200);",
    "(1200).toLocaleString('fa-IR');",
    // A property named calendar with another value.
    "const opts = { calendar: 'islamic' };",
  ],
  invalid: [
    { code: "import jalaali from 'jalaali-js';", errors: library('jalaali-js') },
    { code: "import { toJalaali } from 'jalaali-js';", errors: library('jalaali-js') },
    { code: "import type { JalaaliDate } from 'jalaali-js';", errors: library('jalaali-js') },
    { code: "export { toJalaali } from 'jalaali-js';", errors: library('jalaali-js') },
    { code: "export * from 'jalaali-js';", errors: library('jalaali-js') },
    { code: "const j = await import('jalaali-js');", errors: library('jalaali-js') },
    { code: "const j = require('jalaali-js');", errors: library('jalaali-js') },
    { code: 'const j = require(`jalaali-js`);', errors: library('jalaali-js') },
    { code: "import j = require('jalaali-js');", errors: library('jalaali-js') },
    {
      code: "import x from 'jalaali-js/dist/index.js';",
      errors: library('jalaali-js/dist/index.js'),
    },
    { code: "import moment from 'moment-jalaali';", errors: library('moment-jalaali') },
    { code: "import { format } from 'date-fns-jalali';", errors: library('date-fns-jalali') },
    // Intl with the Persian calendar.
    { code: "new Intl.DateTimeFormat('en-US', { calendar: 'persian' });", errors: intlCalendar },
    { code: "const opts = { 'calendar': 'Persian' };", errors: intlCalendar },
    { code: "new Intl.DateTimeFormat('en-US-u-ca-persian');", errors: intlCalendar },
    { code: "const tag = 'fa-IR-u-nu-latn-ca-persian';", errors: intlCalendar },
    // Persian locales default to the Persian calendar.
    { code: "new Intl.DateTimeFormat('fa-IR');", errors: persianLocale('fa-IR') },
    { code: "Intl.DateTimeFormat('fa');", errors: persianLocale('fa') },
    { code: "new DateTimeFormat('fa-IR');", errors: persianLocale('fa-IR') },
    { code: "new Intl.DateTimeFormat(['fa-IR', 'en']);", errors: persianLocale('fa-IR') },
    // A -u- extension without a calendar keeps the Persian default.
    {
      code: "new Intl.DateTimeFormat('fa-IR-u-nu-latn');",
      errors: persianLocale('fa-IR-u-nu-latn'),
    },
    // `ca` after a private-use singleton is not part of the -u- extension.
    {
      code: "new Intl.DateTimeFormat('fa-u-nu-latn-x-ca-gregory');",
      errors: persianLocale('fa-u-nu-latn-x-ca-gregory'),
    },
    { code: "date.toLocaleDateString('fa-IR');", errors: persianLocale('fa-IR') },
    {
      code: "date.toLocaleDateString('fa-IR', { timeZone: 'Asia/Tehran' });",
      errors: persianLocale('fa-IR'),
    },
    { code: 'date.toLocaleDateString(`fa`);', errors: persianLocale('fa') },
  ],
});

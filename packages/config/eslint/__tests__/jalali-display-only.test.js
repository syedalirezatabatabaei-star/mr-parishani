// @ts-check
import { RuleTester } from 'eslint';
import tseslint from 'typescript-eslint';
import { describe, it } from 'vitest';
import { jalaliDisplayOnly } from '../rules/jalali-display-only.js';

RuleTester.describe = describe;
RuleTester.it = it;

const ruleTester = new RuleTester({
  languageOptions: {
    parser: tseslint.parser,
    parserOptions: { ecmaFeatures: { jsx: true } },
  },
});

/** @param {string} method */
const localeDate = (method) => [{ messageId: 'localeDate', data: { method } }];
/** @param {string} method */
const rawDate = (method) => [{ messageId: 'rawDate', data: { method } }];
const intlDate = [{ messageId: 'intlDate' }];

ruleTester.run('jalali-display-only', jalaliDisplayOnly, {
  valid: [
    // The wrapper and the Calendar are the way dates reach the screen.
    'const shown = <p>{formatJalaliDate(toJalali(at))}</p>;',
    'const shown = <p>{formatJalaliDateTime(at)}</p>;',
    // A timestamp for the API or a key is not shown.
    'const url = `/api/slots?from=${from.toISOString()}`;',
    'const key = at.toISOString();',
    'fetch(`/x?at=${at.toISOString()}`);',
    // <time dateTime> is machine-readable (HTML requires ISO); the content is Jalali.
    '<time dateTime={at.toISOString()}>{formatJalaliDateTime(at)}</time>;',
    // Computed in a callback, not written into the page.
    '<button onClick={() => send(at.toISOString())}>ثبت</button>;',
    // Numbers in Persian are fine; toLocaleString cannot be told from number formatting.
    "const n = <p>{new Intl.NumberFormat('fa-IR').format(1200)}</p>;",
    "const n = <p>{(1200).toLocaleString('fa-IR')}</p>;",
  ],
  invalid: [
    { code: '<p>{at.toLocaleDateString()}</p>;', errors: localeDate('toLocaleDateString') },
    { code: "const t = at.toLocaleDateString('fa-IR');", errors: localeDate('toLocaleDateString') },
    { code: "const t = at.toLocaleTimeString('en-US');", errors: localeDate('toLocaleTimeString') },
    { code: '<p>{at.toISOString()}</p>;', errors: rawDate('toISOString') },
    { code: '<p>{`شروع: ${at.toISOString()}`}</p>;', errors: rawDate('toISOString') },
    {
      code: '<time dateTime={at.toISOString()} title={at.toUTCString()} />;',
      errors: rawDate('toUTCString'),
    },
    { code: '<span title={at.toISOString()}>x</span>;', errors: rawDate('toISOString') },
    { code: '<p>{at.toDateString()}</p>;', errors: rawDate('toDateString') },
    { code: "new Intl.DateTimeFormat('en-US').format(at);", errors: intlDate },
    { code: "Intl.DateTimeFormat('fa-IR-u-ca-gregory').format(at);", errors: intlDate },
  ],
});

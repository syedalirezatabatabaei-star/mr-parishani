// @ts-check
import { base } from '@sepehr/config/eslint';

export default [
  ...base(import.meta.dirname),
  {
    // These schemas reach the browser: `import { z }` keeps zod's whole namespace, every
    // locale included (~90 KB gzip on each patient page); `import * as z` lets it be shaken.
    rules: {
      'no-restricted-syntax': [
        'error',
        {
          selector: "ImportDeclaration[source.value='zod'] > ImportSpecifier[imported.name='z']",
          message: "Use `import * as z from 'zod'`.",
        },
      ],
    },
  },
  {
    // The Jalali wrapper itself, and the test that checks it against Intl's Persian calendar.
    files: ['src/jalali/calendar.ts', 'src/jalali/intl-cross-check.test.ts'],
    rules: { 'sepehr/jalali-via-wrapper': 'off' },
  },
];

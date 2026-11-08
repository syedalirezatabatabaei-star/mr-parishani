// @ts-check
import { base } from './eslint/index.js';

export default [
  ...base(import.meta.dirname),
  {
    // The rule's own tests hold the forbidden code as sample strings.
    files: ['eslint/__tests__/jalali-via-wrapper.test.js'],
    rules: { 'sepehr/jalali-via-wrapper': 'off' },
  },
];

// @ts-check
import { base } from '@sepehr/config/eslint';

export default [
  { ignores: ['.stack/**', 'test-results/**', 'playwright-report/**'] },
  ...base(import.meta.dirname),
];

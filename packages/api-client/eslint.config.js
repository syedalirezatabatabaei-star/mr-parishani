// @ts-check
import { base } from '@sepehr/config/eslint';

export default [
  // Generated from openapi.json (`pnpm generate`); checked against it by a test, never edited.
  { ignores: ['src/openapi.ts'] },
  ...base(import.meta.dirname),
];

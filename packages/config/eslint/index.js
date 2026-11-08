// @ts-check
import js from '@eslint/js';
import nextPlugin from '@next/eslint-plugin-next';
import reactHooks from 'eslint-plugin-react-hooks';
import globals from 'globals';
import tseslint from 'typescript-eslint';
import { jalaliDisplayOnly } from './rules/jalali-display-only.js';
import { jalaliViaWrapper } from './rules/jalali-via-wrapper.js';
import { noCrossModuleImport } from './rules/no-cross-module-import.js';

export const sepehrPlugin = {
  meta: { name: 'eslint-plugin-sepehr' },
  rules: {
    'jalali-display-only': jalaliDisplayOnly,
    'jalali-via-wrapper': jalaliViaWrapper,
    'no-cross-module-import': noCrossModuleImport,
  },
};

const ignores = {
  ignores: ['**/dist/**', '**/.next/**', '**/.turbo/**', '**/coverage/**', '**/next-env.d.ts'],
};

/**
 * Base config for every package: type-aware strict TypeScript rules, and Jalali dates only
 * through the wrapper in @sepehr/contracts.
 * @param {string} tsconfigRootDir directory of the package's tsconfig.json
 */
export function base(tsconfigRootDir) {
  return tseslint.config(
    ignores,
    js.configs.recommended,
    tseslint.configs.strictTypeChecked,
    {
      languageOptions: {
        globals: globals.node,
        parserOptions: { projectService: true, tsconfigRootDir },
      },
    },
    {
      // Plain JS and tool config files are outside the TypeScript project.
      files: ['**/*.{js,mjs,cjs}', '*.config.{ts,mts}'],
      extends: [tseslint.configs.disableTypeChecked],
    },
    {
      // Jalali dates only through the wrapper in @sepehr/contracts (see the rule).
      plugins: { sepehr: sepehrPlugin },
      rules: { 'sepehr/jalali-via-wrapper': 'error' },
    },
  );
}

/**
 * NestJS API: base rules plus the hard module boundary (ADR-002).
 * @param {string} tsconfigRootDir
 */
export function api(tsconfigRootDir) {
  return tseslint.config(
    base(tsconfigRootDir),
    {
      files: ['src/modules/**/*.{ts,js}'],
      plugins: { sepehr: sepehrPlugin },
      rules: { 'sepehr/no-cross-module-import': 'error' },
    },
    {
      // Nest modules are empty classes carrying a decorator.
      rules: { '@typescript-eslint/no-extraneous-class': ['error', { allowWithDecorator: true }] },
    },
  );
}

/**
 * React library (packages/ui), and through next() the web and admin apps: every date on screen
 * goes through the Jalali wrapper or the Calendar (ADR-011; rule jalali-display-only).
 * @param {string} tsconfigRootDir
 */
export function react(tsconfigRootDir) {
  return tseslint.config(
    base(tsconfigRootDir),
    reactHooks.configs.flat['recommended-latest'],
    { languageOptions: { globals: globals.browser } },
    {
      plugins: { sepehr: sepehrPlugin },
      rules: { 'sepehr/jalali-display-only': 'error' },
    },
  );
}

/**
 * Next.js apps (apps/web, apps/admin).
 * @param {string} tsconfigRootDir
 */
export function next(tsconfigRootDir) {
  return tseslint.config(react(tsconfigRootDir), nextPlugin.configs['core-web-vitals']);
}

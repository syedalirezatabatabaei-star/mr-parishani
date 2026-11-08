import { vitestBase } from '@sepehr/config/vitest';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  ...vitestBase,
  test: { ...vitestBase.test, include: ['app/**/*.test.{ts,tsx}', 'lib/**/*.test.{ts,tsx}'] },
});

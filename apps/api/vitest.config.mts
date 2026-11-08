import { vitestBase } from '@sepehr/config/vitest';
import swc from 'unplugin-swc';
import { defineConfig } from 'vitest/config';

// SWC emits the decorator metadata that NestJS dependency injection needs.
export default defineConfig({
  ...vitestBase,
  plugins: [swc.vite({ module: { type: 'es6' } })],
});

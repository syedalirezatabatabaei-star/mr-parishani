// @ts-check
/** Shared Vitest defaults. Packages spread this into their own `defineConfig`. */
export const vitestBase = {
  test: {
    include: [
      'src/**/*.test.{ts,tsx}',
      'test/**/*.test.{ts,tsx}',
      '**/__tests__/**/*.test.{js,ts}',
    ],
    // Integration tests need Docker and run only through `test:integration`.
    exclude: ['**/node_modules/**', '**/dist/**', '**/.next/**', '**/*.int.test.{ts,tsx}'],
    // Vitest's 5 s default is passed under a parallel turbo run (two `next build`s, typecheck and
    // every package's tests at once) by the heaviest tests alone, never by a failed assertion:
    // the ui calendar, the config scan, the api-client regeneration (RESUME b6, b10, f8).
    testTimeout: 30_000,
  },
};

/**
 * Integration tests (`*.int.test.ts`) start real services with Testcontainers.
 * Containers publish on random host ports, so no port is configured anywhere.
 */
export const vitestIntegration = {
  test: {
    include: ['src/**/*.int.test.{ts,tsx}', 'test/**/*.int.test.{ts,tsx}'],
    exclude: ['**/node_modules/**', '**/dist/**'],
    // Pulling and starting a container can take far longer than a unit test.
    testTimeout: 120_000,
    hookTimeout: 120_000,
  },
};

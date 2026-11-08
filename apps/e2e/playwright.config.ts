import { defineConfig } from '@playwright/test';
import { STACK } from './src/stack-config.ts';

/**
 * End-to-end tests (task 2-11, doc 09 acceptance): the installed Chrome (`channel`), so no
 * browser is downloaded from outside Iran (rules 17–18); the stack of src/stack.ts, or one
 * already running.
 */
export default defineConfig({
  testDir: './tests',
  // The screenshot specs for the owner's review are not acceptance tests: left out of the run,
  // and so of its count, unless VISUAL=1 (RESUME f11). Each still skips itself without it.
  testIgnore: process.env['VISUAL'] === '1' ? [] : ['**/visual-*.spec.ts'],
  timeout: 120_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
  // Stops the stack this run started, then reports what containers and volumes are left.
  globalTeardown: './src/global-teardown.ts',
  use: {
    baseURL: STACK.webUrl,
    channel: 'chrome',
    locale: 'fa-IR',
    timezoneId: 'Asia/Tehran',
    trace: 'retain-on-failure',
  },
  webServer: {
    command: 'node src/stack.ts',
    url: `${STACK.webUrl}/`,
    timeout: 600_000,
    reuseExistingServer: true,
    stdout: 'ignore',
    stderr: 'pipe',
    env: { E2E_STACK_STARTED_BY: 'playwright' },
  },
});

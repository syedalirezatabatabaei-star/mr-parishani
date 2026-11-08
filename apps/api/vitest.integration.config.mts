import { vitestIntegration } from '@sepehr/config/vitest';
import swc from 'unplugin-swc';
import { defineConfig } from 'vitest/config';

/**
 * Files whose tests load the machine for minutes (10,000 leads; 20,000 search entries
 * with a timed p95; ClamAV, which holds its signatures in about 1.5 GB of memory). They
 * run after every other file, one at a time, so none slows another or a parallel file into
 * a timeout, and a measured number is not skewed by them.
 */
const HEAVY = [
  'test/lead/lead.int.test.ts',
  // 10,000 picks of the credit queues: under a full parallel group the CPU, not a lock,
  // stretched them past 900 s (owner, 1405/07/21).
  'test/credit/credit-queues.int.test.ts',
  'test/catalog/search.int.test.ts',
  'test/catalog/profiles.int.test.ts',
  'test/catalog/bulk-import.int.test.ts',
  // Measures the p95 of a month of slots (task 2-5 acceptance).
  'test/booking/calendar.int.test.ts',
  // 5,000 bulk SMS sent by two workers at once (task 6-5 acceptance).
  'test/notification/campaigns.int.test.ts',
];

// SWC emits the decorator metadata that NestJS dependency injection needs.
const plugins = [swc.vite({ module: { type: 'es6' } })];
const { include, exclude, testTimeout, hookTimeout } = vitestIntegration.test;
// Every answer of a route with @ZodResponse is checked against its schema (configureApp).
const env = { SEPEHR_CHECK_RESPONSES: '1' };

export default defineConfig({
  test: {
    // Afterwards, the containers and volumes left behind (report only; owner 1405/07/23).
    globalSetup: ['test/leftovers.global.ts'],
    // About half the cores: the full run saturated all of them (owner, 1405/07/21).
    maxWorkers: '50%',
    projects: [
      {
        plugins,
        test: {
          name: 'integration',
          include,
          exclude: [...exclude, ...HEAVY],
          testTimeout,
          hookTimeout,
          env,
          sequence: { groupOrder: 0 },
        },
      },
      {
        plugins,
        test: {
          name: 'integration-heavy',
          include: HEAVY,
          exclude,
          testTimeout,
          hookTimeout,
          env,
          fileParallelism: false,
          sequence: { groupOrder: 1 },
        },
      },
    ],
  },
});

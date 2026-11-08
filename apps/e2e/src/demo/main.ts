/**
 * The demo commands' entry (docs/decisions/demo-mode-decisions.md): the e2e helpers pointed at
 * the demo's ports and folder, and this process on the demo clock, before anything else loads.
 */
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const root = resolve(import.meta.dirname, '../../../..');
process.env['E2E_API_PORT'] = '3200';
process.env['E2E_WEB_PORT'] = '3201';
process.env['E2E_ADMIN_PORT'] = '3202';
const db = process.env['DEMO_DATABASE'];
process.env['E2E_STACK_DIR'] = resolve(root, 'ops/demo/secrets', db ? `state-${db}` : 'state');
process.env['DEMO_CLOCK_FILE'] = resolve(root, 'ops/demo/clock/faketimerc');
await import(pathToFileURL(resolve(root, 'ops/demo/clock-preload.mjs')).href);
await import('./cli.ts');

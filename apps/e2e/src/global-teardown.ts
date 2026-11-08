import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { CONTROL_URL, STACK_DIR } from './stack-config.ts';

const ROOT = resolve(import.meta.dirname, '../../..');

/** True once the control port no longer answers: the stack has stopped and exited. */
const gone = () =>
  fetch(`${CONTROL_URL}/`).then(
    () => false,
    () => true,
  );

/**
 * After a Playwright run (owner 1405/07/23): the stack is stopped, its containers removed with
 * their volumes, if this run started it; a stack a person started is left running. Then a
 * report of what containers and volumes are left (report only, nothing removed).
 */
export default async function globalTeardown(): Promise<void> {
  const ownerFile = resolve(STACK_DIR, 'owner.json');
  const owner = existsSync(ownerFile)
    ? (JSON.parse(readFileSync(ownerFile, 'utf8')) as { startedBy?: string })
    : {};
  if (owner.startedBy === 'playwright') {
    await fetch(`${CONTROL_URL}/stop`, { method: 'POST' }).catch(() => undefined);
    for (let i = 0; i < 120 && !(await gone()); i++) {
      await new Promise((r) => setTimeout(r, 500));
    }
    rmSync(ownerFile, { force: true });
  }
  spawnSync(process.execPath, [resolve(ROOT, 'scripts/ops/test-leftovers.mjs')], {
    stdio: 'inherit',
  });
}

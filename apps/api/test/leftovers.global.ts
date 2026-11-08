import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

/**
 * After an integration run, HEAVY included (owner 1405/07/23): a report of the containers and
 * volumes left behind. Report only: nothing is removed.
 */
export default function setup(): () => void {
  return () => {
    spawnSync(process.execPath, [resolve(__dirname, '../../../scripts/ops/test-leftovers.mjs')], {
      stdio: 'inherit',
    });
  };
}

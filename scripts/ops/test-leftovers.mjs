#!/usr/bin/env node
/**
 * Report only (owner 1405/07/23): the containers and volumes a test run may have left behind.
 * Lists Testcontainers' containers (any state, Ryuk included), every stopped container, and
 * every volume no container uses, with when each was made. Never removes anything: a removal
 * is the owner's decision. HEAVY and e2e call it at their end; or by hand:
 *
 *   node scripts/ops/test-leftovers.mjs
 */
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

function docker(args) {
  return execFileSync('docker', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
}

/** What is there now, one line per container or volume. */
export function testLeftovers() {
  const fmt = '{{.ID}}|{{.Names}}|{{.Image}}|{{.Status}}|{{.CreatedAt}}';
  const testcontainers = docker([
    'ps',
    '-a',
    '--filter',
    'label=org.testcontainers=true',
    '--format',
    fmt,
  ]);
  const stopped = docker([
    'ps',
    '-a',
    '--filter',
    'status=exited',
    '--filter',
    'status=created',
    '--format',
    fmt,
  ]);
  const volumes = docker([
    'volume',
    'ls',
    '--filter',
    'dangling=true',
    '--format',
    '{{.Name}}',
  ]).map((name) => {
    const [line] = docker([
      'volume',
      'inspect',
      '--format',
      '{{.CreatedAt}}|{{json .Labels}}',
      name,
    ]);
    const [created = '?', labels = '{}'] = (line ?? '').split('|');
    return `${name}|${created}|labels ${labels}`;
  });
  return { testcontainers, stopped, volumes };
}

/** Prints the report; never throws, so a run's result is never changed by it. */
export function reportTestLeftovers(when = '') {
  try {
    const { testcontainers, stopped, volumes } = testLeftovers();
    const section = (title, rows) =>
      `${title}: ${String(rows.length)}${rows.map((r) => `\n  ${r}`).join('')}`;
    console.log(
      [
        `test leftovers${when ? ` ${when}` : ''} (report only, nothing removed):`,
        section('Testcontainers containers', testcontainers),
        section('stopped containers', stopped),
        section('volumes no container uses', volumes),
      ].join('\n'),
    );
  } catch (error) {
    const reason = error instanceof Error ? (error.message.split('\n')[0] ?? '') : 'unknown';
    console.log(`test leftovers: docker not reachable (${reason})`);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  reportTestLeftovers();
}

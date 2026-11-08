/**
 * The demo clock (ops/demo/clock-preload.mjs) under the Date wrapping Next.js does on its
 * server (node-environment-extensions/date.js copies Date's own properties only): Date.UTC and
 * Date.parse lost there broke every panel page that shows a Jalali date (1405/08/09).
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';

const PRELOAD = pathToFileURL(
  resolve(import.meta.dirname, '../../../../ops/demo/clock-preload.mjs'),
).href;

function run(offset: string, script: string) {
  const clock = join(mkdtempSync(join(tmpdir(), 'demo-clock-')), 'faketimerc');
  writeFileSync(clock, offset);
  const done = spawnSync(process.execPath, ['--import', PRELOAD, '-e', script], {
    env: { ...process.env, DEMO_CLOCK_FILE: clock },
    encoding: 'utf8',
  });
  assert.equal(done.status, 0, done.stderr);
  return JSON.parse(done.stdout) as Record<string, unknown>;
}

// What Next.js does to Date, in short: a new function with Date's own property descriptors.
const NEXT_WRAP = `
  const D = Date;
  const props = Object.getOwnPropertyDescriptors(D);
  globalThis.Date = Object.defineProperties(function Date1(...a) {
    return new.target ? Reflect.construct(D, a, new.target) : D();
  }, props);
`;

void test('Date.UTC and Date.parse survive the Next.js wrapping', () => {
  const out = run(
    '+0',
    `${NEXT_WRAP} console.log(JSON.stringify({
      utc: Date.UTC(2026, 9, 31), parse: Date.parse('2026-10-31T00:00:00Z'),
    }))`,
  );
  assert.equal(out['utc'], Date.UTC(2026, 9, 31));
  assert.equal(out['parse'], Date.UTC(2026, 9, 31));
});

void test('now follows the clock file, with and without new', () => {
  const day = 86_400;
  const out = run(
    `-${String(day)}`,
    `${NEXT_WRAP} console.log(JSON.stringify({
      now: Date.now(), made: new Date().getTime(), real: performance.timeOrigin + performance.now(),
    }))`,
  );
  const real = Number(out['real']);
  for (const k of ['now', 'made'])
    assert.ok(Math.abs(Number(out[k]) - (real - day * 1000)) < 5_000, `${k} is a day back`);
});

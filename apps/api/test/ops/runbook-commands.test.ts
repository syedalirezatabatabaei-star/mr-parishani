import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * The runbooks and launch documents (tasks 10-1 to 10-9) are read on a bad day, by someone
 * who types what they say. Every `pnpm …` command they name must exist, and every repository
 * path they point to. Found 1405/07/24: the key-rotation runbook named a root
 * `pnpm security:reencrypt` that only @sepehr/api has.
 */
const repo = path.resolve(__dirname, '../../../..');
const inDir = (dir: string) =>
  readdirSync(path.join(repo, dir))
    .filter((f) => f.endsWith('.md'))
    .map((f) => `${dir}/${f}`);
const DOCUMENTS = [
  ...inDir('docs/runbooks'),
  ...inDir('docs/user-guides'),
  'docs/ops/go-no-go.md',
  'docs/ops/base-data-checklist.md',
  'docs/ops/phase-10-readiness.md',
  'docs/ops/staff-accounts-template.md',
  'docs/decisions/task-10-1-plan.md',
  'docs/decisions/task-10-2-plan.md',
  'docs/decisions/task-10-4-prep.md',
  'docs/security/pentest-package.md',
  'docs/security/pentest-retest-template.md',
  'docs/security/key-rotation-and-backup.md',
  'ops/monitoring/README.md',
];

/** pnpm's own commands, not scripts. */
const BUILT_IN = new Set(['install', 'exec', 'dlx', 'turbo', 'add', 'run']);

const scriptsOf = (file: string) =>
  new Set(
    Object.keys(
      (JSON.parse(readFileSync(path.join(repo, file), 'utf8')) as { scripts?: object }).scripts ??
        {},
    ),
  );

function workspaceScripts(): Map<string, Set<string>> {
  const byName = new Map<string, Set<string>>();
  for (const dir of ['apps', 'packages']) {
    for (const entry of readdirSync(path.join(repo, dir))) {
      const file = `${dir}/${entry}/package.json`;
      if (!existsSync(path.join(repo, file))) continue;
      const { name } = JSON.parse(readFileSync(path.join(repo, file), 'utf8')) as { name: string };
      byName.set(name, scriptsOf(file));
    }
  }
  return byName;
}

/** Text inside backticks: what a reader copies. */
const quoted = (text: string) => [...text.matchAll(/`([^`\n]+)`/g)].map((m) => m[1] ?? '');

describe('the runbooks name commands and paths that exist (task 10-9)', () => {
  const root = scriptsOf('package.json');
  const packages = workspaceScripts();

  it('reads the documents', () => {
    expect(DOCUMENTS.length).toBeGreaterThan(20);
    for (const doc of DOCUMENTS) expect(existsSync(path.join(repo, doc)), doc).toBe(true);
  });

  it('every pnpm command is a root script, a package script, or pnpm’s own', () => {
    let seen = 0;
    for (const doc of DOCUMENTS) {
      const text = readFileSync(path.join(repo, doc), 'utf8');
      for (const snippet of quoted(text)) {
        for (const m of snippet.matchAll(/\bpnpm\s+(?:--filter\s+(\S+)\s+)?([a-z][\w:-]*)/g)) {
          const [, pkg, command = ''] = m;
          seen += 1;
          const where = `${doc}: pnpm ${pkg ? `--filter ${pkg} ` : ''}${command}`;
          if (BUILT_IN.has(command)) continue;
          if (pkg) {
            expect(packages.has(pkg), where).toBe(true);
            expect(packages.get(pkg)?.has(command), where).toBe(true);
          } else {
            expect(root.has(command), where).toBe(true);
          }
        }
      }
    }
    expect(seen).toBeGreaterThan(10);
  });

  it('every repository path exists', () => {
    for (const doc of DOCUMENTS) {
      const text = readFileSync(path.join(repo, doc), 'utf8');
      for (const snippet of quoted(text)) {
        const m = /^((?:apps|packages|docs|ops|scripts)\/\S+?)[.,;)]?(?:[:#].*)?$/.exec(snippet);
        if (!m?.[1] || /[<*{⟨]/.test(m[1])) continue;
        expect(existsSync(path.join(repo, m[1])), `${doc}: ${m[1]}`).toBe(true);
      }
    }
  });
});

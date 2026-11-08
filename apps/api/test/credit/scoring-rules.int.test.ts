import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { runGoldenCases, scoringRulesetSchema, type ScoringRuleset } from '@sepehr/contracts';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { ConfigService } from '../../src/modules/config/config.service';
import { loadGoldenCases, ScoringRulesGuard } from '../../src/modules/credit/scoring-rules.guard';
import {
  call,
  grantRole,
  loggedInAccount,
  startHarness,
  type Harness,
  type LoggedInAccount,
} from '../identity/harness';

/**
 * The scoring rules as versioned configuration (task 3-2; doc 03 §8-3; doc 10 §10 test 1):
 * version 1 is seeded from the client's workbook, a version that breaks a golden case is
 * neither proposed nor approved, and a good one needs a second person.
 */

const KEY = 'credit.scoring_ruleset';
const v1File = resolve(
  __dirname,
  '../../../../packages/contracts/fixtures/scoring/ruleset-v1.json',
);
const v1 = scoringRulesetSchema.parse(JSON.parse(readFileSync(v1File, 'utf8')));
const changed = (edit: (r: ScoringRuleset) => void): ScoringRuleset => {
  const r = structuredClone(v1);
  edit(r);
  return r;
};

let h: Harness;
let strategyA: LoggedInAccount;
let strategyB: LoggedInAccount;
let admin: LoggedInAccount;

const post = (who: LoggedInAccount, path: string, body?: unknown) =>
  call(h, 'POST', path, { bearer: who.access, ...(body === undefined ? {} : { body }) });
const propose = (who: LoggedInAccount, value: unknown) =>
  post(who, '/config/proposals', {
    key: KEY,
    scope: { level: 'global' },
    value,
    reason: 'آزمون قواعد امتیازدهی',
  });
const versions = async () =>
  (await call(h, 'GET', `/config/keys/${KEY}/versions`, { bearer: strategyA.access }))
    .body as unknown as unknown[];

beforeAll(async () => {
  h = await startHarness();
  [strategyA, strategyB, admin] = await Promise.all([
    loggedInAccount(h, 'staff'),
    loggedInAccount(h, 'staff'),
    loggedInAccount(h, 'staff'),
  ]);
  await grantRole(h, strategyA.id, 'strategy_manager');
  await grantRole(h, strategyB.id, 'strategy_manager');
  await grantRole(h, admin.id, 'system_admin');
});

afterAll(async () => {
  await h.close();
});

describe('scoring rules version 1 (migration 0021)', () => {
  it('is the file of the workbook, unchanged, and passes every golden case', async () => {
    const current = await h.app.get(ConfigService).resolve(KEY);
    expect(current.value).toEqual(v1);
    expect(current.level).toBe('global');
    const golden = loadGoldenCases();
    expect(golden.cases.length).toBeGreaterThanOrEqual(40);
    expect(runGoldenCases(current.value, golden)).toEqual([]);
  });
});

describe('activating a new version (doc 03 §8-3)', () => {
  it('refuses a version that breaks a golden case, and stores nothing', async () => {
    const before = (await versions()).length;
    const res = await propose(
      strategyA,
      changed((r) => {
        const alef = r.borrower.grades[0];
        if (alef) alef.minTotal = 81;
      }),
    );
    expect(res.status).toBe(400);
    expect(res.body['error']).toBe('golden_cases_failed');
    expect(res.body['failed']).toBeGreaterThan(0);
    const failures = res.body['failures'] as { id: string }[];
    expect(failures.map((f) => f.id)).toContain('borrower-total-80');
    expect((await versions()).length).toBe(before);
  });

  it('refuses rules that are not rules at all', async () => {
    const res = await propose(
      strategyA,
      changed((r) => {
        r.matrix = r.matrix.slice(1);
      }),
    );
    expect(res.status).toBe(400);
    expect(res.body['error']).toBe('invalid_value');
  });

  it('is not for the system administrator', async () => {
    expect((await propose(admin, v1)).status).toBe(403);
  });

  it('takes a second person; the old version stays what it was', async () => {
    const config = h.app.get(ConfigService);
    const old = await config.resolve(KEY);
    // A raw-data boundary is not in the workbook, so the golden cases still hold.
    const next = changed((r) => {
      const fiveYears = r.raw.tenure.bands[0];
      if (fiveYears) fiveYears.minYears = 6;
    });
    const proposed = await propose(strategyA, next);
    expect(proposed.status).toBe(201);
    const id = proposed.body['id'] as string;

    const self = await post(strategyA, `/config/proposals/${id}/approve`);
    expect(self.status).toBe(403);
    expect(self.body['error']).toBe('second_person_required');

    const approved = await post(strategyB, `/config/proposals/${id}/approve`);
    expect(approved.status).toBe(200);
    const now = await config.resolve(KEY);
    expect(now.versionId).toBe(id);
    expect(now.value.raw.tenure.bands[0]?.minYears).toBe(6);
    // A case scored before keeps its version (rule 16).
    expect((await config.getVersion(KEY, old.versionId)).value).toEqual(old.value);
    expect((await config.resolve(KEY, {}, new Date(Date.now() - 60_000))).versionId).toBe(
      old.versionId,
    );
  });

  it('checks the golden cases again at approval', async () => {
    const proposed = await propose(
      strategyA,
      changed((r) => {
        const band = r.raw.tenure.bands[1];
        if (band) band.minYears = 3;
      }),
    );
    expect(proposed.status).toBe(201);
    const id = proposed.body['id'] as string;
    // As if the golden cases had changed since the proposal.
    const guard = h.app.get(ScoringRulesGuard);
    const spy = vi.spyOn(guard, 'check').mockReturnValueOnce({
      error: 'golden_cases_failed',
      details: { workbook: 'test', failed: 1, of: 1, failures: [] },
    });
    const refused = await post(strategyB, `/config/proposals/${id}/approve`);
    spy.mockRestore();
    expect(refused.status).toBe(409);
    expect(refused.body['error']).toBe('golden_cases_failed');
    const stored = (await versions()) as { id: string; status: string }[];
    expect(stored.find((v) => v.id === id)?.status).toBe('proposed');
  });
});

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  ASSIGNMENT_ENGINE,
  type AssignmentEngine,
} from '../../src/common/lead/assignment-engine.port';
import { DATABASE, type Database } from '../../src/db/database.module';
import {
  grantRole,
  loggedInAccount,
  startHarness,
  type Harness,
  type LoggedInAccount,
} from '../identity/harness';
import { CREDIT_HARNESS, creditWorld, type Body, type Row } from './world';

/**
 * Task 3-5 part D (doc 10 §8): the credit queues on the lead module's engine (doc 05 §6),
 * generalized rather than copied. Acceptance: the new queue's distribution with doc 05's
 * standard (deviation under 2%).
 */

let h: Harness;
let w: Awaited<ReturnType<typeof creditWorld>>;
let strategy: LoggedInAccount;
const specialists: LoggedInAccount[] = [];

const KEY = { queueCode: 'credit', cityCode: 'tehran', treatmentFieldCode: 'dental' } as const;

async function setShares(queueCode: string, shares: { accountId: string; percent: number }[]) {
  const res = await w.staff(strategy, 'PUT', '/lead/assignment/shares', {
    queueCode,
    shares,
    reason: 'سهم صف اعتبار',
  });
  expect(res.status).toBe(200);
}

beforeAll(async () => {
  h = await startHarness(CREDIT_HARNESS);
  w = await creditWorld(h);
  strategy = await loggedInAccount(h, 'staff');
  await grantRole(h, strategy.id, 'strategy_manager');
  for (let i = 0; i < 3; i++) {
    const s = await loggedInAccount(h, 'staff');
    await grantRole(h, s.id, 'credit_specialist');
    specialists.push(s);
  }
  await setShares('completion', [{ accountId: w.completion.id, percent: 100 }]);
}, 120_000);

afterAll(async () => {
  await h.close();
});

describe('assigning applications (doc 10 §8)', () => {
  it('to case completion on submission and to a credit specialist for review; each sees their queue', async () => {
    await setShares(
      'credit',
      specialists.map((s) => ({ accountId: s.id, percent: s === specialists[0] ? 100 : 0 })),
    );
    const { applicationId } = await w.inReview();
    const history = await w.staff(
      w.completion,
      'GET',
      `/credit/applications/${applicationId}/assignments`,
    );
    expect(history.status).toBe(200);
    const rows = history.body as unknown as Body[];
    expect(rows.map((r) => [r['queueCode'], r['accountId'], r['kind']])).toEqual([
      ['completion', w.completion.id, 'auto'],
      ['credit', specialists[0]?.id, 'auto'],
    ]);
    const mine = await w.staff(
      specialists[0] as LoggedInAccount,
      'GET',
      '/credit/applications/queue?queueCode=credit',
    );
    expect((mine.body as unknown as Body[]).map((a) => a['id'])).toContain(applicationId);
    const theirs = await w.staff(
      specialists[1] as LoggedInAccount,
      'GET',
      '/credit/applications/queue?queueCode=credit',
    );
    expect((theirs.body as unknown as Body[]).map((a) => a['id'])).not.toContain(applicationId);
  });

  it('nobody at their cap: unassigned, and the manager is told', async () => {
    await setShares('credit', [{ accountId: specialists[2]?.id ?? '', percent: 100 }]);
    const capped = await w.staff(strategy, 'PUT', `/lead/agents/${specialists[2]?.id ?? ''}/cap`, {
      maxOpenCases: 0,
      reason: 'ظرفیت پر',
    });
    expect(capped.status).toBe(200);
    const { applicationId } = await w.inReview();
    const history = (
      await w.staff(w.completion, 'GET', `/credit/applications/${applicationId}/assignments`)
    ).body as unknown as Body[];
    expect(history.at(-1)).toMatchObject({
      queueCode: 'credit',
      accountId: null,
      kind: 'unassigned',
    });
    const { rows } = await h.owner.query<Row>(
      `SELECT payload FROM outbox_events WHERE event_type = 'credit.unassigned' AND aggregate_id = $1`,
      [applicationId],
    );
    expect(rows).toHaveLength(1);
    await w.staff(strategy, 'PUT', `/lead/agents/${specialists[2]?.id ?? ''}/cap`, {
      maxOpenCases: null,
      reason: 'برگشت',
    });
  });

  it('by hand only with a reason, by the strategy manager, to a staff account', async () => {
    const { applicationId } = await w.inReview();
    const target = specialists[1]?.id ?? '';
    const bare = await w.staff(
      strategy,
      'POST',
      `/credit/applications/${applicationId}/assignments`,
      {
        queueCode: 'credit',
        accountId: target,
      },
    );
    expect(bare.status).toBe(400);
    expect(
      (
        await w.staff(
          w.creditSpecialist,
          'POST',
          `/credit/applications/${applicationId}/assignments`,
          {
            queueCode: 'credit',
            accountId: target,
            reason: 'تقسیم دستی',
          },
        )
      ).status,
    ).toBe(403);
    const patient = await w.patient();
    const notStaff = await w.staff(
      strategy,
      'POST',
      `/credit/applications/${applicationId}/assignments`,
      {
        queueCode: 'credit',
        accountId: patient.id,
        reason: 'تقسیم دستی',
      },
    );
    expect(notStaff.status).toBe(400);
    const done = await w.staff(
      strategy,
      'POST',
      `/credit/applications/${applicationId}/assignments`,
      {
        queueCode: 'credit',
        accountId: target,
        reason: 'تخصص در پرونده‌های دندان',
      },
    );
    expect(done.status).toBe(201);
    expect((done.body as unknown as Body[]).at(-1)).toMatchObject({
      queueCode: 'credit',
      accountId: target,
      kind: 'manual',
    });
    const mine = await w.staff(
      specialists[1] as LoggedInAccount,
      'GET',
      '/credit/applications/queue?queueCode=credit',
    );
    expect((mine.body as unknown as Body[]).map((a) => a['id'])).toContain(applicationId);
  });
});

describe('the credit units’ list (task 3-8)', () => {
  it('filters by state and by one’s own queue, and pages on the server', async () => {
    const { applicationId } = await w.inReview();
    const all = await w.staff(w.creditSpecialist, 'GET', '/credit/applications?pageSize=2');
    expect(all.status).toBe(200);
    expect(all.body).toMatchObject({ page: 1, pageSize: 2 });
    expect((all.body['items'] as Body[]).length).toBeLessThanOrEqual(2);
    expect(all.body['total']).toBeGreaterThanOrEqual(1);
    const reviewing = await w.staff(
      w.creditSpecialist,
      'GET',
      '/credit/applications?status=ready_for_review&pageSize=50',
    );
    const items = reviewing.body['items'] as Body[];
    expect(items.every((a) => a['status'] === 'ready_for_review')).toBe(true);
    expect(items.map((a) => a['id'])).toContain(applicationId);
    expect(
      (await w.staff(w.creditSpecialist, 'GET', '/credit/applications?status=nonsense')).status,
    ).toBe(400);
    expect((await w.staff(w.doctor, 'GET', '/credit/applications')).status).toBe(403);
  });
});

// Last: ten thousand picks take minutes, past the access tokens of beforeAll; the
// tests before it keep theirs.
describe('the credit queue’s distribution (doc 05 §10 test 1, on a new queue)', () => {
  it('10,000 picks at 50/30/20 deviate less than 2%; a zero share gets nothing', async () => {
    const [a, b, c] = specialists.map((s) => s.id);
    const zero = (await loggedInAccount(h, 'staff')).id;
    await setShares('credit', [
      { accountId: a ?? '', percent: 50 },
      { accountId: b ?? '', percent: 30 },
      { accountId: c ?? '', percent: 20 },
      { accountId: zero, percent: 0 },
    ]);
    const engine = h.app.get<AssignmentEngine>(ASSIGNMENT_ENGINE);
    const counts = new Map<string, number>();
    // One transaction per pick, as an assignment is in use; a single transaction for all
    // of them, once past its timeout, kept the engine's lock and stalled the next tests.
    const db = h.app.get<Database>(DATABASE);
    for (let i = 0; i < 10_000; i++) {
      const pick = await db.transaction((tx) =>
        engine.pick(tx, KEY, () => Promise.resolve(new Map())),
      );
      if (pick) counts.set(pick.accountId, (counts.get(pick.accountId) ?? 0) + 1);
    }
    const share = (id: string | undefined) => (counts.get(id ?? '') ?? 0) / 10_000;
    expect(Math.abs(share(a) - 0.5)).toBeLessThan(0.02);
    expect(Math.abs(share(b) - 0.3)).toBeLessThan(0.02);
    expect(Math.abs(share(c) - 0.2)).toBeLessThan(0.02);
    expect(counts.get(zero)).toBeUndefined();
    // About eight queries a pick: minutes, as the lead module's own 10,000 (900 s there).
  }, 900_000);
});

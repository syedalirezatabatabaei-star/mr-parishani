import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PERSON_DIRECTORY, type PersonDirectory } from '@sepehr/contracts';
import { PersonBackfill } from '../../src/modules/identity/person-backfill';
import { LeadImportProcessor } from '../../src/modules/lead/import-processor';
import { LeadIntakeService, type IntakeInput } from '../../src/modules/lead/intake.service';
import { webhookSignature } from '../../src/modules/lead/webhook.service';
import { writeSheet } from '../../src/common/xlsx';
import {
  actorFor,
  call,
  grantRole,
  loggedInAccount,
  relogin,
  newIp,
  newMobile,
  otpLogin,
  startHarness,
  type Harness,
  type LoggedInAccount,
} from '../identity/harness';
import { nationalId } from '../catalog/fixtures';
import { eicar, startScanner, type StartedScanner } from '../support/files';

let h: Harness;
let intake: LeadIntakeService;
let manager: LoggedInAccount;
const SECRET = randomBytes(32).toString('hex');
const OLD_SECRET = randomBytes(32).toString('hex');

type Body = Record<string, unknown>;
const api = (who: LoggedInAccount, method: string, path: string, body?: unknown) =>
  call(h, method, path, { bearer: who.access, ...(body === undefined ? {} : { body }) });

const reason = { reason: 'آزمون سرنخ' };
const system = actorFor('00000000-0000-7000-8000-000000000000');

const lead = (mobile: string, extra: Partial<IntakeInput> = {}): IntakeInput => ({
  mobile,
  treatmentFieldCode: 'dental',
  channel: 'app',
  smsConsent: true,
  ...extra,
});

async function advisor() {
  const a = await loggedInAccount(h, 'staff');
  await grantRole(h, a.id, 'advisor', { kind: 'own' });
  return a;
}

async function setShares(shares: { accountId: string; percent: number }[], extra: Body = {}) {
  const res = await api(manager, 'PUT', '/lead/assignment/shares', {
    queueCode: 'advisory',
    shares,
    ...extra,
    ...reason,
  });
  expect(res.status).toBe(200);
  return res.body['versionId'] as string;
}

async function query<T = Record<string, unknown>>(text: string, values: unknown[] = []) {
  return (await h.owner.query(text, values)).rows as T[];
}

let scanner: StartedScanner;

beforeAll(async () => {
  process.env['LEAD_WEBHOOK_SECRETS_WORDPRESS'] = `${SECRET},${OLD_SECRET}`;
  // Every Excel upload is scanned by ClamAV before it is read (task 2-8).
  scanner = await startScanner();
  Object.assign(process.env, scanner.env);
  h = await startHarness();
  intake = h.app.get(LeadIntakeService);
  manager = await loggedInAccount(h, 'staff');
  await grantRole(h, manager.id, 'strategy_manager');
});

afterAll(async () => {
  await h.close();
  await scanner.container.stop();
});

describe('one person per human (doc 05 §10 test 3)', () => {
  it('two forms of one mobile make one Person; the second is a duplicate of the open case', async () => {
    const a = await advisor();
    await setShares([{ accountId: a.id, percent: 100 }], { cityCode: 'forms' });
    const digits = newMobile();
    const first = await api(a, 'POST', '/lead/intakes', {
      mobile: `0${digits}`,
      treatmentFieldCode: 'dental',
      cityCode: 'forms',
      name: 'علي رضايي',
    });
    expect(first.status).toBe(201);
    expect(first.body).toMatchObject({
      category: 'new',
      caseCreated: true,
      assigneeAccountId: a.id,
    });
    const persian = `+۹۸ ${digits.slice(0, 3)} ${digits.slice(3, 6)}-${digits.slice(6)}`.replace(
      /[0-9]/g,
      (d) => '۰۱۲۳۴۵۶۷۸۹'[Number(d)] ?? d,
    );
    const second = await api(a, 'POST', '/lead/intakes', {
      mobile: persian,
      treatmentFieldCode: 'dental',
      cityCode: 'forms',
    });
    expect(second.status).toBe(201);
    expect(second.body).toMatchObject({
      category: 'duplicate_active',
      personId: first.body['personId'],
      caseId: first.body['caseId'],
      caseCreated: false,
    });
    const people = await query(
      'SELECT count(DISTINCT person_id)::int AS n FROM person_mobiles WHERE mobile = $1',
      [digits],
    );
    expect(people[0]?.['n']).toBe(1);
    // The name is normalized before it is stored (rule 23).
    const [person] = await query('SELECT display_name FROM persons WHERE id = $1', [
      first.body['personId'],
    ]);
    expect(person?.['display_name']).toBe('علی رضایی');
  });
});

describe('weighted round-robin (doc 05 §10 tests 1 and 2)', () => {
  it('10,000 leads at 50/30/20 deviate less than 2%; a zero share gets nothing', async () => {
    const [x, y, z, zero] = await Promise.all([advisor(), advisor(), advisor(), advisor()]);
    const versionId = await setShares(
      [
        { accountId: x.id, percent: 50 },
        { accountId: y.id, percent: 30 },
        { accountId: z.id, percent: 20 },
        { accountId: zero.id, percent: 0 },
      ],
      { cityCode: 'dist' },
    );
    const total = 10_000;
    const mobiles = Array.from({ length: total }, (_, i) => `93${String(i).padStart(8, '0')}`);
    for (let i = 0; i < total; i += 50) {
      await Promise.all(
        mobiles.slice(i, i + 50).map((m) => intake.intake(system, lead(m, { cityCode: 'dist' }))),
      );
    }
    const rows = await query<{ account_id: string; n: number }>(
      `SELECT account_id, count(*)::int AS n FROM case_assignments
       WHERE weight_version_id = $1 GROUP BY account_id`,
      [versionId],
    );
    const got = new Map(rows.map((r) => [r.account_id, r.n]));
    expect([...got.values()].reduce((s, n) => s + n, 0)).toBe(total);
    for (const [who, share] of [
      [x, 0.5],
      [y, 0.3],
      [z, 0.2],
    ] as const) {
      expect(Math.abs((got.get(who.id) ?? 0) / total - share)).toBeLessThan(0.02);
    }
    expect(got.get(zero.id) ?? 0).toBe(0);

    // 10,000 intakes outlast an access token: a new session, for this and later tests.
    manager = await relogin(h, manager);
    // The report reads the reporting database and says the same.
    const report = await api(
      manager,
      'GET',
      `/lead/assignment/distribution?queueCode=advisory&from=2020-01-01T00:00:00Z&to=2100-01-01T00:00:00Z`,
    );
    expect(report.status).toBe(200);
    const version = (report.body as unknown as { versionId: string; agents: Body[] }[]).find(
      (v) => v.versionId === versionId,
    );
    expect(version?.agents.find((a) => a['accountId'] === x.id)).toMatchObject({
      targetPercent: 50,
      received: got.get(x.id),
    });
  }, 900_000);

  it('someone away takes no share while away, and gets no catch-up after (decision 4)', async () => {
    const [p, q] = await Promise.all([advisor(), advisor()]);
    const versionId = await setShares(
      [
        { accountId: p.id, percent: 50 },
        { accountId: q.id, percent: 50 },
      ],
      { cityCode: 'away' },
    );
    const away = await api(manager, 'PUT', `/lead/agents/${q.id}/presence`, {
      status: 'on_leave',
      ...reason,
    });
    expect(away.status).toBe(200);
    for (let i = 0; i < 10; i++)
      await intake.intake(system, lead(newMobile(), { cityCode: 'away' }));
    await api(manager, 'PUT', `/lead/agents/${q.id}/presence`, { status: 'present', ...reason });
    for (let i = 0; i < 10; i++)
      await intake.intake(system, lead(newMobile(), { cityCode: 'away' }));
    const rows = await query<{ account_id: string; n: number }>(
      `SELECT account_id, count(*)::int AS n FROM case_assignments
       WHERE weight_version_id = $1 GROUP BY account_id`,
      [versionId],
    );
    const got = new Map(rows.map((r) => [r.account_id, r.n]));
    // 10 to p while q was away, then 5 each: q never gets the 10 back.
    expect(got.get(p.id)).toBe(15);
    expect(got.get(q.id)).toBe(5);
  });

  it('a cap stops an agent; when nobody can take a case it waits unassigned', async () => {
    const solo = await advisor();
    await setShares([{ accountId: solo.id, percent: 100 }], { cityCode: 'capped' });
    await api(manager, 'PUT', `/lead/agents/${solo.id}/cap`, { maxOpenCases: 1, ...reason });
    const first = await intake.intake(system, lead(newMobile(), { cityCode: 'capped' }));
    const second = await intake.intake(system, lead(newMobile(), { cityCode: 'capped' }));
    expect(first.assigneeAccountId).toBe(solo.id);
    expect(second.assigneeAccountId).toBeNull();
    const [row] = await query('SELECT kind FROM case_assignments WHERE case_id = $1', [
      second.caseId,
    ]);
    expect(row?.['kind']).toBe('unassigned');
    const events = await query(
      `SELECT count(*)::int AS n FROM outbox_events WHERE event_type = 'lead.case_unassigned' AND aggregate_id = $1`,
      [second.caseId],
    );
    expect(events[0]?.['n']).toBe(1);
  });
});

describe('concurrency (doc 05 §10 test 4)', () => {
  it('100 simultaneous leads: no case goes to two agents; one mobile at once makes one person', async () => {
    const [a, b] = await Promise.all([advisor(), advisor()]);
    await setShares(
      [
        { accountId: a.id, percent: 60 },
        { accountId: b.id, percent: 40 },
      ],
      { cityCode: 'rush' },
    );
    const results = await Promise.all(
      Array.from({ length: 100 }, () =>
        intake.intake(system, lead(newMobile(), { cityCode: 'rush' })),
      ),
    );
    const ids = results.map((r) => r.caseId);
    const rows = await query<{ case_id: string; n: number }>(
      `SELECT case_id, count(*)::int AS n FROM case_assignments WHERE case_id = ANY($1::uuid[]) GROUP BY case_id`,
      [ids],
    );
    expect(rows).toHaveLength(100);
    expect(rows.every((r) => r.n === 1)).toBe(true);
    const counts = results.reduce(
      (m, r) => m.set(r.assigneeAccountId, (m.get(r.assigneeAccountId) ?? 0) + 1),
      new Map<string | null, number>(),
    );
    expect(counts.get(a.id)).toBe(60);
    expect(counts.get(b.id)).toBe(40);

    const mobile = newMobile();
    const same = await Promise.all(
      Array.from({ length: 20 }, () => intake.intake(system, lead(mobile, { cityCode: 'rush' }))),
    );
    expect(new Set(same.map((r) => r.personId)).size).toBe(1);
    expect(same.filter((r) => r.category === 'new')).toHaveLength(1);
    expect(same.filter((r) => r.category === 'duplicate_active')).toHaveLength(19);
  });
});

describe('returning (doc 05 §10 test 5)', () => {
  it('a new case marked returning, with the full history, back to the previous advisor', async () => {
    const [first, other] = await Promise.all([advisor(), advisor()]);
    await setShares([{ accountId: first.id, percent: 100 }], { cityCode: 'back' });
    const mobile = newMobile();
    const opened = await intake.intake(system, lead(mobile, { cityCode: 'back' }));
    expect(opened.assigneeAccountId).toBe(first.id);
    expect((await api(first, 'POST', `/lead/cases/${String(opened.caseId)}/advising`)).status).toBe(
      200,
    );
    const noReason = await api(first, 'POST', `/lead/cases/${String(opened.caseId)}/cancel`, {
      reasonCode: 'no_such_reason',
    });
    expect(noReason.status).toBe(400);
    const closed = await api(first, 'POST', `/lead/cases/${String(opened.caseId)}/cancel`, {
      reasonCode: 'price_too_high',
      note: 'گران بود',
    });
    expect(closed.status).toBe(200);

    // The shares change; the previous advisor still gets the returning person.
    await setShares(
      [
        { accountId: first.id, percent: 10 },
        { accountId: other.id, percent: 90 },
      ],
      { cityCode: 'back' },
    );
    const again = await intake.intake(system, lead(mobile, { cityCode: 'back' }));
    expect(again).toMatchObject({
      category: 'returning',
      caseCreated: true,
      assigneeAccountId: first.id,
    });
    const detail = await api(first, 'GET', `/lead/cases/${String(again.caseId)}`);
    expect(detail.status).toBe(200);
    expect(detail.body).toMatchObject({
      isReturning: true,
      previous: {
        caseId: opened.caseId,
        status: 'cancelled',
        abandonmentReasonCode: 'price_too_high',
        advisorAccountId: first.id,
      },
    });
    expect(detail.body['assignments']).toEqual([
      expect.objectContaining({ accountId: first.id, kind: 'returning' }),
    ]);
  });
});

describe('scopes and the status machine', () => {
  it('an advisor sees only their own cases; closing needs a listed reason', async () => {
    const [mine, theirs] = await Promise.all([advisor(), advisor()]);
    await setShares([{ accountId: theirs.id, percent: 100 }], { cityCode: 'scoped' });
    const other = await intake.intake(system, lead(newMobile(), { cityCode: 'scoped' }));
    expect((await api(mine, 'GET', `/lead/cases/${String(other.caseId)}`)).status).toBe(404);
    expect((await api(mine, 'POST', `/lead/cases/${String(other.caseId)}/advising`)).status).toBe(
      404,
    );
    expect((await api(theirs, 'GET', `/lead/cases/${String(other.caseId)}`)).status).toBe(200);
    const list = await api(mine, 'GET', '/lead/cases');
    expect((list.body as unknown as { id: string }[]).some((c) => c.id === other.caseId)).toBe(
      false,
    );
    // A status never skips a step, even for the schema owner.
    await expect(
      h.owner.query(`UPDATE cases SET status = 'funded' WHERE id = $1`, [other.caseId]),
    ).rejects.toThrow(/cannot move/);
  });

  it('manual assignment needs a reason and is audited; chose_cash is never retired', async () => {
    const [from, to] = await Promise.all([advisor(), advisor()]);
    await setShares([{ accountId: from.id, percent: 100 }], { cityCode: 'manual' });
    const opened = await intake.intake(system, lead(newMobile(), { cityCode: 'manual' }));
    const noReason = await api(
      manager,
      'POST',
      `/lead/cases/${String(opened.caseId)}/assignments`,
      {
        accountId: to.id,
      },
    );
    expect(noReason.status).toBe(400);
    const moved = await api(manager, 'POST', `/lead/cases/${String(opened.caseId)}/assignments`, {
      accountId: to.id,
      ...reason,
    });
    expect(moved.status).toBe(201);
    expect(moved.body['assigneeAccountId']).toBe(to.id);
    const audit = await query(
      `SELECT actor_account_id, reason FROM audit_events WHERE action = 'lead.case_assigned_manually' AND entity_id = $1`,
      [opened.caseId],
    );
    expect(audit).toEqual([{ actor_account_id: manager.id, reason: reason.reason }]);

    const retire = await api(
      manager,
      'POST',
      '/lead/abandonment-reasons/chose_cash/retire',
      reason,
    );
    expect(retire.status).toBe(409);
    await expect(
      h.owner.query(`UPDATE abandonment_reasons SET deleted_at = now() WHERE code = 'chose_cash'`),
    ).rejects.toThrow(/cannot be retired/);
    const added = await api(manager, 'POST', '/lead/abandonment-reasons', {
      code: 'moved_abroad',
      title: 'مهاجرت',
      ...reason,
    });
    expect(added.status).toBe(201);
    expect(
      (await api(manager, 'POST', '/lead/abandonment-reasons/moved_abroad/retire', reason)).status,
    ).toBe(201);
  });

  it('after a handoff the previous advisor (own scope) loses the case; the new one has it', async () => {
    const [from, to] = await Promise.all([advisor(), advisor()]);
    await setShares([{ accountId: from.id, percent: 100 }], { cityCode: 'handoff' });
    const opened = await intake.intake(system, lead(newMobile(), { cityCode: 'handoff' }));
    const path = `/lead/cases/${String(opened.caseId)}`;
    expect((await api(from, 'GET', path)).status).toBe(200);
    expect((await api(to, 'GET', path)).status).toBe(404);

    const moved = await api(manager, 'POST', `${path}/assignments`, {
      accountId: to.id,
      ...reason,
    });
    expect(moved.status).toBe(201);

    expect((await api(from, 'GET', path)).status).toBe(404);
    expect((await api(from, 'POST', `${path}/advising`)).status).toBe(404);
    expect((await api(from, 'POST', `${path}/cancel`, { reasonCode: 'other' })).status).toBe(404);
    const fromList = await api(from, 'GET', '/lead/cases');
    expect((fromList.body as unknown as { id: string }[]).some((c) => c.id === opened.caseId)).toBe(
      false,
    );

    expect((await api(to, 'GET', path)).status).toBe(200);
    expect((await api(to, 'POST', `${path}/advising`)).status).toBe(200);
    const toList = await api(to, 'GET', '/lead/cases');
    expect((toList.body as unknown as { id: string }[]).some((c) => c.id === opened.caseId)).toBe(
      true,
    );
  });
});

describe('blocked and existing customers (doc 05 §4)', () => {
  it('a blocked person is recorded, never assigned; a loan in progress goes to its own queue', async () => {
    const a = await advisor();
    await setShares([{ accountId: a.id, percent: 100 }], { cityCode: 'kinds' });
    const blockedMobile = newMobile();
    const first = await intake.intake(system, lead(blockedMobile, { cityCode: 'kinds' }));
    await api(a, 'POST', `/lead/cases/${String(first.caseId)}/cancel`, { reasonCode: 'other' });
    const blocked = await api(manager, 'POST', `/lead/persons/${first.personId}/block`, {
      kind: 'do_not_contact',
      ...reason,
    });
    expect(blocked.status).toBe(200);
    const again = await intake.intake(system, lead(blockedMobile, { cityCode: 'kinds' }));
    expect(again).toMatchObject({ category: 'blocked', caseId: null, assigneeAccountId: null });

    const customer = await intake.intake(system, lead(newMobile(), { cityCode: 'kinds' }));
    // Moved step by step to a loan, as the later modules will.
    for (const status of [
      'advising',
      'appointment_booked',
      'examined',
      'proforma_issued',
      'credit_requested',
      'credit_decided',
      'contracted',
    ]) {
      await h.owner.query('UPDATE cases SET status = $1 WHERE id = $2', [status, customer.caseId]);
    }
    const next = await intake.intake(
      system,
      lead(
        (
          await query('SELECT mobile FROM person_mobiles WHERE person_id = $1', [customer.personId])
        )[0]?.['mobile'] as string,
        {
          cityCode: 'kinds',
        },
      ),
    );
    expect(next).toMatchObject({ category: 'existing_customer', caseCreated: true });
    const [row] = await query('SELECT queue_code FROM cases WHERE id = $1', [next.caseId]);
    expect(row?.['queue_code']).toBe('existing_customers');
  });
});

describe('merging persons (doc 05 §9)', () => {
  it('moves the cases, follows the merge, and is reverted exactly; audited', async () => {
    const a = await advisor();
    await setShares([{ accountId: a.id, percent: 100 }], { cityCode: 'merge' });
    const [m1, m2] = [newMobile(), newMobile()];
    const one = await intake.intake(system, lead(m1, { cityCode: 'merge' }));
    await api(a, 'POST', `/lead/cases/${String(one.caseId)}/cancel`, { reasonCode: 'other' });
    const two = await intake.intake(system, lead(m2, { cityCode: 'merge' }));

    const merged = await api(manager, 'POST', '/lead/person-merges', {
      survivorId: one.personId,
      mergedId: two.personId,
      ...reason,
    });
    expect(merged.status).toBe(201);
    expect(merged.body['movedCaseIds']).toEqual([two.caseId]);
    // The second mobile now leads to the survivor, and its open case is found.
    const via = await intake.intake(system, lead(m2, { cityCode: 'merge' }));
    expect(via).toMatchObject({
      personId: one.personId,
      category: 'duplicate_active',
      caseId: two.caseId,
    });
    // Task 9-3 (owner, 0081 second approval): the merged Person's mobile is re-issued pending,
    // so it stands for nobody until the survivor's side approves it (person-mobile-approval).
    const directory = h.app.get<PersonDirectory>(PERSON_DIRECTORY);
    expect((await directory.findOrCreateByMobile(m2)).personId).toBeNull();

    const reverted = await api(
      manager,
      'POST',
      `/lead/person-merges/${merged.body['mergeId'] as string}/revert`,
      reason,
    );
    expect(reverted.status).toBe(200);
    expect(reverted.body['restoredCaseIds']).toEqual([two.caseId]);
    // The revert follows the same rule: the mobile waits again (it was never approved here).
    expect((await directory.findOrCreateByMobile(m2)).personId).toBeNull();
    const again = await api(
      manager,
      'POST',
      `/lead/person-merges/${merged.body['mergeId'] as string}/revert`,
      reason,
    );
    expect(again.status).toBe(409);
    const audit = await query<{ action: string }>(
      `SELECT action FROM audit_events WHERE entity_id = $1 ORDER BY seq`,
      [merged.body['mergeId']],
    );
    expect(audit.map((r) => r.action)).toEqual(['lead.persons_merged', 'lead.merge_reverted']);

    // Two humans (different national IDs) are never merged.
    const x = await intake.intake(
      system,
      lead(newMobile(), { nationalId: nationalId(), cityCode: 'merge' }),
    );
    await api(a, 'POST', `/lead/cases/${String(x.caseId)}/cancel`, { reasonCode: 'other' });
    const y = await intake.intake(
      system,
      lead(newMobile(), { nationalId: nationalId(), cityCode: 'merge' }),
    );
    const refused = await api(manager, 'POST', '/lead/person-merges', {
      survivorId: x.personId,
      mergedId: y.personId,
      ...reason,
    });
    expect(refused.status).toBe(409);
    expect(refused.body['error']).toBe('national_id_conflict');
    // Only the merge permission merges.
    expect(
      (
        await api(a, 'POST', '/lead/person-merges', {
          survivorId: x.personId,
          mergedId: y.personId,
          ...reason,
        })
      ).status,
    ).toBe(403);
  });

  it('lists the merges a person survived, newest first, before and after a revert', async () => {
    const a = await advisor();
    await setShares([{ accountId: a.id, percent: 100 }], { cityCode: 'merge' });
    const one = await intake.intake(system, lead(newMobile(), { cityCode: 'merge' }));
    await api(a, 'POST', `/lead/cases/${String(one.caseId)}/cancel`, { reasonCode: 'other' });
    const two = await intake.intake(system, lead(newMobile(), { cityCode: 'merge' }));
    const path = `/lead/persons/${one.personId}/merges`;
    expect((await api(manager, 'GET', path)).body).toEqual([]);

    const merged = await api(manager, 'POST', '/lead/person-merges', {
      survivorId: one.personId,
      mergedId: two.personId,
      ...reason,
    });
    const mergeId = merged.body['mergeId'] as string;
    const listed = await api(manager, 'GET', path);
    expect(listed.status).toBe(200);
    expect(listed.body).toEqual([
      {
        id: mergeId,
        mergedId: two.personId,
        movedCaseIds: [two.caseId],
        reason: reason.reason,
        at: expect.any(String) as unknown,
        revertedAt: null,
      },
    ]);
    // The merged person survived nothing.
    expect((await api(manager, 'GET', `/lead/persons/${two.personId}/merges`)).body).toEqual([]);
    await api(manager, 'POST', `/lead/person-merges/${mergeId}/revert`, reason);
    const after = (await api(manager, 'GET', path)).body as unknown as Record<string, unknown>[];
    expect(after[0]?.['revertedAt']).toEqual(expect.any(String));
    // Only the merge permission reads them.
    expect((await api(a, 'GET', path)).status).toBe(403);
  });
});

describe('PERSON_DIRECTORY and the backfill (task 2-5b decision 1)', () => {
  it('a patient login links the account to the real Person of that mobile', async () => {
    const mobile = newMobile();
    const opened = await intake.intake(system, lead(mobile));
    const login = await otpLogin(h, mobile, 'mobile', { ip: newIp() });
    expect(login.status).toBe(200);
    const [account] = await query('SELECT person_id FROM user_accounts WHERE mobile = $1', [
      mobile,
    ]);
    expect(account?.['person_id']).toBe(opened.personId);
    const [person] = await query('SELECT account_linked_at FROM persons WHERE id = $1', [
      opened.personId,
    ]);
    expect(person?.['account_linked_at']).not.toBeNull();
  });

  it('dry run first, then apply; idempotent; audited per link', async () => {
    // Accounts made before the lead module: patients without a person (the database keeps
    // their mobiles normalized and unique, so none needs manual review; planBackfill's unit
    // test covers the shared and invalid cases).
    const insert = (mobile: string) =>
      query<{ id: string }>(
        `INSERT INTO user_accounts (kind, mobile) VALUES ('patient', $1) RETURNING id`,
        [mobile],
      );
    const clean = newMobile();
    const [plain] = await insert(clean);
    const known = newMobile();
    const existing = await intake.intake(system, lead(known));
    const [withPerson] = await insert(known);
    const backfill = h.app.get(PersonBackfill);

    const dry = await backfill.run('dry_run');
    expect(dry.manualReview).toEqual([]);
    expect(dry.filled).toBe(dry.candidates);
    const [untouched] = await query('SELECT person_id FROM user_accounts WHERE id = $1', [
      plain?.id,
    ]);
    expect(untouched?.['person_id']).toBeNull();

    const applied = await backfill.run('apply');
    expect(applied.filled).toBe(dry.filled);
    const [linked] = await query('SELECT person_id FROM user_accounts WHERE id = $1', [plain?.id]);
    const [byMobile] = await query('SELECT person_id FROM person_mobiles WHERE mobile = $1', [
      clean,
    ]);
    expect(linked?.['person_id']).toBe(byMobile?.['person_id']);
    // An account whose mobile already had a person gets that same person.
    const [joined] = await query('SELECT person_id FROM user_accounts WHERE id = $1', [
      withPerson?.id,
    ]);
    expect(joined?.['person_id']).toBe(existing.personId);

    const again = await backfill.run('apply');
    expect(again.filled).toBe(0);
    const runs = await query<{ mode: string }>(
      'SELECT mode FROM person_backfill_runs ORDER BY created_at',
    );
    expect(runs.map((r) => r.mode)).toEqual(['dry_run', 'apply', 'apply']);
    const audit = await query(
      `SELECT count(*)::int AS n FROM audit_events WHERE action = 'identity.person_linked' AND entity_id = $1`,
      [plain?.id],
    );
    expect(audit[0]?.['n']).toBe(1);
  });
});

describe('the WordPress webhook (doc 05 §7; decision 5)', () => {
  const send = async (
    body: Body,
    options: { secret?: string; timestamp?: number; key?: string; signature?: string } = {},
  ) => {
    const raw = JSON.stringify(body);
    const timestamp = String(options.timestamp ?? Math.floor(Date.now() / 1000));
    const res = await fetch(`${h.baseUrl}/leads/intake`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-forwarded-for': newIp(),
        'x-sepehr-source': 'wordpress',
        'x-sepehr-timestamp': timestamp,
        'x-sepehr-signature':
          options.signature ?? `v1=${webhookSignature(options.secret ?? SECRET, timestamp, raw)}`,
        'idempotency-key': options.key ?? `wp-${randomBytes(8).toString('hex')}`,
      },
      body: raw,
    });
    const text = await res.text();
    return { status: res.status, body: (text ? JSON.parse(text) : {}) as Body };
  };
  const intakesOf = async (mobile: string) =>
    (await query('SELECT count(*)::int AS n FROM case_intakes WHERE mobile = $1', [mobile]))[0]?.[
      'n'
    ];

  it('accepts a signed delivery once, whichever of the two secrets signed it', async () => {
    const mobile = newMobile();
    const body = {
      mobile,
      treatmentFieldCode: 'dental',
      smsConsent: true,
      utm: { source: 'google' },
    };
    const key = `wp-${randomBytes(8).toString('hex')}`;
    const first = await send(body, { key });
    expect(first).toEqual({ status: 202, body: { received: true, replayed: false } });
    const retry = await send(body, { key });
    expect(retry).toEqual({ status: 202, body: { received: true, replayed: true } });
    expect(await intakesOf(mobile)).toBe(1);
    expect((await send({ ...body, mobile: newMobile() }, { secret: OLD_SECRET })).status).toBe(202);
    const [row] = await query(`SELECT channel, utm FROM case_intakes WHERE mobile = $1`, [mobile]);
    expect(row).toEqual({ channel: 'wordpress', utm: { source: 'google' } });
  });

  it('refuses a bad signature, an old request and an unknown source', async () => {
    const body = { mobile: newMobile(), treatmentFieldCode: 'dental' };
    expect((await send(body, { secret: randomBytes(32).toString('hex') })).body['error']).toBe(
      'bad_signature',
    );
    expect((await send(body, { signature: 'v1=' + '0'.repeat(64) })).status).toBe(401);
    const old = await send(body, { timestamp: Math.floor(Date.now() / 1000) - 3600 });
    expect(old).toMatchObject({ status: 401, body: { error: 'stale_request' } });
    expect(await intakesOf(body.mobile)).toBe(0);
  });

  it('drops a bot that filled the honeypot, quietly; limits one mobile', async () => {
    const mobile = newMobile();
    const bot = await send({ mobile, treatmentFieldCode: 'dental', website: 'http://spam' });
    expect(bot).toEqual({ status: 202, body: { received: true, replayed: false } });
    expect(await intakesOf(mobile)).toBe(0);
    const busy = newMobile();
    const statuses: number[] = [];
    for (let i = 0; i < 6; i++) {
      statuses.push((await send({ mobile: busy, treatmentFieldCode: 'dental' })).status);
    }
    expect(statuses).toEqual([202, 202, 202, 202, 202, 429]);
  });
  it('task 8-2: keeps the referrer; the consent in 6-4’s ledger, once and only when given', async () => {
    const consents = async (m: string) =>
      await query(`SELECT action, source FROM sms_consents WHERE mobile = $1 ORDER BY created_at`, [
        m.replace(/^0/, ''),
      ]);
    const mobile = newMobile();
    const key = `wp-${randomBytes(8).toString('hex')}`;
    const body = {
      mobile,
      treatmentFieldCode: 'dental',
      smsConsent: true,
      pageUrl: 'https://sepehr.example/dental',
      referrer: 'https://www.google.com/',
    };
    expect((await send(body, { key })).status).toBe(202);
    // The same delivery again: replayed, no second consent.
    expect((await send(body, { key })).body).toMatchObject({ replayed: true });
    const [row] = await query(`SELECT referrer, page_url FROM case_intakes WHERE mobile = $1`, [
      mobile,
    ]);
    expect(row).toEqual({
      referrer: 'https://www.google.com/',
      page_url: 'https://sepehr.example/dental',
    });
    expect(await consents(mobile)).toEqual([{ action: 'consent', source: 'wordpress' }]);

    // Without consent: nothing in the ledger (so an earlier withdrawal would stand).
    const other = newMobile();
    expect((await send({ mobile: other, treatmentFieldCode: 'dental' })).status).toBe(202);
    expect(await consents(other)).toEqual([]);
    // A referrer longer than the column allows is refused whole.
    const long = await send({ ...body, mobile: newMobile(), referrer: 'x'.repeat(2001) });
    expect(long).toMatchObject({ status: 400, body: { error: 'invalid_body' } });
  });
});

describe('the Excel import (doc 05 §8, §10 test 6; decision 2)', () => {
  const upload = async (file: Uint8Array, name = 'leads.xlsx') => {
    const form = new FormData();
    form.append('file', new Blob([file]), name);
    const res = await fetch(`${h.baseUrl}/lead/imports`, {
      method: 'POST',
      headers: { authorization: `Bearer ${manager.access}`, 'x-forwarded-for': newIp() },
      body: form,
    });
    return { status: res.status, body: (await res.json()) as Body };
  };

  it('is off until the owner turns it on', async () => {
    const res = await upload(writeSheet([['موبایل', 'کد فیلد درمان']]));
    expect(res).toMatchObject({ status: 403, body: { error: 'feature_disabled' } });
  });

  it('previews, processes, and a cancel undoes only what nobody touched', async () => {
    await h.owner.query(
      `INSERT INTO config_values (key, scope_level, value, effective_at, status, reason, decided_at)
       VALUES ('lead.excel_import_enabled', 'global', 'true', now(), 'approved', 'آزمون', now())`,
    );
    const a = await advisor();
    await setShares([{ accountId: a.id, percent: 100 }], { cityCode: 'excel' });
    const known = newMobile();
    await intake.intake(system, lead(known, { cityCode: 'excel' }));
    const [m1, m2] = [newMobile(), newMobile()];
    const sheet = writeSheet([
      ['موبایل', 'نام', 'کد ملی', 'کد فیلد درمان', 'کد شهر', 'رضایت پیامک'],
      [`0${m1}`, 'بیمار یک', nationalId(), 'dental', 'excel', 'بله'],
      [m2, '=HYPERLINK("x")', '', 'dental', 'excel', ''],
      [known, 'قبلی', '', 'dental', 'excel', 'خیر'],
      ['12', 'خطا', '', 'dental', 'excel', ''],
      [m1, 'تکرار', '', 'dental', 'excel', ''],
      [newMobile(), 'بدون فیلد', '', '', 'excel', 'شاید'],
    ]);
    expect((await upload(sheet, 'leads.xls')).body['error']).toBe('xlsx_only');
    const preview = await upload(sheet);
    expect(preview.status).toBe(201);
    expect(preview.body).toMatchObject({
      status: 'previewed',
      rowCount: 6,
      newCount: 2,
      existingCount: 1,
      errorCount: 3,
      errors: [
        { row: 5, codes: ['invalid_mobile'] },
        { row: 6, codes: ['duplicate_in_file'] },
        { row: 7, codes: ['missing_treatment_field', 'invalid_sms_consent'] },
      ],
    });
    const batchId = preview.body['batchId'] as string;
    // The national ID is kept only encrypted.
    const [stored] = await query(
      `SELECT national_id_enc FROM lead_import_rows WHERE batch_id = $1 AND row_number = 2`,
      [batchId],
    );
    expect(String(stored?.['national_id_enc'])).toMatch(/^v1\./);

    expect((await api(manager, 'POST', `/lead/imports/${batchId}/commit`, reason)).status).toBe(
      200,
    );
    const event = await query(
      `SELECT count(*)::int AS n FROM outbox_events WHERE event_type = 'lead.import_committed' AND aggregate_id = $1`,
      [batchId],
    );
    expect(event[0]?.['n']).toBe(1);
    // What the worker does on that event.
    const processed = await h.app.get(LeadImportProcessor).process(batchId);
    expect(processed).toEqual({ processed: 3, failed: 0 });
    expect(await h.app.get(LeadImportProcessor).process(batchId)).toEqual({
      processed: 0,
      failed: 0,
    });

    const rows = await query<{ row_number: number; case_id: string; person_id: string }>(
      `SELECT row_number, case_id, person_id FROM lead_import_rows WHERE batch_id = $1 AND status = 'processed' ORDER BY row_number`,
      [batchId],
    );
    const [row2, row3] = rows;
    // Someone acts on row 3's case: it is no longer the batch's to undo.
    expect((await api(a, 'POST', `/lead/cases/${String(row3?.case_id)}/advising`)).status).toBe(
      200,
    );

    const report = await fetch(`${h.baseUrl}/lead/imports/${batchId}/report.csv`, {
      headers: { authorization: `Bearer ${manager.access}`, 'x-forwarded-for': newIp() },
    });
    const csv = await report.text();
    expect(csv).toContain(`"'=HYPERLINK(""x"")"`);
    expect(csv).not.toMatch(/(^|,)"=/m);

    const cancelled = await api(manager, 'POST', `/lead/imports/${batchId}/cancel`, reason);
    expect(cancelled.status).toBe(200);
    expect(cancelled.body).toMatchObject({ undone: 2, keptRows: [3] });
    const [gone] = await query('SELECT deleted_at FROM cases WHERE id = $1', [row2?.case_id]);
    expect(gone?.['deleted_at']).not.toBeNull();
    const [goneP] = await query('SELECT deleted_at FROM persons WHERE id = $1', [row2?.person_id]);
    expect(goneP?.['deleted_at']).not.toBeNull();
    const [kept] = await query('SELECT deleted_at, status FROM cases WHERE id = $1', [
      row3?.case_id,
    ]);
    expect(kept).toEqual({ deleted_at: null, status: 'advising' });
    // The known person's intake stays in the history; their case is untouched.
    expect(
      (
        await query('SELECT count(*)::int AS n FROM case_intakes WHERE import_batch_id = $1', [
          batchId,
        ])
      )[0]?.['n'],
    ).toBe(3);
    await expect(
      h.owner.query('DELETE FROM cases WHERE id = $1', [row2?.case_id]),
    ).rejects.toThrow();
  });

  it('scans every upload with ClamAV before reading it; an infected file is refused (2-8)', async () => {
    const batches = async () =>
      (await query('SELECT count(*)::int AS n FROM lead_import_batches'))[0]?.['n'];
    const before = await batches();
    const infected = await upload(new Uint8Array(eicar()), 'leads.xlsx');
    expect(infected).toMatchObject({ status: 400, body: { error: 'file_infected' } });
    expect(await batches()).toBe(before);
    // A clean sheet still goes through the same scan.
    const clean = await upload(writeSheet([['موبایل', 'کد فیلد درمان']]));
    expect(clean.status).toBe(201);
    expect(await batches()).toBe(Number(before) + 1);
  });
});

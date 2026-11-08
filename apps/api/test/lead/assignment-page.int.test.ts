import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  call,
  grantRole,
  loggedInAccount,
  newAccount,
  newMobile,
  otpLogin,
  startHarness,
  type Harness,
  type LoggedInAccount,
} from '../identity/harness';

/**
 * The strategy manager's assignment page (owner 1405/07/24): an agent found by username, the
 * shares in force with each agent's name, a new version audited, presence and cap. The
 * harness checks every answer against its @ZodResponse.
 */

type Row = Record<string, unknown>;

let h: Harness;
let strategy: LoggedInAccount;
let advisor: LoggedInAccount;

const as = (who: LoggedInAccount, method: string, path: string, body?: unknown) =>
  call(h, method, path, { bearer: who.access, ...(body === undefined ? {} : { body }) });

beforeAll(async () => {
  h = await startHarness();
  [strategy, advisor] = await Promise.all([
    loggedInAccount(h, 'staff'),
    loggedInAccount(h, 'staff'),
  ]);
  await grantRole(h, strategy.id, 'strategy_manager');
  await grantRole(h, advisor.id, 'advisor');
}, 240_000);

afterAll(async () => {
  await h.close();
});

describe('the assignment page (owner 1405/07/24)', () => {
  it('finds an active staff agent by username; never a center, a patient or a disabled one', async () => {
    const agent = await newAccount(h, 'staff');
    const found = await as(
      strategy,
      'GET',
      `/lead/agents/by-username/${agent.username.toUpperCase()}`,
    );
    expect(found.status, JSON.stringify(found.body)).toBe(200);
    expect(found.body).toEqual({ id: agent.id, username: agent.username, displayName: null });

    const center = await newAccount(h, 'center');
    expect((await as(strategy, 'GET', `/lead/agents/by-username/${center.username}`)).status).toBe(
      404,
    );
    const mobile = newMobile();
    expect((await otpLogin(h, mobile, 'mobile')).status).toBe(200);
    await h.owner.query('UPDATE user_accounts SET username = $1 WHERE mobile = $2', [
      `p_${mobile}`,
      mobile,
    ]);
    expect((await as(strategy, 'GET', `/lead/agents/by-username/p_${mobile}`)).status).toBe(404);
    const gone = await newAccount(h, 'staff');
    await h.owner.query(`UPDATE user_accounts SET status = 'disabled' WHERE id = $1`, [gone.id]);
    expect((await as(strategy, 'GET', `/lead/agents/by-username/${gone.username}`)).status).toBe(
      404,
    );

    // Without lead.manage_assignment: refused.
    expect((await as(advisor, 'GET', `/lead/agents/by-username/${agent.username}`)).status).toBe(
      403,
    );
  });

  it('the shares in force name each agent; a new version is audited; presence and cap set', async () => {
    const a = await newAccount(h, 'staff');
    const b = await newAccount(h, 'staff');
    await h.owner.query('UPDATE user_accounts SET display_name = $1 WHERE id = $2', [
      'کارشناس الف',
      a.id,
    ]);
    const queueCode = `page_${String(Date.now()).slice(-6)}`;
    // No shares yet: an empty answer (null), nothing of another queue.
    const none = await as(strategy, 'GET', `/lead/assignment/shares?queueCode=${queueCode}`);
    expect(none.status).toBe(200);
    expect(none.body['shares']).toBeUndefined();

    const set = await as(strategy, 'PUT', '/lead/assignment/shares', {
      queueCode,
      shares: [
        { accountId: a.id, percent: 70 },
        { accountId: b.id, percent: 30 },
      ],
      reason: 'تقسیم صف آزمون',
    });
    expect(set.status, JSON.stringify(set.body)).toBe(200);
    const read = await as(strategy, 'GET', `/lead/assignment/shares?queueCode=${queueCode}`);
    expect(read.status).toBe(200);
    const shares = read.body['shares'] as Row[];
    expect(shares).toEqual(
      expect.arrayContaining([
        // Never set: present and no cap, as the engine reads them.
        {
          accountId: a.id,
          percent: 70,
          name: 'کارشناس الف',
          presence: 'present',
          maxOpenCases: null,
        },
        { accountId: b.id, percent: 30, name: b.username, presence: 'present', maxOpenCases: null },
      ]),
    );
    // The audit keeps the ids alone, not the names.
    const { rows } = await h.owner.query<Row>(
      `SELECT after FROM audit_events WHERE action = 'lead.assignment_shares_set' AND entity_id = $1
          AND actor_account_id = $2`,
      [set.body['versionId'], strategy.id],
    );
    expect(rows).toHaveLength(1);
    expect(JSON.stringify(rows[0]?.['after'])).not.toContain('کارشناس الف');

    // Never a center account in the shares.
    const center = await newAccount(h, 'center');
    expect(
      (
        await as(strategy, 'PUT', '/lead/assignment/shares', {
          queueCode,
          shares: [{ accountId: center.id, percent: 100 }],
          reason: 'مرکز در صف',
        })
      ).status,
    ).toBe(400);

    const away = await as(strategy, 'PUT', `/lead/agents/${a.id}/presence`, {
      status: 'on_leave',
      reason: 'مرخصی آزمون',
    });
    expect(away.body).toEqual({ accountId: a.id, status: 'on_leave' });
    const cap = await as(strategy, 'PUT', `/lead/agents/${b.id}/cap`, {
      maxOpenCases: 12,
      reason: 'سقف آزمون',
    });
    expect(cap.body).toEqual({ accountId: b.id, maxOpenCases: 12 });
    // The page reads the values in force (the latest of each), shown beside each share.
    await as(strategy, 'PUT', `/lead/agents/${a.id}/presence`, {
      status: 'absent',
      reason: 'غیبت آزمون',
    });
    const inForce = await as(strategy, 'GET', `/lead/assignment/shares?queueCode=${queueCode}`);
    expect(inForce.body['shares']).toEqual(
      expect.arrayContaining([
        {
          accountId: a.id,
          percent: 70,
          name: 'کارشناس الف',
          presence: 'absent',
          maxOpenCases: null,
        },
        { accountId: b.id, percent: 30, name: b.username, presence: 'present', maxOpenCases: 12 },
      ]),
    );

    // Without the permission: refused.
    expect(
      (await as(advisor, 'GET', `/lead/assignment/shares?queueCode=${queueCode}`)).status,
    ).toBe(403);
    expect(
      (await as(advisor, 'PUT', `/lead/agents/${b.id}/cap`, { maxOpenCases: 1, reason: 'سقف' }))
        .status,
    ).toBe(403);
  });
});

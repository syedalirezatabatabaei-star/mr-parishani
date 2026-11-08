import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { ACCESS_PORT, type AccessPort } from '../../src/common/auth/access.port';
import { FirstApproverMobile } from '../../src/modules/identity/first-approver-mobile';
import { StaffMobileChangeService } from '../../src/modules/identity/staff-mobile-change.service';
import { StaffMobileChanges } from '../../src/modules/identity/staff-mobile-changes';
import {
  call,
  grantRole,
  loggedInAccount,
  newMobile,
  startHarness,
  type Harness,
  type LoggedInAccount,
} from './harness';

/**
 * ADR-052 (owner 1405/08/02): a financial signer's mobile is where their SMS codes go. It is
 * changed only by two holders of `identity.approve_financial_mobile_change` (the CEO and the
 * system administrator), never by its owner, not even through the self-service mobile page;
 * the new number takes effect 24 hours after the second approval, and the old one is told at
 * once. Two staff members never share a verified mobile.
 */

type Row = Record<string, unknown>;

let h: Harness;
let ceo: LoggedInAccount;
let admin: LoggedInAccount;
let ceo2: LoggedInAccount;
/** Owner 1405/08/03: the third approver (mobile_change_approver), approve only. */
let third: LoggedInAccount;
let ceoUsername: string;

const as = (who: LoggedInAccount, method: string, path: string, body?: unknown) =>
  call(h, method, path, { bearer: who.access, ...(body === undefined ? {} : { body }) });
const ask = (who: LoggedInAccount, accountId: string, mobile: string) =>
  as(who, 'POST', '/identity/staff-mobile-changes', {
    accountId,
    mobile: `0${mobile}`,
    reason: 'گم شدن سیم‌کارت',
  });
const decide = (who: LoggedInAccount, id: string, outcome: 'approved' | 'refused') =>
  as(who, 'POST', `/identity/staff-mobile-changes/${id}/decisions`, {
    outcome,
    ...(outcome === 'refused' ? { reason: 'تأیید نشد' } : {}),
  });

/** A staff signer with their own verified mobile. */
async function signer(): Promise<LoggedInAccount & { mobile: string }> {
  const who = await loggedInAccount(h, 'staff');
  const mobile = newMobile();
  await h.owner.query(
    'UPDATE user_accounts SET mobile = $2, mobile_verified_at = now() WHERE id = $1',
    [who.id, mobile],
  );
  return { ...who, mobile };
}

const mobileOf = async (id: string) =>
  (await h.owner.query<Row>('SELECT mobile FROM user_accounts WHERE id = $1', [id])).rows[0]?.[
    'mobile'
  ];

const notices = async (id: string) =>
  (
    await h.owner.query<Row>(
      `SELECT event, mobile FROM factor_change_notices WHERE account_id = $1 ORDER BY created_at`,
      [id],
    )
  ).rows;

const at = (iso: string, plusMs: number) => new Date(new Date(iso).getTime() + plusMs);

beforeAll(async () => {
  h = await startHarness();
  ceo = await signer();
  admin = await signer();
  ceo2 = await signer();
  await grantRole(h, ceo.id, 'ceo');
  await grantRole(h, admin.id, 'system_admin');
  await grantRole(h, ceo2.id, 'ceo');
  third = await signer();
  await grantRole(h, third.id, 'mobile_change_approver');
  ceoUsername = (
    await h.owner.query<Row>('SELECT username FROM user_accounts WHERE id = $1', [ceo.id])
  ).rows[0]?.['username'] as string;
}, 180_000);

afterAll(async () => {
  await h.close();
});

describe('ADR-052: a signer’s mobile change', () => {
  it('two others approve; the old number is told at once; the new one counts 24 hours later', async () => {
    const target = await signer();
    const next = newMobile();
    const asked = await ask(ceo, target.id, next);
    expect(asked.status, JSON.stringify(asked.body)).toBe(201);
    expect(asked.body).toMatchObject({ status: 'open', mobileLastFour: next.slice(-4) });
    const id = asked.body['id'] as string;

    const one = await decide(ceo, id, 'approved');
    expect(one.status, JSON.stringify(one.body)).toBe(201);
    expect(one.body).toMatchObject({ status: 'open', approvedBy: [ceo.id] });
    expect(await notices(target.id)).toEqual([]);
    // The same person twice is still one approval.
    expect((await decide(ceo, id, 'approved')).body['error']).toBe('already_approved');

    const two = await decide(admin, id, 'approved');
    expect(two.status, JSON.stringify(two.body)).toBe(201);
    expect(two.body).toMatchObject({ status: 'approved' });
    const effectiveAt = two.body['effectiveAt'] as string;
    expect(await notices(target.id)).toEqual([{ event: 'mobile_changed', mobile: target.mobile }]);

    // Until then the old number is the one the codes go to.
    const changes = h.app.get(StaffMobileChanges);
    await changes.applyDue(target.id, at(effectiveAt, -1000));
    expect(await mobileOf(target.id)).toBe(target.mobile);
    await changes.applyDue(target.id, at(effectiveAt, 1000));
    expect(await mobileOf(target.id)).toBe(next);
    const applied = await as(ceo, 'GET', '/identity/staff-mobile-changes');
    expect(applied.body).toEqual(
      expect.arrayContaining([expect.objectContaining({ id, status: 'applied' })]),
    );
    // And the next code goes to it.
    const sent = await call(h, 'POST', '/identity/step-up/challenges', {
      bearer: target.access,
      body: { type: 'funding', id: target.id, amountRial: '1000', step: 'approve' },
    });
    expect(sent.status, JSON.stringify(sent.body)).toBe(201);
    expect(h.stepUps.sent.at(-1)?.mobile).toBe(next);
  });

  it('never by its owner: not asked, not approved, not through the self-service page', async () => {
    // The CEO's own number: asked by someone else, approved by two others.
    const own = await ask(ceo, ceo.id, newMobile());
    expect(own.status).toBe(403);
    expect(own.body['error']).toBe('cannot_change_own_mobile');
    const asked = await ask(admin, ceo.id, newMobile());
    expect(asked.status, JSON.stringify(asked.body)).toBe(201);
    const id = asked.body['id'] as string;
    const self = await decide(ceo, id, 'approved');
    expect(self.status).toBe(403);
    expect(self.body['error']).toBe('cannot_decide_own_mobile');
    // The database refuses it too.
    await expect(
      h.owner.query(
        `INSERT INTO staff_mobile_change_events (change_id, kind, by_account_id)
         VALUES ($1, 'approved', $2)`,
        [id, ceo.id],
      ),
    ).rejects.toMatchObject({ code: '23514' });
    expect((await decide(admin, id, 'approved')).status).toBe(201);
    expect((await decide(ceo2, id, 'approved')).body).toMatchObject({ status: 'approved' });

    // The self-service page proves a first mobile; it never replaces a verified one: no code
    // is even sent to the new number.
    const target = await signer();
    const other = newMobile();
    const replaced = await as(target, 'POST', '/auth/mobile/request', { mobile: other });
    expect(replaced.status).toBe(409);
    expect(replaced.body['error']).toBe('mobile_change_needs_approval');
    const sameAgain = await as(target, 'POST', '/auth/mobile/request', { mobile: target.mobile });
    expect(sameAgain.status).toBe(202);
    expect(await mobileOf(target.id)).toBe(target.mobile);
  });

  it('without the permission, without the code, or with one approval: nothing changes', async () => {
    const target = await signer();
    const plain = await signer();
    expect((await ask(plain, target.id, newMobile())).status).toBe(403);
    const noCode = await call(h, 'POST', '/identity/staff-mobile-changes', {
      bearer: ceo.access,
      body: { accountId: target.id, mobile: `0${newMobile()}`, reason: 'بی کد' },
      stepUp: false,
    });
    expect(noCode.status).toBe(403);
    expect(noCode.body['error']).toBe('step_up_required');
    const asked = await ask(ceo, target.id, newMobile());
    const id = asked.body['id'] as string;
    expect((await decide(ceo, id, 'approved')).status).toBe(201);
    await h.app.get(StaffMobileChanges).applyDue(target.id, new Date(Date.now() + 30 * 86_400_000));
    expect(await mobileOf(target.id)).toBe(target.mobile);
    // Refused ends it; a new request may follow.
    expect((await decide(admin, id, 'refused')).body).toMatchObject({ status: 'refused' });
    expect((await decide(ceo2, id, 'approved')).body['error']).toBe('mobile_change_closed');
    expect((await ask(ceo, target.id, newMobile())).status).toBe(201);
    expect((await ask(ceo, target.id, newMobile())).body['error']).toBe('mobile_change_open');
  });

  it('a mobile is never shared by two signers: refused when asked, and by the database', async () => {
    const one = await signer();
    const two = await signer();
    const taken = await ask(ceo, two.id, one.mobile);
    expect(taken.status).toBe(409);
    expect(taken.body['error']).toBe('mobile_taken');
    await expect(
      h.owner.query(
        'UPDATE user_accounts SET mobile = $2, mobile_verified_at = now() WHERE id = $1',
        [two.id, one.mobile],
      ),
    ).rejects.toMatchObject({ code: '23505' });
  });

  it('owner 1405/08/03: the third approver only approves; its role holds that one permission', async () => {
    const { rows } = await h.owner.query<Row>(
      `SELECT rp.permission_code FROM role_permissions rp JOIN roles r ON r.id = rp.role_id
        WHERE r.code = 'mobile_change_approver' AND rp.deleted_at IS NULL`,
    );
    expect(rows.map((r) => r['permission_code'])).toEqual([
      'identity.approve_financial_mobile_change',
    ]);
    const asked = await ask(third, (await signer()).id, newMobile());
    expect([asked.status, asked.body['error']]).toEqual([403, 'permission_required']);
    // In the service itself too (rule 12), not only at the route.
    const access = await h.app.get<AccessPort>(ACCESS_PORT, { strict: false }).resolve(third.id);
    await expect(
      h.app
        .get(StaffMobileChangeService)
        .request({ accountId: third.id, sessionId: randomUUID(), ip: null, roles: [] }, access, {
          accountId: (await signer()).id,
          mobile: newMobile(),
          reason: 'مستقیم به سرویس',
        }),
    ).rejects.toMatchObject({ response: { error: 'permission_required' } });
    // A CEO's own number: asked by the administrator, approved by the administrator and the
    // third approver, never by the CEO.
    const own = await ask(admin, ceo2.id, newMobile());
    expect(own.status, JSON.stringify(own.body)).toBe(201);
    const id = own.body['id'] as string;
    expect((await decide(admin, id, 'approved')).status).toBe(201);
    expect((await decide(third, id, 'approved')).body).toMatchObject({ status: 'approved' });
  });

  it('owner 1405/08/03: a signer’s first number comes through this page, not the self-service one', async () => {
    const accountant = await loggedInAccount(h, 'staff');
    await grantRole(h, accountant.id, 'accounting');
    const first = newMobile();
    const self = await as(accountant, 'POST', '/auth/mobile/request', { mobile: first });
    expect([self.status, self.body['error']]).toEqual([409, 'signer_mobile_needs_approval']);
    const asked = await ask(ceo, accountant.id, first);
    expect(asked.status, JSON.stringify(asked.body)).toBe(201);
    const id = asked.body['id'] as string;
    expect((await decide(ceo, id, 'approved')).status).toBe(201);
    const two = await decide(admin, id, 'approved');
    await h.app
      .get(StaffMobileChanges)
      .applyDue(accountant.id, at(two.body['effectiveAt'] as string, 1000));
    expect(await mobileOf(accountant.id)).toBe(first);
    // Staff who sign nothing still prove their own first mobile.
    const plain = await loggedInAccount(h, 'staff');
    expect((await as(plain, 'POST', '/auth/mobile/request', { mobile: newMobile() })).status).toBe(
      202,
    );
  });

  it('owner 1405/08/03: the server tool sets an approver’s first number only, audited, never a verified one', async () => {
    const tool = h.app.get(FirstApproverMobile);
    const nameOf = async (id: string) =>
      (await h.owner.query<Row>('SELECT username FROM user_accounts WHERE id = $1', [id]))
        .rows[0]?.['username'] as string;
    // The owner / IT officer: the third approver, with no number yet.
    const owner = await loggedInAccount(h, 'staff');
    await grantRole(h, owner.id, 'mobile_change_approver');
    const mobile = newMobile();
    const input = {
      username: await nameOf(owner.id),
      mobile: `0${mobile}`,
      // Run by the system administrator, witnessed by the CEO (never the owner).
      operator: await nameOf(admin.id),
      witness: ceoUsername,
      reason: 'شماره اول تأییدکننده',
    };
    const errorOf = (p: Promise<unknown>) =>
      p.then(
        () => null,
        (e: unknown) =>
          ((e as { getResponse?: () => unknown }).getResponse?.() as { error?: string } | undefined)
            ?.error,
      );
    expect(await errorOf(tool.set({ ...input, witness: input.operator }))).toBe(
      'witness_must_differ',
    );
    expect(
      await errorOf(tool.set({ ...input, operator: ceoUsername, witness: input.operator })),
    ).toBe('operator_must_be_system_admin');
    expect(await errorOf(tool.set({ ...input, witness: input.username }))).toBe(
      'witness_is_the_owner',
    );
    const plain = await signer();
    expect(await errorOf(tool.set({ ...input, witness: await nameOf(plain.id) }))).toBe(
      'witness_must_be_ceo',
    );
    expect(await errorOf(tool.set({ ...input, witness: 'nobody-by-this-name' }))).toBe(
      'witness_not_found',
    );
    expect(await mobileOf(owner.id)).toBeNull();
    expect(await tool.set(input)).toEqual({
      accountId: owner.id,
      mobileLastFour: mobile.slice(-4),
    });
    expect(await mobileOf(owner.id)).toBe(mobile);
    // Never again: the number it set, or any verified one, is changed by two people only.
    expect(await errorOf(tool.set({ ...input, mobile: `0${newMobile()}` }))).toBe(
      'mobile_already_verified',
    );
    expect(
      await errorOf(tool.set({ ...input, username: ceoUsername, witness: await nameOf(ceo2.id) })),
    ).toBe('mobile_already_verified');
    expect(await mobileOf(owner.id)).toBe(mobile);
    // Approvers only; a number another staff member holds is refused.
    const accountant = await loggedInAccount(h, 'staff');
    await grantRole(h, accountant.id, 'accounting');
    expect(await errorOf(tool.set({ ...input, username: await nameOf(accountant.id) }))).toBe(
      'approvers_only',
    );
    const other = await loggedInAccount(h, 'staff');
    await grantRole(h, other.id, 'mobile_change_approver');
    expect(await errorOf(tool.set({ ...input, username: await nameOf(other.id) }))).toBe(
      'mobile_taken',
    );
    // The audit names who ran it and who watched; the number by its last four only.
    const { rows } = await h.owner.query<Row>(
      `SELECT after::text AS after FROM audit_events
        WHERE action = 'identity.first_approver_mobile_set' AND entity_id = $1`,
      [owner.id],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.['after']).toContain(input.operator);
    expect(rows[0]?.['after']).toContain(ceoUsername);
    expect(rows[0]?.['after']).toContain(admin.id);
    expect(rows[0]?.['after']).not.toContain(mobile);

    // Owner 1405/08/03 (ج): the owner's next number only with the CEO and the system administrator.
    const next = newMobile();
    const asked = await ask(ceo, owner.id, next);
    expect(asked.status, JSON.stringify(asked.body)).toBe(201);
    const id = asked.body['id'] as string;
    expect((await decide(owner, id, 'approved')).body['error']).toBe('cannot_decide_own_mobile');
    expect((await decide(ceo, id, 'approved')).status).toBe(201);
    const two = await decide(admin, id, 'approved');
    expect(two.body).toMatchObject({ status: 'approved', approvedBy: [ceo.id, admin.id] });
  });
});

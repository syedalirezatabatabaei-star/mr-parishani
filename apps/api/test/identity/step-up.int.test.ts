import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { NoSessionStepUp, type StepUpTarget } from '../../src/common/auth/step-up.port';
import type { Actor } from '../../src/common/audit/audit.port';
import { operationKey, SmsOtpStepUp } from '../../src/modules/identity/step-up.service';
import {
  call,
  loggedInAccount,
  newMobile,
  startHarness,
  type Harness,
  type LoggedInAccount,
} from './harness';

/**
 * ADR-052 (owner 1405/08/02): the SMS one-time code of a financial signature. Six digits, two
 * minutes, one use, bound to one operation (type, record, amount, step) and one account; five
 * wrong tries lock it for fifteen minutes; a new code after sixty seconds, three an hour. The
 * code is never stored, logged or audited as itself.
 */

let h: Harness;
let svc: SmsOtpStepUp;

type Staff = LoggedInAccount & { mobile: string };

beforeAll(async () => {
  h = await startHarness();
  svc = h.app.get(SmsOtpStepUp);
}, 180_000);

afterAll(async () => {
  await h.close();
});

/** A staff account whose own mobile is verified. */
async function staff(): Promise<Staff> {
  const who = await loggedInAccount(h, 'staff');
  const mobile = newMobile();
  await h.owner.query(
    `UPDATE user_accounts SET mobile = $2, mobile_verified_at = now() WHERE id = $1`,
    [who.id, mobile],
  );
  return { ...who, mobile };
}

const op = (over: Partial<StepUpTarget> = {}): StepUpTarget => ({
  type: 'funding',
  id: randomUUID(),
  amountRial: 120_000_000n,
  step: 'approve',
  ...over,
});

const body = (t: StepUpTarget) => ({
  type: t.type,
  id: t.id,
  amountRial: t.amountRial === null ? null : t.amountRial.toString(),
  step: t.step,
});

async function challenge(who: Staff, t: StepUpTarget) {
  return call(h, 'POST', '/identity/step-up/challenges', {
    bearer: who.access,
    body: body(t),
  });
}

/** A fresh code for `t`: the cooldown of the last one cleared, as if a minute had passed. */
const cooldownOf = (who: Staff, t: StepUpTarget) =>
  `identity:step-up-cooldown:${who.id}:${operationKey(t)}`;

async function codeFor(who: Staff, t: StepUpTarget) {
  await h.redis.del(cooldownOf(who, t));
  const res = await challenge(who, t);
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return {
    challengeId: res.body['challengeId'] as string,
    code: h.stepUps.lastCodeFor(who.mobile),
  };
}

/** The actor of a request from this staff member, carrying `proof` as X-Step-Up would. */
const actor = (who: Staff, proof: { challengeId: string; code: string } | null): Actor => ({
  accountId: who.id,
  sessionId: randomUUID(),
  ip: '203.0.113.9',
  roles: [],
  stepUp: proof,
});

const errorOf = (p: Promise<unknown>) =>
  p.then(
    () => null,
    (e: unknown) => {
      const r = (e as { getResponse?: () => unknown }).getResponse?.();
      return (r as { error?: string } | undefined)?.error ?? 'unknown';
    },
  );

describe('ADR-052: the step-up challenge', () => {
  it('goes only to a verified mobile, masked in the answer, with the operation and amount in tomans', async () => {
    const unverified = await loggedInAccount(h, 'staff');
    const refused = await call(h, 'POST', '/identity/step-up/challenges', {
      bearer: unverified.access,
      body: body(op()),
    });
    expect(refused.status).toBe(403);
    expect(refused.body['error']).toBe('step_up_mobile_missing');

    const who = await staff();
    const t = op({ amountRial: 120_000_000n });
    const sent = await challenge(who, t);
    expect(sent.status).toBe(201);
    expect(sent.body).toMatchObject({
      maskedMobile: `${who.mobile.slice(0, 3)}***${who.mobile.slice(-4)}`,
      expiresInSeconds: 120,
      resendAfterSeconds: 60,
    });
    const job = h.stepUps.sent.at(-1);
    expect(job).toMatchObject({
      mobile: who.mobile,
      amountToman: '12000000',
      operation: 'شارژ کیف اعتبار',
    });
    expect(job?.code).toMatch(/^\d{6}$/);
  });

  it('a right code passes once; no code, an old one, or one for anything else is refused', async () => {
    const who = await staff();
    const t = op();
    // No code at all: required, with the operation to ask a code for.
    await expect(svc.assert(actor(who, null), t)).rejects.toMatchObject({
      response: {
        error: 'step_up_required',
        operation: { type: 'funding', id: t.id, step: 'approve' },
      },
    });
    const proof = await codeFor(who, t);
    // Another record, another amount, the other step, another account: refused.
    for (const other of [
      op({ id: randomUUID() }),
      op({ id: t.id, amountRial: 120_000_010n }),
      op({ id: t.id, step: 'request' }),
    ]) {
      expect(await errorOf(svc.assert(actor(who, proof), other))).toBe('step_up_invalid');
    }
    const someoneElse = await staff();
    expect(await errorOf(svc.assert(actor(someoneElse, proof), t))).toBe('step_up_invalid');
    // Past its two minutes: refused.
    const late = new Date(Date.now() + 121_000);
    expect(await errorOf(svc.assert(actor(who, proof), t, late))).toBe('step_up_invalid');
    // The right one: once.
    expect(await errorOf(svc.assert(actor(who, proof), t))).toBeNull();
    expect(await errorOf(svc.assert(actor(who, proof), t))).toBe('step_up_invalid');
  });

  it('a new code ends the one before it', async () => {
    const who = await staff();
    const t = op();
    const first = await codeFor(who, t);
    const second = await codeFor(who, t);
    expect(await errorOf(svc.assert(actor(who, first), t))).toBe('step_up_invalid');
    expect(await errorOf(svc.assert(actor(who, second), t))).toBeNull();
  });

  it('a new code after sixty seconds, at most three an hour', async () => {
    const who = await staff();
    const t = op();
    expect((await challenge(who, t)).status).toBe(201);
    const soon = await challenge(who, t);
    expect(soon.status).toBe(429);
    expect(soon.body['error']).toBe('resend_too_soon');
    await codeFor(who, t);
    await codeFor(who, t);
    await h.redis.del(cooldownOf(who, t));
    const fourth = await challenge(who, t);
    expect(fourth.status).toBe(429);
    expect(fourth.body['error']).toBe('rate_limited');
  });

  it('the waits count one operation: a signer approving many gets a code for each at once', async () => {
    const who = await staff();
    for (let i = 0; i < 5; i += 1) {
      const res = await challenge(who, op());
      expect(res.status, JSON.stringify(res.body)).toBe(201);
    }
    const both = await Promise.all([challenge(who, op()), challenge(who, op())]);
    expect(both.map((r) => r.status)).toEqual([201, 201]);
  });

  it('five wrong codes lock the operation for fifteen minutes, the right code too', async () => {
    const who = await staff();
    const t = op();
    const proof = await codeFor(who, t);
    const wrong = { ...proof, code: proof.code === '000000' ? '111111' : '000000' };
    for (let i = 0; i < 4; i += 1) {
      expect(await errorOf(svc.assert(actor(who, wrong), t))).toBe('step_up_invalid');
    }
    expect(await errorOf(svc.assert(actor(who, wrong), t))).toBe('locked');
    expect(await errorOf(svc.assert(actor(who, proof), t))).toBe('locked');
    const ttl = await h.redis.ttl(
      `identity:lock:step-up:${who.id}:funding:${t.id}:120000000:approve`,
    );
    expect(ttl).toBeGreaterThan(890);
  });

  it('two requests with one code at once: exactly one goes through (20 times)', async () => {
    for (let i = 0; i < 20; i += 1) {
      const who = await staff();
      const t = op();
      const proof = await codeFor(who, t);
      const results = await Promise.all([
        errorOf(svc.assert(actor(who, proof), t)),
        errorOf(svc.assert(actor(who, proof), t)),
      ]);
      expect(results.filter((r) => r === null)).toHaveLength(1);
    }
  });

  it('when the SMS cannot be sent, nothing is issued and the action waits', async () => {
    const who = await staff();
    h.stepUps.failNext = true;
    const res = await challenge(who, op());
    expect(res.status).toBe(503);
    expect(res.body['error']).toBe('step_up_unavailable');
  });

  it('no session (a scheduled job, the command line): not asked; the code is never in the audit trail', async () => {
    await expect(
      svc.assert({ accountId: null, sessionId: null, ip: null, roles: ['cli'] }, op()),
    ).resolves.toBeUndefined();
    const who = await staff();
    const t = op();
    const proof = await codeFor(who, t);
    await svc.assert(actor(who, proof), t);
    const { rows } = await h.owner.query<{ row: string }>(
      `SELECT row_to_json(a)::text AS row FROM audit_events a
        WHERE action LIKE 'identity.step_up_%' AND entity_id = $1`,
      [t.id],
    );
    expect(rows.length).toBeGreaterThanOrEqual(2);
    for (const r of rows) expect(r.row).not.toContain(proof.code);
  });

  it('the worker’s: jobs without a session pass, anything with a session is refused', async () => {
    const worker = new NoSessionStepUp();
    await expect(
      worker.assert({ accountId: null, sessionId: null, ip: null, roles: ['cli'] }),
    ).resolves.toBeUndefined();
    const who = await staff();
    expect(await errorOf(worker.assert(actor(who, await codeFor(who, op()))))).toBe(
      'step_up_unavailable',
    );
  });
});

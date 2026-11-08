import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CONFIG, type ConfigPort } from '../../src/common/config/config.port';
import { SmsOtpStepUp } from '../../src/modules/identity/step-up.service';
import { loggedInAccount, startHarness, type Harness } from './harness';

/**
 * ADR-052 (owner 1405/08/03): migration 0106 ships the SMS code off. While off, a financial
 * request or approval needs no code; two people turn it on after the production template, a
 * test SMS and every signer's verified mobile, and from then every one asks for its code.
 */

let h: Harness;

beforeAll(async () => {
  h = await startHarness({ stepUpOff: true });
}, 180_000);

afterAll(async () => {
  await h.close();
});

const actor = (accountId: string) => ({
  accountId,
  sessionId: randomUUID(),
  ip: '203.0.113.9',
  roles: [],
});

const target = () => ({
  type: 'funding' as const,
  id: randomUUID(),
  amountRial: 120_000_000n,
  step: 'approve' as const,
});

describe('ADR-052: the SMS code off and on', () => {
  it('ships off: no code is asked', async () => {
    const { value } = await h.app
      .get<ConfigPort>(CONFIG, { strict: false })
      .resolve('identity.financial_step_up');
    expect(value).toMatchObject({
      enabled: false,
      codeTtlSeconds: 120,
      mobileChangeDelayHours: 24,
    });
    const who = await loggedInAccount(h, 'staff');
    await expect(h.app.get(SmsOtpStepUp).assert(actor(who.id), target())).resolves.toBeUndefined();
  });

  it('turned on (as two people would approve it): every signature asks for its code', async () => {
    await h.owner.query(
      `INSERT INTO config_values (key, scope_level, value, effective_at, status, reason, decided_at)
       VALUES ('identity.financial_step_up', 'global',
               '{"enabled": true, "codeTtlSeconds": 120, "maxAttempts": 5, "lockoutSeconds": 900,
                 "resendAfterSeconds": 60, "maxSendsPerHour": 3, "mobileChangeDelayHours": 24}',
               now() - interval '1 second', 'approved', 'روشن شدن پس از شرط‌های مالک', now())`,
    );
    const who = await loggedInAccount(h, 'staff');
    await expect(h.app.get(SmsOtpStepUp).assert(actor(who.id), target())).rejects.toMatchObject({
      response: { error: 'step_up_required' },
    });
  });
});

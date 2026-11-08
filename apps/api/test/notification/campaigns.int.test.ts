import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  addJalaliDays,
  formatJalaliDate,
  fromJalali,
  normalizeMobile,
  toJalaliDateTime,
  type JalaliDate,
} from '@sepehr/contracts';
import { ACCESS_PORT, type AccessPort } from '../../src/common/auth/access.port';
import { CLI_ACTOR } from '../../src/common/auth/actor';
import type { Actor } from '../../src/common/audit/audit.port';
import {
  CREDIT_CONTRACT_FACTS,
  type CreditContractFactsPort,
} from '../../src/common/credit/credit-contract-facts.port';
import { CollectionService } from '../../src/modules/collection/collection.service';
import {
  CampaignService,
  type CampaignCandidate,
} from '../../src/modules/notification/campaign.service';
import {
  NOTIFICATION_SMS_SENDER,
  NotificationService,
} from '../../src/modules/notification/notification.service';
import { RepaymentService } from '../../src/modules/repayment/repayment.service';
import { WalletService } from '../../src/modules/wallet/wallet.service';
import {
  CapturingTextSender,
  grantRole,
  loggedInAccount,
  startHarness,
  type Harness,
  type LoggedInAccount,
} from '../identity/harness';
import { fundingSteps } from '../credit/funding-steps';
import { CREDIT_HARNESS, creditWorld, type Body, type Row } from '../credit/world';

/**
 * Task 6-5 (doc 15 §7, §9 tests 7 and 8; owner 1405/07/16): one SMS at a chosen Jalali
 * moment, and campaigns: named filters, a preview, approval always by a second person (above
 * the locked threshold only approve_campaigns), recipients fixed at approval, sent gradually
 * at the configured rate within the allowed hours, paused or stopped, one message each.
 */

type World = Awaited<ReturnType<typeof creditWorld>>;

let h: Harness;
let w: World;
let steps: ReturnType<typeof fundingSteps>;
let campaigns: CampaignService;
let notifications: NotificationService;
let repayment: RepaymentService;
let wallet: WalletService;
let collection: CollectionService;
let strategy: LoggedInAccount;
let strategyB: LoggedInAccount;
let support: LoggedInAccount;
let supportB: LoggedInAccount;
let agent: LoggedInAccount;
let advisor: LoggedInAccount;
const queue = new CapturingTextSender();

const role = async (code: string) => {
  const who = await loggedInAccount(h, 'staff');
  await grantRole(h, who.id, code);
  return who;
};

beforeAll(async () => {
  h = await startHarness({ ...CREDIT_HARNESS, overrides: [[NOTIFICATION_SMS_SENDER, queue]] });
  w = await creditWorld(h);
  steps = fundingSteps(h, w, {
    manager: await w.role('credit_manager'),
    finance: await w.role('accounting'),
  });
  campaigns = h.app.get(CampaignService);
  notifications = h.app.get(NotificationService);
  repayment = h.app.get(RepaymentService);
  wallet = h.app.get(WalletService);
  collection = h.app.get(CollectionService);
  strategy = await role('strategy_manager');
  strategyB = await role('strategy_manager');
  support = await role('support');
  supportB = await role('support');
  agent = await role('collection');
  advisor = await role('advisor');
  for (const t of TEMPLATES) {
    const made = await w.staff(strategy, 'POST', '/notification/sms-templates', {
      ...t,
      reason: 'قالب آزمون ۶-۵',
    });
    expect(made.status, JSON.stringify(made.body)).toBe(201);
  }
}, 240_000);

afterAll(async () => {
  vi.restoreAllMocks();
  await h.close();
});

const TEMPLATES = [
  {
    code: 'campaign.overdue',
    audience: 'borrower',
    category: 'transactional',
    body: '{{name}} گرامی، قسط شما {{days_overdue}} روز معوق است: {{amount}}',
  },
  {
    code: 'campaign.borrower_hello',
    audience: 'borrower',
    category: 'transactional',
    body: '{{name}} گرامی، سلام',
  },
  {
    code: 'campaign.borrower_due',
    audience: 'borrower',
    category: 'transactional',
    body: 'سررسید {{due_date}}',
  },
  {
    code: 'campaign.guarantor',
    audience: 'guarantor',
    category: 'transactional',
    body: '{{name}} گرامی، قسط وام {{borrower_name}} معوق است',
  },
  {
    code: 'campaign.patient',
    audience: 'patient',
    category: 'transactional',
    body: '{{name}} عزیز، خبر خوب',
  },
  {
    code: 'campaign.patient_promo',
    audience: 'patient',
    category: 'promotional',
    body: '{{name}} عزیز، تخفیف',
  },
  { code: 'campaign.patient_urgent', audience: 'patient', category: 'urgent', body: 'کد {{name}}' },
  { code: 'scheduled.staff', audience: 'staff', category: 'transactional', body: 'جلسه {{count}}' },
] as const;

/** Tehran's next day (Jalali), and an hour of it as an instant. */
function tomorrow(): JalaliDate {
  const t = toJalaliDateTime(new Date());
  return addJalaliDays({ year: t.year, month: t.month, day: t.day }, 1);
}
const tomorrowAt = (hour: number, minute = 0) => fromJalali(tomorrow(), { hour, minute });

let serial = 0;
/** Fresh, distinct mobiles. */
function mobiles(n: number): string[] {
  const base = 100_000 * ++serial + Math.floor(Math.random() * 90) * 10_000_000;
  return Array.from({ length: n }, (_, i) => `9${String(base + i).padStart(9, '0')}`);
}

const synthetic = (list: readonly string[], extra: Partial<CampaignCandidate> = {}) =>
  list.map((mobile, i) => ({
    personId: null,
    mobile,
    values: { name: `گیرنده ${String(i)}` },
    ...extra,
  }));

async function setConfig(key: string, value: unknown) {
  await h.owner.query(
    `INSERT INTO config_values (key, scope_level, value, effective_at, status, reason, decided_at)
     VALUES ($1, 'global', $2::jsonb, now(), 'approved', 'آزمون ۶-۵', now())`,
    [key, JSON.stringify(value)],
  );
}

async function create(who: LoggedInAccount, body: Body) {
  return w.staff(who, 'POST', '/notification/campaigns', {
    name: `کمپین ${randomUUID()}`,
    ...body,
  });
}

async function made(who: LoggedInAccount, body: Body): Promise<string> {
  const res = await create(who, body);
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body['id'] as string;
}

const asActor = async (who: LoggedInAccount) => ({
  actor: { ...CLI_ACTOR, accountId: who.id } as Actor,
  access: await h.app.get<AccessPort>(ACCESS_PORT).resolve(who.id),
});

const campaignRow = async (id: string) =>
  (await h.owner.query<Row>('SELECT * FROM sms_campaigns WHERE id = $1', [id])).rows[0] as Row;

const recipients = async (id: string) =>
  (
    await h.owner.query<Row>(
      'SELECT mobile, status, cancel_reason, dispatch_id FROM sms_campaign_recipients WHERE campaign_id = $1 ORDER BY mobile',
      [id],
    )
  ).rows;

async function stopAll() {
  const { rows } = await h.owner.query<Row>(
    `SELECT id FROM sms_campaigns WHERE status IN ('sending', 'paused')`,
  );
  for (const r of rows) {
    const res = await w.staff(
      support,
      'POST',
      `/notification/campaigns/${r['id'] as string}/stop`,
      {
        reason: 'پایان آزمون',
      },
    );
    expect(res.status).toBe(200);
  }
}

/** A funded loan: its case, borrower, purse and first installment. */
async function loan() {
  const { patient, applicationId } = await steps.approved();
  await steps.complete(patient, applicationId);
  const purseId = await steps.fund(applicationId);
  const purse = await wallet.summary(purseId);
  const [scheduleId] = await repayment.schedulesOf(purse.caseId);
  const s = await repayment.schedule(scheduleId ?? '');
  return { patient, purse, scheduleId: s.id, installments: s.installments };
}

describe('campaigns: approval by a second person (doc 15 test 7; owner ج)', () => {
  it('above the threshold only approve_campaigns; at or below any second manager; never the creator; the threshold locked', async () => {
    const spy = vi.spyOn(campaigns, 'candidates');
    try {
      // 201 recipients, threshold 200: the creator 409, a second support 403, strategy 200.
      spy.mockResolvedValue(synthetic(mobiles(201)));
      const big = await made(support, {
        filterCode: 'borrowers_active',
        templateCode: 'campaign.borrower_hello',
      });
      const preview = await w.staff(supportB, 'GET', `/notification/campaigns/${big}/preview`);
      expect(preview.status).toBe(200);
      expect(preview.body).toMatchObject({
        recipientCount: 201,
        twoPersonThreshold: 200,
        needsApproveCampaigns: true,
      });
      expect(preview.body['sample']).toBe('گیرنده 0 گرامی، سلام');
      const own = await w.staff(support, 'POST', `/notification/campaigns/${big}/approve`);
      expect(own.status).toBe(409);
      expect(own.body['error']).toBe('same_person');
      const second = await w.staff(supportB, 'POST', `/notification/campaigns/${big}/approve`);
      expect(second.status).toBe(403);
      expect(second.body['permission']).toBe('notification.approve_campaigns');
      const approved = await w.staff(strategy, 'POST', `/notification/campaigns/${big}/approve`);
      expect(approved.status, JSON.stringify(approved.body)).toBe(200);
      expect(approved.body).toMatchObject({
        status: 'sending',
        recipientCount: 201,
        approvedBy: strategy.id,
      });

      // 200 recipients: still two people (owner ج) — the creator 409, a second support 200.
      spy.mockResolvedValue(synthetic(mobiles(200)));
      const small = await made(strategy, {
        filterCode: 'borrowers_active',
        templateCode: 'campaign.borrower_hello',
      });
      expect(
        (await w.staff(strategy, 'POST', `/notification/campaigns/${small}/approve`)).status,
      ).toBe(409);
      const below = await w.staff(supportB, 'POST', `/notification/campaigns/${small}/approve`);
      expect(below.status, JSON.stringify(below.body)).toBe(200);
      expect(below.body['recipientCount']).toBe(200);

      // The database refuses the creator too.
      await expect(
        h.owner.query(`UPDATE sms_campaigns SET approved_by = created_by WHERE id = $1`, [small]),
      ).rejects.toThrow();

      // The threshold changed in the panel: the next campaign, not the one already made.
      spy.mockResolvedValue(synthetic(mobiles(201)));
      const before = await made(support, {
        filterCode: 'borrowers_active',
        templateCode: 'campaign.borrower_hello',
      });
      await setConfig('notification.bulk_two_person_threshold', 500);
      try {
        const after = await made(support, {
          filterCode: 'borrowers_active',
          templateCode: 'campaign.borrower_hello',
        });
        expect((await campaignRow(before))['two_person_threshold']).toBe(200);
        expect((await campaignRow(after))['two_person_threshold']).toBe(500);
        expect(
          (await w.staff(supportB, 'POST', `/notification/campaigns/${before}/approve`)).status,
        ).toBe(403);
        expect(
          (await w.staff(supportB, 'POST', `/notification/campaigns/${after}/approve`)).status,
        ).toBe(200);
      } finally {
        await setConfig('notification.bulk_two_person_threshold', 200);
      }
      const { rows: audit } = await h.owner.query<Row>(
        `SELECT action FROM audit_events WHERE entity_id = $1 ORDER BY seq`,
        [big],
      );
      expect(audit.map((a) => a['action'])).toEqual([
        'notification.campaign_created',
        'notification.campaign_approved',
      ]);
      const { rows: events } = await h.owner.query<Row>(
        `SELECT payload FROM outbox_events WHERE event_type = 'sms.campaign_approved' AND aggregate_id = $1`,
        [big],
      );
      expect(events[0]?.['payload']).toMatchObject({ campaignId: big, recipientCount: 201 });
    } finally {
      spy.mockRestore();
      await stopAll();
    }
  });
});

describe('campaigns: the named filters and the snapshot (doc 15 test 8)', () => {
  it('overdue borrowers and their guarantors, from the ports; the list fixed at approval', async () => {
    const a = await loan();
    const b = await loan();
    const due = a.installments[0]?.dueOn ?? '';
    const late = new Date(`${due}T08:30:00Z`);
    late.setUTCDate(late.getUTCDate() + 6);
    const mobileOf = (l: typeof a) => normalizeMobile(l.patient.mobile);

    const id = await made(support, {
      filterCode: 'borrowers_overdue_at_least',
      filterParams: { days: 1 },
      templateCode: 'campaign.overdue',
    });
    const { actor, access } = await asActor(strategy);
    const preview = await campaigns.preview(access, id, late);
    expect(preview.recipientCount).toBeGreaterThanOrEqual(2);
    expect(preview.sample).toMatch(/روز معوق است/);
    expect(preview.sample).not.toMatch(/[0-9]/); // Persian digits only
    await campaigns.approve(actor, access, id, late);
    const fixed = await recipients(id);
    const count = (await campaignRow(id))['recipient_count'];
    expect(fixed.length).toBe(count);
    expect(fixed.map((r) => r['mobile'])).toEqual(
      expect.arrayContaining([mobileOf(a), mobileOf(b)]),
    );

    // A pays (leaves the filter), C becomes overdue (enters it): the campaign is unchanged.
    const owed = a.installments[0]?.amountRial ?? 0n;
    const { paymentId } = await repayment.registerReceipt(CLI_ACTOR, {
      idempotencyKey: `test:receipt:${randomUUID()}`,
      scheduleId: a.scheduleId,
      amountRial: owed,
      receivedAt: new Date(),
    });
    await repayment.approvePayment(CLI_ACTOR, paymentId);
    const c = await loan();
    const now = await campaigns.preview(access, id, late);
    const nowMobiles = (await campaigns.candidates({ ...(await campaignRowView(id)) }, late)).map(
      (x) => x.mobile,
    );
    expect(nowMobiles).not.toContain(mobileOf(a));
    expect(nowMobiles).toContain(mobileOf(c));
    expect(now.recipientCount).toBeGreaterThanOrEqual(1);
    expect(await recipients(id)).toEqual(fixed);
    expect((await campaignRow(id))['recipient_count']).toBe(count);

    // The guarantors of the same loans (credit's guarantor flow is tested there).
    const guarantor = await w.patient();
    const { rows: g } = await h.owner.query<Row>(
      'SELECT person_id FROM user_accounts WHERE id = $1',
      [guarantor.id],
    );
    const facts = h.app.get<CreditContractFactsPort>(CREDIT_CONTRACT_FACTS, { strict: false });
    const original = facts.facts.bind(facts);
    const spy = vi.spyOn(facts, 'facts').mockImplementation(async (appId) => {
      const real = await original(appId);
      return (
        real && {
          ...real,
          guarantors: [{ id: randomUUID(), personId: g[0]?.['person_id'] as string }],
        }
      );
    });
    try {
      const gid = await made(support, {
        filterCode: 'guarantors_overdue_at_least',
        filterParams: { days: 1 },
        templateCode: 'campaign.guarantor',
      });
      const gp = await campaigns.preview(access, gid, late);
      // One guarantor mobile, shared by every loan: one message (the rest duplicates).
      expect(gp.recipientCount).toBe(1);
      expect(gp.excluded['duplicate_mobile']).toBeGreaterThanOrEqual(1);
      expect(gp.sample).toMatch(/قسط وام .+ معوق است/);
    } finally {
      spy.mockRestore();
      await stopAll();
    }
  }, 300_000);

  it('active borrowers and the patients of a workplace', async () => {
    const id = await made(support, {
      filterCode: 'borrowers_active',
      templateCode: 'campaign.borrower_hello',
    });
    const l = await loan();
    const row = await campaignRowView(id);
    const active = await campaigns.candidates(row, new Date());
    expect(active.map((c) => c.personId)).toContain(l.purse.borrowerPersonId);
    expect(active.every((c) => c.values['name'] !== undefined)).toBe(true);

    const pid = await made(support, {
      filterCode: 'patients_of_center',
      filterParams: { workplaceIds: [w.workplaceId] },
      templateCode: 'campaign.patient',
    });
    // The loans' appointments were requested; the doctor confirms one (booking's own path).
    const { rows: requested } = await h.owner.query<Row>(
      `SELECT id FROM appointments WHERE workplace_id = $1 AND status = 'requested' LIMIT 1`,
      [w.workplaceId],
    );
    if (requested[0]) {
      const path = `/booking/appointments/${requested[0]['id'] as string}/respond`;
      const confirmed = await w.staff(w.doctor, 'POST', path, {
        decision: 'confirm',
      });
      expect(confirmed.status, JSON.stringify(confirmed.body)).toBeLessThan(300);
    }
    const { rows: expected } = await h.owner.query<Row>(
      `SELECT DISTINCT mobile FROM appointments
       WHERE workplace_id = $1 AND status IN ('confirmed', 'checked_in', 'examined')`,
      [w.workplaceId],
    );
    expect(expected.length).toBeGreaterThan(0);
    const patients = await campaigns.candidates(await campaignRowView(pid), new Date());
    expect(patients.map((p) => p.mobile).sort()).toEqual(expected.map((r) => r['mobile']).sort());
    // A range that ended before them: nobody.
    const past = formatJalaliDate(addJalaliDays(tomorrow(), -400));
    const none = await made(support, {
      filterCode: 'patients_of_center',
      filterParams: { workplaceIds: [w.workplaceId], to: past },
      templateCode: 'campaign.patient',
    });
    expect(await campaigns.candidates(await campaignRowView(none), new Date())).toEqual([]);
  });
});

/** The service's own row of a campaign (what candidates() takes). */
async function campaignRowView(id: string) {
  const { rows } = await h.owner.query<Row>(
    `SELECT c.*, t.code AS template_code, t.version AS template_version, t.body AS template_body
     FROM sms_campaigns c JOIN sms_templates t ON t.id = c.template_id WHERE c.id = $1`,
    [id],
  );
  return rows[0] as unknown as Parameters<CampaignService['candidates']>[0];
}

describe('campaigns: who is left out (doc 15 test 10)', () => {
  it('no mobile, held, duplicates; promotional behind its flag and consent; transactional to the unsubscribed', async () => {
    const spy = vi.spyOn(campaigns, 'candidates');
    const held = vi.spyOn(collection, 'isHeld');
    try {
      const [consented, withdrawn, silent, dup] = mobiles(4) as [string, string, string, string];
      const heldPerson = randomUUID();
      held.mockImplementation((personId) => Promise.resolve(personId === heldPerson));
      for (const [mobile, action] of [
        [consented, 'consent'],
        [withdrawn, 'consent'],
        [withdrawn, 'withdraw'],
      ] as const) {
        expect(
          (
            await w.staff(support, 'POST', '/notification/sms-consents', {
              mobile,
              action,
              reason: 'آزمون',
            })
          ).status,
        ).toBe(201);
      }
      spy.mockResolvedValue([
        ...synthetic([consented, withdrawn, silent, dup, dup]),
        { personId: null, mobile: null, values: { name: 'بی‌موبایل' } },
        { personId: heldPerson, mobile: mobiles(1)[0] ?? '', values: { name: 'فوت‌شده' } },
      ]);

      // Promotional: off until unsubscribing is built (owner).
      const off = await create(support, {
        filterCode: 'patients_of_center',
        filterParams: { workplaceIds: [w.workplaceId] },
        templateCode: 'campaign.patient_promo',
      });
      expect(off.status).toBe(409);
      expect(off.body['error']).toBe('promotional_campaigns_off');
      // Urgent never: it skips the allowed hours.
      const urgent = await create(support, {
        filterCode: 'patients_of_center',
        filterParams: { workplaceIds: [w.workplaceId] },
        templateCode: 'campaign.patient_urgent',
      });
      expect(urgent.status).toBe(409);
      expect(urgent.body['error']).toBe('campaign_category_not_allowed');

      await setConfig('notification.promotional_campaigns_enabled', true);
      try {
        const promo = await made(support, {
          filterCode: 'patients_of_center',
          filterParams: { workplaceIds: [w.workplaceId] },
          templateCode: 'campaign.patient_promo',
        });
        const p = await w.staff(supportB, 'GET', `/notification/campaigns/${promo}/preview`);
        expect(p.body['recipientCount']).toBe(1);
        expect(p.body['excluded']).toEqual({
          unsubscribed: 1,
          no_consent: 3,
          no_mobile: 1,
          held: 1,
        });
      } finally {
        await setConfig('notification.promotional_campaigns_enabled', false);
      }
      // Transactional: the unsubscribed still get it; held, no mobile and duplicates do not.
      const info = await made(support, {
        filterCode: 'patients_of_center',
        filterParams: { workplaceIds: [w.workplaceId] },
        templateCode: 'campaign.patient',
      });
      const t = await w.staff(supportB, 'GET', `/notification/campaigns/${info}/preview`);
      expect(t.body['recipientCount']).toBe(4);
      expect(t.body['excluded']).toEqual({ no_mobile: 1, held: 1, duplicate_mobile: 1 });
    } finally {
      spy.mockRestore();
      held.mockRestore();
    }
  });
});

describe('campaigns: gradual sending', () => {
  it('outside the allowed hours the messages wait for 08:00; paused sends nothing; resumed makes no duplicate; stopped cancels the rest and what waits', async () => {
    const spy = vi.spyOn(campaigns, 'candidates');
    try {
      const list = mobiles(10);
      spy.mockResolvedValue(synthetic(list));
      const id = await made(support, {
        filterCode: 'borrowers_active',
        templateCode: 'campaign.borrower_hello',
      });
      expect(
        (await w.staff(strategy, 'POST', `/notification/campaigns/${id}/approve`)).status,
      ).toBe(200);
      await setConfig('notification.campaign_batch_per_minute', 4);
      const night = tomorrowAt(22);
      // The first batch: a quarter-minute's share of the rate (4 a minute → 1).
      await campaigns.run(night);
      let sent = (await recipients(id)).filter((r) => r['status'] === 'dispatched');
      expect(sent.length).toBe(1);
      // A minute later: four more; each waits for the allowed hours.
      const later = new Date(night.getTime() + 60_000);
      await campaigns.run(later);
      sent = (await recipients(id)).filter((r) => r['status'] === 'dispatched');
      expect(sent.length).toBe(5);
      const { rows: waiting } = await h.owner.query<Row>(
        `SELECT status, send_after FROM sms_dispatches WHERE idempotency_key LIKE $1`,
        [`campaign:${id}:%`],
      );
      const morning = fromJalali(addJalaliDays(tomorrow(), 1), { hour: 8 });
      expect(waiting.every((d) => d['status'] === 'scheduled')).toBe(true);
      expect(waiting.every((d) => (d['send_after'] as Date).getTime() === morning.getTime())).toBe(
        true,
      );

      // Paused: nothing; resumed: on, no duplicate.
      expect(
        (
          await w.staff(support, 'POST', `/notification/campaigns/${id}/pause`, {
            reason: 'توقف موقت',
          })
        ).status,
      ).toBe(200);
      await campaigns.run(new Date(later.getTime() + 60_000));
      expect((await recipients(id)).filter((r) => r['status'] === 'dispatched').length).toBe(5);
      expect(
        (
          await w.staff(support, 'POST', `/notification/campaigns/${id}/resume`, {
            reason: 'ادامه',
          })
        ).status,
      ).toBe(200);
      await campaigns.run(new Date(later.getTime() + 120_000));
      expect((await recipients(id)).filter((r) => r['status'] === 'dispatched').length).toBe(9);

      // Stopped: the last one cancelled; the nine waiting for the morning cancelled in 6-4.
      const stopped = await w.staff(support, 'POST', `/notification/campaigns/${id}/stop`, {
        reason: 'اشتباه در متن',
      });
      expect(stopped.status).toBe(200);
      const after = await recipients(id);
      expect(
        after.filter((r) => r['status'] === 'cancelled').map((r) => r['cancel_reason']),
      ).toEqual(['stopped']);
      const report = await w.staff(supportB, 'GET', `/notification/campaigns/${id}/report`);
      expect(report.body).toMatchObject({
        recipients: { pending: 0, dispatched: 9, cancelled: 1 },
        dispatches: { cancelled: 9 },
      });
      expect(JSON.stringify(report.body)).not.toMatch(/9\d{9}/);
      await campaigns.run(new Date(later.getTime() + 180_000));
      expect((await campaignRow(id))['status']).toBe('stopped');
    } finally {
      spy.mockRestore();
      await setConfig('notification.campaign_batch_per_minute', 100);
    }
  });

  it('5,000 recipients, two workers at once: each mobile queued exactly once; completed', async () => {
    const spy = vi.spyOn(campaigns, 'candidates');
    try {
      const list = mobiles(5_000);
      spy.mockResolvedValue(synthetic(list));
      const id = await made(support, {
        filterCode: 'borrowers_active',
        templateCode: 'campaign.borrower_hello',
      });
      const approved = await w.staff(strategy, 'POST', `/notification/campaigns/${id}/approve`);
      expect(approved.status, JSON.stringify(approved.body)).toBe(200);
      await setConfig('notification.campaign_batch_per_minute', 100_000);
      let t = tomorrowAt(12).getTime();
      for (let i = 0; i < 20 && (await campaignRow(id))['status'] === 'sending'; i += 1) {
        t += 60_000;
        await Promise.all([campaigns.run(new Date(t)), campaigns.run(new Date(t))]);
      }
      expect((await campaignRow(id))['status']).toBe('completed');
      const { rows } = await h.owner.query<Row>(
        `SELECT count(*)::int AS n, count(DISTINCT mobile)::int AS m FROM sms_dispatches
         WHERE idempotency_key LIKE $1`,
        [`campaign:${id}:%`],
      );
      expect(rows[0]).toEqual({ n: 5_000, m: 5_000 });
      const left = await h.owner.query<Row>(
        `SELECT status, count(*)::int AS n FROM sms_campaign_recipients WHERE campaign_id = $1 GROUP BY status`,
        [id],
      );
      expect(left.rows).toEqual([{ status: 'dispatched', n: 5_000 }]);
      const { rows: done } = await h.owner.query<Row>(
        `SELECT payload FROM outbox_events WHERE event_type = 'sms.campaign_completed' AND aggregate_id = $1`,
        [id],
      );
      expect(done).toHaveLength(1);
      expect(done[0]?.['payload']).toMatchObject({ dispatched: 5_000, cancelled: 0 });
      // Released by 6-4: queued once each.
      const before = queue.sent.length;
      for (let i = 0; i < 80; i += 1) {
        const r = await notifications.release(new Date(t + 60_000));
        if (r.queued === 0) break;
      }
      const jobs = queue.sent.slice(before).map((s) => s.mobile);
      expect(new Set(jobs).size).toBe(jobs.length);
      expect(jobs.filter((m) => list.includes(m))).toHaveLength(5_000);
    } finally {
      spy.mockRestore();
      await setConfig('notification.campaign_batch_per_minute', 100);
    }
  }, 600_000);
});

describe('end to end with real loans (owner: no filter result replaced)', () => {
  it('the real filter → preview → approval by a second person → gradual sending → queued once each', async () => {
    const loans = [await loan(), await loan(), await loan()];
    const due = loans[0]?.installments[0]?.dueOn ?? '';
    // Noon in Tehran six days after the first due day: inside the allowed hours, overdue.
    const late = new Date(`${due}T08:30:00Z`);
    late.setUTCDate(late.getUTCDate() + 6);
    const ours = loans.map((l) => normalizeMobile(l.patient.mobile) ?? '');

    const id = await made(support, {
      filterCode: 'borrowers_overdue_at_least',
      filterParams: { days: 5 },
      templateCode: 'campaign.overdue',
    });
    const creator = await asActor(support);
    const second = await asActor(supportB);
    const preview = await campaigns.preview(second.access, id, late);
    expect(preview.recipientCount).toBeGreaterThanOrEqual(3);
    expect(preview.sample).toMatch(/گرامی، قسط شما .+ روز معوق است: .+/);
    expect(preview.needsApproveCampaigns).toBe(false);

    // Never the creator; a second person approves (at or below the threshold: support may).
    await expect(campaigns.approve(creator.actor, creator.access, id, late)).rejects.toMatchObject({
      response: { error: 'same_person' },
    });
    const approved = await campaigns.approve(second.actor, second.access, id, late);
    expect(approved).toMatchObject({ status: 'sending', approvedBy: supportB.id });
    expect(approved.recipientCount).toBe(preview.recipientCount);
    const fixed = await recipients(id);
    expect(fixed.map((r) => r['mobile'])).toEqual(expect.arrayContaining(ours));

    // Sent at the default rate (100 a minute): a quarter-minute's share, then the rest.
    let t = late.getTime();
    for (let i = 0; i < 10 && (await campaignRow(id))['status'] === 'sending'; i += 1) {
      await campaigns.run(new Date(t));
      t += 60_000;
    }
    expect((await campaignRow(id))['status']).toBe('completed');
    const { rows: sent } = await h.owner.query<Row>(
      `SELECT mobile, text, status FROM sms_dispatches WHERE idempotency_key LIKE $1 ORDER BY mobile`,
      [`campaign:${id}:%`],
    );
    expect(sent).toHaveLength(fixed.length);
    for (const m of ours) {
      const mine = sent.filter((s) => s['mobile'] === m);
      expect(mine).toHaveLength(1);
      // The borrower's own name and overdue amount, in Persian digits.
      expect(mine[0]?.['text']).toMatch(/روز معوق است: [۰-۹٬,]+ تومان/);
      expect(mine[0]?.['text']).not.toMatch(/[0-9]/);
    }
    // 6-4 queues each one once (each call takes a batch; earlier tests left messages due).
    const before = queue.sent.length;
    const waiting = async () =>
      (
        await h.owner.query<Row>(
          `SELECT count(*)::int AS n FROM sms_dispatches
           WHERE idempotency_key LIKE $1 AND status = 'scheduled'`,
          [`campaign:${id}:%`],
        )
      ).rows[0]?.['n'];
    for (let i = 0; i < 100 && (await waiting()) !== 0; i += 1) {
      await notifications.release(new Date(t));
    }
    expect(await waiting()).toBe(0);
    const jobs = queue.sent.slice(before).filter((s) => ours.includes(s.mobile));
    expect(jobs.map((j) => j.mobile).sort()).toEqual([...ours].sort());
  }, 600_000);
});

describe('one scheduled SMS (task 6-5)', () => {
  it('a Jalali moment in Tehran, moved into the allowed hours; cancelled while it waits, 409 once released', async () => {
    const p = await w.patient();
    const { rows } = await h.owner.query<Row>('SELECT person_id FROM user_accounts WHERE id = $1', [
      p.id,
    ]);
    const personId = rows[0]?.['person_id'] as string;
    const day = addJalaliDays(tomorrow(), 1);
    const sendAt = { date: formatJalaliDate(day), time: '10:30' };
    const made1 = await w.staff(support, 'POST', '/notification/scheduled-sms', {
      templateCode: 'campaign.patient',
      personId,
      values: { name: 'سارا' },
      sendAt,
      reason: 'پیگیری',
    });
    expect(made1.status, JSON.stringify(made1.body)).toBe(201);
    expect(made1.body).toMatchObject({ status: 'scheduled' });
    expect(new Date(made1.body['sendAfter'] as string).getTime()).toBe(
      fromJalali(day, { hour: 10, minute: 30 }).getTime(),
    );
    // 23:00: moved to the next morning's 08:00.
    const late = await w.staff(agent, 'POST', '/notification/scheduled-sms', {
      templateCode: 'campaign.patient',
      personId,
      values: { name: 'سارا' },
      sendAt: { date: formatJalaliDate(day), time: '23:00' },
      reason: 'پیگیری',
    });
    expect(late.status).toBe(201);
    expect(new Date(late.body['sendAfter'] as string).getTime()).toBe(
      fromJalali(addJalaliDays(day, 1), { hour: 8 }).getTime(),
    );

    const id = made1.body['dispatchId'] as string;
    const cancel = (dispatchId: string) =>
      w.staff(support, 'POST', `/notification/scheduled-sms/${dispatchId}/cancel`, {
        reason: 'منصرف شد',
      });
    expect((await cancel(id)).status).toBe(200);
    expect((await cancel(id)).status).toBe(409);
    // Released (its moment came): no longer cancellable.
    const lateId = late.body['dispatchId'] as string;
    // Released at its moment (each call takes a batch; earlier tests left messages queued).
    for (let i = 0; i < 60; i += 1) {
      await notifications.release(fromJalali(addJalaliDays(day, 1), { hour: 9 }));
      const { rows: now } = await h.owner.query<Row>(
        'SELECT status FROM sms_dispatches WHERE id = $1',
        [late.body['dispatchId']],
      );
      if (now[0]?.['status'] !== 'scheduled') break;
    }
    const { rows: d } = await h.owner.query<Row>(
      'SELECT status FROM sms_dispatches WHERE id = $1',
      [lateId],
    );
    expect(d[0]?.['status']).toBe('pending');
    const released = await cancel(lateId);
    expect(released.status).toBe(409);
    expect(released.body['error']).toBe('not_cancellable');
    // Never another module's message.
    const { rows: other } = await h.owner.query<Row>(
      `SELECT id FROM sms_dispatches WHERE idempotency_key NOT LIKE 'notification:scheduled:%' LIMIT 1`,
    );
    if (other[0]) expect((await cancel(other[0]['id'] as string)).status).toBe(404);
    const { rows: audit } = await h.owner.query<Row>(
      `SELECT action FROM audit_events WHERE entity_id = $1 ORDER BY seq`,
      [id],
    );
    expect(audit.map((a) => a['action'])).toEqual([
      'notification.sms_scheduled',
      'notification.sms_schedule_cancelled',
    ]);
  });

  it('refused: the past, urgent, a missing value, a raw mobile to a patient; a staff mobile allowed', async () => {
    const post = (body: Body) =>
      w.staff(support, 'POST', '/notification/scheduled-sms', { reason: 'آزمون', ...body });
    const p = await w.patient();
    const { rows } = await h.owner.query<Row>('SELECT person_id FROM user_accounts WHERE id = $1', [
      p.id,
    ]);
    const personId = rows[0]?.['person_id'] as string;
    const day = formatJalaliDate(addJalaliDays(tomorrow(), 1));
    const past = formatJalaliDate(addJalaliDays(tomorrow(), -3));
    const r1 = await post({
      templateCode: 'campaign.patient',
      personId,
      values: { name: 'x' },
      sendAt: { date: past, time: '10:00' },
    });
    expect([r1.status, r1.body['error']]).toEqual([400, 'send_at_past']);
    const r2 = await post({
      templateCode: 'campaign.patient_urgent',
      personId,
      values: { name: 'x' },
      sendAt: { date: day, time: '10:00' },
    });
    expect([r2.status, r2.body['error']]).toEqual([409, 'urgent_not_schedulable']);
    const r3 = await post({
      templateCode: 'campaign.patient',
      personId,
      values: {},
      sendAt: { date: day, time: '10:00' },
    });
    expect([r3.status, r3.body['error']]).toEqual([400, 'template_value_missing']);
    const r4 = await post({
      templateCode: 'campaign.patient',
      mobile: '09121234567',
      values: { name: 'x' },
      sendAt: { date: day, time: '10:00' },
    });
    expect([r4.status, r4.body['error']]).toEqual([400, 'person_required']);
    const r5 = await post({
      templateCode: 'scheduled.staff',
      mobile: '09121234567',
      values: { count: '۳' },
      sendAt: { date: day, time: '10:00' },
    });
    expect(r5.status).toBe(201);
  });
});

describe('access (task 6-5)', () => {
  it('without the permission 403; a template of another recipient or with a field the filter lacks 409', async () => {
    const body = { filterCode: 'borrowers_active', templateCode: 'campaign.borrower_hello' };
    expect((await create(advisor, body)).status).toBe(403);
    expect((await create(agent, body)).status).toBe(403);
    expect((await w.staff(agent, 'GET', '/notification/campaigns')).status).toBe(403);
    expect(
      (
        await w.staff(advisor, 'POST', '/notification/scheduled-sms', {
          templateCode: 'scheduled.staff',
          mobile: '09121234567',
          values: { count: '۱' },
          sendAt: { date: formatJalaliDate(addJalaliDays(tomorrow(), 1)), time: '10:00' },
          reason: 'آزمون',
        })
      ).status,
    ).toBe(403);
    const other = await create(support, {
      filterCode: 'borrowers_active',
      templateCode: 'campaign.patient',
    });
    expect([other.status, other.body['error']]).toEqual([409, 'template_audience_differs']);
    const field = await create(support, {
      filterCode: 'borrowers_active',
      templateCode: 'campaign.borrower_due',
    });
    expect(field.status).toBe(409);
    expect(field.body).toMatchObject({ error: 'template_field_unavailable', fields: ['due_date'] });
    const params = await create(support, {
      filterCode: 'borrowers_overdue_at_least',
      filterParams: {},
      templateCode: 'campaign.overdue',
    });
    expect([params.status, params.body['error']]).toEqual([400, 'invalid_filter_params']);
    // A guarantor's template with the treatment is never saved (6-4).
    const bad = await w.staff(strategy, 'POST', '/notification/sms-templates', {
      code: 'campaign.guarantor_bad',
      audience: 'guarantor',
      category: 'transactional',
      body: '{{name}} {{treatment_field}}',
      reason: 'آزمون',
    });
    expect(bad.status).toBe(422);
    // A draft cancelled; then neither approved nor cancelled again.
    const id = await made(support, body);
    expect(
      (
        await w.staff(support, 'POST', `/notification/campaigns/${id}/cancel`, {
          reason: 'نیازی نیست',
        })
      ).status,
    ).toBe(200);
    expect((await w.staff(strategyB, 'POST', `/notification/campaigns/${id}/approve`)).status).toBe(
      409,
    );
  });
});

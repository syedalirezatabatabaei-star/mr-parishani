import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  SMS_DELIVERY_STATUS,
  type DeliveryState,
} from '../../src/common/notification/notifications.port';
import {
  NOTIFICATION_SMS_SENDER,
  NotificationService,
} from '../../src/modules/notification/notification.service';
import {
  CapturingTextSender,
  startHarness,
  type Harness,
  type loggedInAccount,
} from '../identity/harness';
import { CREDIT_HARNESS, creditWorld, type Body, type Row } from '../credit/world';

/**
 * Task 6-4 (doc 15 §7, §9 tests 6, 9, 10): the notification module's SMS. A template is saved
 * only with the fields its recipient may see; non-urgent SMS wait for the allowed hours
 * (8 to 21 Tehran); promotional ones need consent and stop at a withdrawal, transactional
 * ones do not; each is recorded once and queued once; the provider's delivery is read back.
 */

type Staff = Awaited<ReturnType<typeof loggedInAccount>>;

let h: Harness;
let w: Awaited<ReturnType<typeof creditWorld>>;
let strategy: Staff;
let support: Staff;
let advisor: Staff;
const queue = new CapturingTextSender();
const reports = new Map<string, DeliveryState>();

beforeAll(async () => {
  h = await startHarness({
    ...CREDIT_HARNESS,
    overrides: [
      [NOTIFICATION_SMS_SENDER, queue],
      [SMS_DELIVERY_STATUS, { status: () => Promise.resolve(new Map(reports)) }],
    ],
  });
  w = await creditWorld(h);
  strategy = await w.role('strategy_manager');
  support = await w.role('support');
  advisor = await w.role('advisor');
}, 180_000);

afterAll(async () => {
  await h.close();
});

const sms = () => h.app.get(NotificationService);
const mobile = () => `912${String(Math.floor(Math.random() * 1e7)).padStart(7, '0')}`;

/** 22:00 Tehran on 14 Mehr 1405, and 08:00 the next morning (Tehran is UTC+03:30). */
const NIGHT = new Date('2026-10-06T18:30:00Z');
const MORNING = new Date('2026-10-07T04:30:00Z');
const NOON = new Date('2026-10-07T08:30:00Z');

async function template(code: string, fields: Body) {
  const made = await w.staff(strategy, 'POST', '/notification/sms-templates', {
    code,
    reason: 'قالب آزمون',
    ...fields,
  });
  expect(made.status, JSON.stringify(made.body)).toBe(201);
  return made.body;
}

async function dispatch(id: string) {
  const { rows } = await h.owner.query<Row>(
    `SELECT status, suppressed_reason, send_after, queued_at, segments, provider_message_id
     FROM sms_dispatches WHERE id = $1`,
    [id],
  );
  return rows[0] as Row;
}

describe("the notification module's SMS (task 6-4)", () => {
  it("doc 15 test 6: a guarantor's template never takes the treatment, the doctor or the center", async () => {
    const refused = await w.staff(strategy, 'POST', '/notification/sms-templates', {
      code: 'repayment.guarantor_notice',
      audience: 'guarantor',
      category: 'transactional',
      body: 'قسط {{amount}} وام نزد {{doctor_name}} برای {{treatment_field}}',
      reason: 'قالب ضامن',
    });
    expect(refused.status).toBe(422);
    expect(refused.body).toMatchObject({
      error: 'template_field_not_allowed',
      fields: ['doctor_name', 'treatment_field'],
    });
    // The same fields for the patient are allowed; a second save is the next version.
    const first = await template('booking.patient_notice', {
      audience: 'patient',
      category: 'transactional',
      body: 'نوبت شما نزد {{doctor_name}} در {{center_name}}',
    });
    expect(first).toMatchObject({
      version: 1,
      fields: ['doctor_name', 'center_name'],
      segments: 1,
    });
    const second = await template('booking.patient_notice', {
      audience: 'patient',
      category: 'transactional',
      body: 'یادآوری نوبت نزد {{doctor_name}}',
    });
    expect(second['version']).toBe(2);
    // A code keeps its recipient.
    const other = await w.staff(strategy, 'POST', '/notification/sms-templates', {
      code: 'booking.patient_notice',
      audience: 'guarantor',
      category: 'transactional',
      body: 'یادآوری',
      reason: 'دیگر',
    });
    expect(other.status).toBe(409);
    expect((await w.staff(advisor, 'GET', '/notification/sms-templates')).status).toBe(403);
  });

  it('doc 15 test 9: outside the allowed hours a reminder waits until 8 Tehran; an urgent one goes', async () => {
    await template('repayment.reminder_test', {
      audience: 'borrower',
      category: 'transactional',
      body: 'قسط {{installment_number}} به مبلغ {{amount}} سررسید {{due_date}} است.',
    });
    const to = mobile();
    const sent = await sms().send(
      {
        templateCode: 'repayment.reminder_test',
        audience: 'borrower',
        mobile: to,
        values: { installment_number: '۳', amount: '۱۲٬۰۰۰٬۰۰۰ تومان', due_date: '۲۰ مهر' },
        idempotencyKey: `test:${randomUUID()}`,
      },
      undefined,
      NIGHT,
    );
    expect(sent.status).toBe('scheduled');
    expect((await dispatch(sent.dispatchId))['send_after']).toEqual(MORNING);

    // At night nothing is queued; in the morning it is.
    const before = queue.sent.length;
    await sms().release(NIGHT);
    expect(queue.sent.filter((s) => s.mobile === to)).toHaveLength(0);
    await sms().release(MORNING);
    const queued = queue.sent.slice(before).filter((s) => s.mobile === to);
    expect(queued).toHaveLength(1);
    expect(queued[0]?.text).toBe('قسط ۳ به مبلغ ۱۲٬۰۰۰٬۰۰۰ تومان سررسید ۲۰ مهر است.');
    expect(queued[0]?.jobId).toBe(`sms-dispatch-${sent.dispatchId}`);
    expect((await dispatch(sent.dispatchId))['status']).toBe('pending');
    // Released again before it is sent: not queued twice.
    await sms().release(new Date(MORNING.getTime() + 60_000));
    expect(queue.sent.filter((s) => s.mobile === to)).toHaveLength(1);

    // An urgent one is never held, at night either.
    await template('identity.urgent_test', {
      audience: 'patient',
      category: 'urgent',
      body: 'کد {{case_number}}',
    });
    const urgent = await sms().send(
      {
        templateCode: 'identity.urgent_test',
        audience: 'patient',
        mobile: mobile(),
        values: { case_number: '۱۲۳' },
        idempotencyKey: `test:${randomUUID()}`,
      },
      undefined,
      NIGHT,
    );
    expect(urgent.status).toBe('pending');
    expect((await dispatch(urgent.dispatchId))['send_after']).toEqual(NIGHT);
  });

  it('doc 15 test 10: an unsubscribed mobile gets no promotional SMS, but its installment reminder', async () => {
    await template('lead.campaign_test', {
      audience: 'patient',
      category: 'promotional',
      body: 'تخفیف ویژه برای {{name}}',
    });
    await template('repayment.reminder_ten', {
      audience: 'patient',
      category: 'transactional',
      body: 'یادآوری قسط {{installment_number}}',
    });
    const to = mobile();
    const promo = (key = randomUUID()) =>
      sms().send(
        {
          templateCode: 'lead.campaign_test',
          audience: 'patient',
          mobile: to,
          values: { name: 'سارا' },
          idempotencyKey: `test:${key}`,
        },
        undefined,
        NOON,
      );
    // No consent yet.
    const none = await promo();
    expect(none.status).toBe('suppressed');
    expect((await dispatch(none.dispatchId))['suppressed_reason']).toBe('no_consent');

    const given = await w.staff(support, 'POST', '/notification/sms-consents', {
      mobile: `0${to}`,
      action: 'consent',
      reason: 'رضایت تلفنی',
    });
    expect(given.status).toBe(201);
    expect(given.body['mobileMasked']).toBe(`${to.slice(0, 3)}***${to.slice(-4)}`);
    expect((await promo()).status).toBe('scheduled');

    await w.staff(support, 'POST', '/notification/sms-consents', {
      mobile: to,
      action: 'withdraw',
      reason: 'لغو اشتراک',
    });
    const after = await promo();
    expect(after.status).toBe('suppressed');
    expect((await dispatch(after.dispatchId))['suppressed_reason']).toBe('unsubscribed');
    // The installment reminder still goes.
    const reminder = await sms().send(
      {
        templateCode: 'repayment.reminder_ten',
        audience: 'patient',
        mobile: to,
        values: { installment_number: '۲' },
        idempotencyKey: `test:${randomUUID()}`,
      },
      undefined,
      NOON,
    );
    expect(reminder.status).toBe('scheduled');
    expect(
      (
        await w.staff(advisor, 'POST', '/notification/sms-consents', {
          mobile: to,
          action: 'consent',
          reason: 'بی‌مجوز',
        })
      ).status,
    ).toBe(403);
  });

  it('recorded once, its parts and price; sent, then delivered or failed as the provider reports', async () => {
    await template('repayment.long_test', {
      audience: 'borrower',
      category: 'transactional',
      body: `${'ی'.repeat(80)} {{amount}}`,
    });
    const key = `test:${randomUUID()}`;
    const send = () =>
      sms().send(
        {
          templateCode: 'repayment.long_test',
          audience: 'borrower',
          mobile: mobile(),
          values: { amount: '۱۰' },
          idempotencyKey: key,
        },
        undefined,
        NOON,
      );
    const one = await send();
    expect(await send()).toEqual(one);
    const { rows } = await h.owner.query<Row>(
      'SELECT count(*)::int AS n FROM sms_dispatches WHERE idempotency_key = $1',
      [key],
    );
    expect(rows[0]?.['n']).toBe(1);
    expect((await dispatch(one.dispatchId))['segments']).toBe(2);

    // Not the template's recipient: refused.
    await expect(
      sms().send(
        {
          templateCode: 'repayment.long_test',
          audience: 'guarantor',
          mobile: mobile(),
          values: { amount: '۱۰' },
          idempotencyKey: `test:${randomUUID()}`,
        },
        undefined,
        NOON,
      ),
    ).rejects.toMatchObject({ response: { error: 'template_audience_differs' } });

    await sms().release(NOON);
    const messageId = `kn-${randomUUID()}`;
    await sms().markSent(one.dispatchId, messageId);
    expect(await dispatch(one.dispatchId)).toMatchObject({
      status: 'sent',
      provider_message_id: messageId,
    });
    // Not known yet: still sent.
    await sms().pollDelivery(new Date());
    expect((await dispatch(one.dispatchId))['status']).toBe('sent');
    reports.set(messageId, 'delivered');
    const read = await sms().pollDelivery(new Date());
    expect(read.delivered).toBeGreaterThanOrEqual(1);
    expect((await dispatch(one.dispatchId))['status']).toBe('delivered');
    // Read again: nothing changes.
    await sms().pollDelivery(new Date());
    expect((await dispatch(one.dispatchId))['status']).toBe('delivered');

    // The record shows a masked mobile only.
    const listed = await w.staff(
      support,
      'GET',
      '/notification/sms-dispatches?templateCode=repayment.long_test',
    );
    expect(listed.status).toBe(200);
    const row = (listed.body as unknown as Body[])[0] as Body;
    expect(row['mobileMasked']).toMatch(/^\d{3}\*\*\*\d{4}$/);
    expect(JSON.stringify(listed.body)).not.toMatch(/9\d{9}/);
  });

  it('the database: text and recipient fixed; status only along its paths', async () => {
    const { rows } = await h.owner.query<Row>(
      "SELECT id FROM sms_dispatches WHERE status = 'delivered' LIMIT 1",
    );
    const id = rows[0]?.['id'] as string;
    await expect(
      h.owner.query("UPDATE sms_dispatches SET text = 'دیگر' WHERE id = $1", [id]),
    ).rejects.toThrow(/keeps its text, recipient and moment/);
    await expect(
      h.owner.query("UPDATE sms_dispatches SET status = 'pending' WHERE id = $1", [id]),
    ).rejects.toThrow(/cannot go from delivered to pending/);
    await expect(h.owner.query('DELETE FROM sms_templates')).rejects.toThrow();
  });
});

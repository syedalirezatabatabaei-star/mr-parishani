import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CONFIG } from '../../src/common/config/config.port';
import { CREDIT_CONTRACT_FACTS } from '../../src/common/credit/credit-contract-facts.port';
import { LEAD_CASES } from '../../src/common/lead/lead-cases.port';
import { DATABASE, type Database } from '../../src/db/database.module';
import { InstrumentNotifier } from '../../src/modules/instrument/instrument-notifier';
import { newMobile, startHarness, type Harness, type loggedInAccount } from '../identity/harness';
import { CREDIT_HARNESS, creditWorld, type Body, type Row } from '../credit/world';

/**
 * Task 4-2 (doc 12 §3): a delivery's life, its items and the shortage SMS; cheques and
 * notes with their number encrypted and found by its blind index (the acceptance of doc
 * 13 4-2), never in a log, the audit trail, an event or an SMS; Sayad confirmed before a
 * cheque is checked.
 */

let h: Harness;
let w: Awaited<ReturnType<typeof creditWorld>>;
type Staff = Awaited<ReturnType<typeof loggedInAccount>>;
let manager: Staff;

/** A cheque's Sayad number, as a clerk might type it: Persian digits, spaces and a dash. */
const CHEQUE_TYPED = '۱۲۳۴-۵۶۷۸ ۹۰۱۲ ۳۴۵۶';
const CHEQUE = '1234567890123456';
const NOTE = '778899001122';

const alef = {
  job: 'official',
  employmentStartedOn: { year: 1398, month: 1, day: 1 },
  coverage: 'full',
  obligationsRial: '1000000',
  newInstallmentRial: '4000000',
};
const guarantorRaw = {
  job: 'official',
  employmentStartedOn: { year: 1395, month: 1, day: 1 },
  averageBalanceRial: '30000000',
  installmentRial: '900000',
  debts: 'none_or_very_low',
  independence: 'fully_independent',
};

beforeAll(async () => {
  h = await startHarness(CREDIT_HARNESS);
  // Owner 1405/07/27: promissory notes are off by default (0096); these tests keep the
  // path working for when the flag is turned on.
  await h.owner.query(
    `INSERT INTO config_values (key, scope_level, value, effective_at, status, reason, decided_at)
     VALUES ('instrument.promissory_enabled', 'global', 'true', now(), 'approved', 'آزمون', now())`,
  );
  w = await creditWorld(h);
  manager = await w.role('credit_manager');
}, 180_000);

afterAll(async () => {
  await h.close();
});

/** An application approved with one guarantor. */
async function approved() {
  const { patient, applicationId } = await w.inReview();
  await w.staff(w.creditSpecialist, 'POST', `/credit/applications/${applicationId}/score-sheets`, {
    subject: 'borrower',
    raw: alef,
  });
  const mobile = newMobile();
  await w.as(patient, 'POST', `/me/credit-applications/${applicationId}/guarantors`, {
    mobile: `0${mobile}`,
  });
  const guarantor = await w.patient(mobile);
  await w.consent(guarantor, applicationId, 'guarantor');
  await w.documented(guarantor, applicationId, 'guarantor');
  const scoring = await w.staff(
    w.creditSpecialist,
    'GET',
    `/credit/applications/${applicationId}/scoring`,
  );
  const guarantorId = (scoring.body['guarantors'] as Body[])[0]?.['id'] as string;
  await w.staff(w.creditSpecialist, 'POST', `/credit/applications/${applicationId}/score-sheets`, {
    subject: 'guarantor',
    guarantorId,
    raw: guarantorRaw,
  });
  await w.staff(w.creditSpecialist, 'POST', `/credit/applications/${applicationId}/to-decision`);
  const proposed = await w.staff(
    w.creditSpecialist,
    'POST',
    `/credit/applications/${applicationId}/decisions`,
    {
      outcome: 'approved',
      reason: 'رتبه الف',
    },
  );
  await w.staff(
    manager,
    'POST',
    `/credit/applications/${applicationId}/decisions/${proposed.body['id'] as string}/confirm`,
  );
  return { patient, applicationId, guarantorId };
}

/** Everything the process writes to stdout and stderr while `work` runs. */
async function captured(work: () => Promise<void>): Promise<string> {
  const chunks: string[] = [];
  const out = process.stdout.write.bind(process.stdout);
  const err = process.stderr.write.bind(process.stderr);
  const keep = (chunk: unknown) => {
    chunks.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk as Uint8Array).toString());
    return true;
  };
  process.stdout.write = keep;
  process.stderr.write = keep;
  try {
    await work();
  } finally {
    process.stdout.write = out;
    process.stderr.write = err;
  }
  return chunks.join('');
}

describe('a delivery and its instruments (doc 12 §3)', () => {
  it('is expected, sent, received, checked (incomplete, then verified) and archived', async () => {
    const { patient, applicationId, guarantorId } = await approved();
    const sms: { mobile: string; text: string }[] = [];
    let deliveryId = '';
    let chequeId = '';

    const logs = await captured(async () => {
      expect(
        (
          await w.staff(w.doctor, 'POST', '/deliveries', {
            creditApplicationId: applicationId,
            items: [],
          })
        ).status,
      ).toBe(403);
      const made = await w.staff(w.completion, 'POST', '/deliveries', {
        creditApplicationId: applicationId,
        items: [
          { kind: 'signed_contract', label: 'قرارداد امضاشده' },
          { kind: 'cheque', label: 'چک وام‌گیرنده' },
          { kind: 'promissory_note', label: 'سفته ضامن' },
        ],
      });
      expect(made.status).toBe(201);
      expect(made.body['status']).toBe('awaiting_send');
      deliveryId = made.body['id'] as string;
      const items = made.body['items'] as Body[];
      const item = (kind: string) => items.find((i) => i['kind'] === kind);
      const [contractItem, chequeItem, noteItem] = [
        item('signed_contract'),
        item('cheque'),
        item('promissory_note'),
      ];
      expect(items.map((i) => i['kind'])).toEqual(['signed_contract', 'cheque', 'promissory_note']);

      // The owner says how it was sent; another patient finds nothing.
      const mine = await w.as(patient, 'GET', '/me/deliveries');
      expect((mine.body as unknown as Body[]).map((d) => d['id'])).toContain(deliveryId);
      const stranger = await w.patient();
      expect(
        (await w.as(stranger, 'POST', `/me/deliveries/${deliveryId}/sent`, { method: 'post' }))
          .status,
      ).toBe(404);
      const sent = await w.as(patient, 'POST', `/me/deliveries/${deliveryId}/sent`, {
        method: 'courier',
        trackingCode: 'TRK-1234',
      });
      expect(sent.body['status']).toBe('sent');

      // Received at the office; the contract and the cheque came, the note did not.
      await w.staff(w.completion, 'POST', `/deliveries/${deliveryId}/receive`, {
        method: 'courier',
      });
      await w.staff(
        w.completion,
        'POST',
        `/deliveries/${deliveryId}/items/${contractItem?.['id'] as string}`,
        { status: 'received' },
      );
      await w.staff(
        w.completion,
        'POST',
        `/deliveries/${deliveryId}/items/${chequeItem?.['id'] as string}`,
        { status: 'received' },
      );
      await w.staff(
        w.completion,
        'POST',
        `/deliveries/${deliveryId}/items/${noteItem?.['id'] as string}`,
        { status: 'missing' },
      );
      const cheque = await w.staff(w.completion, 'POST', `/deliveries/${deliveryId}/instruments`, {
        itemId: chequeItem?.['id'],
        kind: 'cheque',
        issuer: { role: 'borrower' },
        amountRial: '9600000',
        bankName: 'بانک ملی',
        number: CHEQUE_TYPED,
      });
      expect(cheque.status).toBe(201);
      expect(cheque.body).toMatchObject({
        numberLast4: '3456',
        status: 'received',
        sayadConfirmed: false,
      });
      chequeId = cheque.body['id'] as string;
      // The same cheque twice is one instrument.
      expect(
        (
          await w.staff(w.completion, 'POST', `/deliveries/${deliveryId}/instruments`, {
            itemId: noteItem?.['id'],
            kind: 'cheque',
            issuer: { role: 'borrower' },
            amountRial: '1000',
            number: CHEQUE,
          })
        ).status,
      ).toBe(400);

      // A cheque is checked only once its issuer registered it in Sayad.
      expect(
        (await w.staff(w.completion, 'POST', `/instruments/${chequeId}/verify`)).body['error'],
      ).toBe('sayad_not_confirmed');
      await w.staff(w.completion, 'POST', `/instruments/${chequeId}/sayad`);
      expect(
        (await w.staff(w.completion, 'POST', `/instruments/${chequeId}/verify`)).body['status'],
      ).toBe('verified');

      // Checked: the note is missing, so incomplete, and the owner is told by SMS.
      const incomplete = await w.staff(w.completion, 'POST', `/deliveries/${deliveryId}/check`);
      expect(incomplete.body['status']).toBe('incomplete');
      const { rows } = await h.owner.query<Row>(
        `SELECT id, payload, created_at FROM outbox_events
          WHERE event_type = 'instrument.delivery_incomplete' AND aggregate_id = $1`,
        [deliveryId],
      );
      const row = rows[0] ?? {};
      await new InstrumentNotifier(
        { register: () => undefined },
        h.app.get(CONFIG),
        h.app.get(CREDIT_CONTRACT_FACTS),
        h.app.get(LEAD_CASES),
        { sendText: (job) => Promise.resolve(void sms.push(job)) },
      ).handle(
        {
          id: (row['id'] as string | undefined) ?? randomUUID(),
          type: 'instrument.delivery_incomplete',
          aggregateType: 'physical_delivery',
          aggregateId: deliveryId,
          payload: row['payload'],
          occurredAt: (row['created_at'] as Date).toISOString(),
        },
        h.app.get<Database>(DATABASE),
      );
      expect(sms).toHaveLength(1);
      expect(sms[0]?.mobile).toBe(patient.mobile);
      expect(sms[0]?.text).toContain('سفته ضامن');

      // The note comes; registered for the guarantor, checked; then verified and archived.
      await w.staff(
        w.completion,
        'POST',
        `/deliveries/${deliveryId}/items/${noteItem?.['id'] as string}`,
        { status: 'received' },
      );
      const note = await w.staff(w.completion, 'POST', `/deliveries/${deliveryId}/instruments`, {
        itemId: noteItem?.['id'],
        kind: 'promissory_note',
        issuer: { role: 'guarantor', guarantorId },
        amountRial: '20000000',
        number: NOTE,
      });
      expect(note.body).toMatchObject({ role: 'guarantor', guarantorId, numberLast4: '1122' });
      expect(
        (await w.staff(w.completion, 'POST', `/instruments/${note.body['id'] as string}/sayad`))
          .body['error'],
      ).toBe('not_a_cheque');
      await w.staff(w.completion, 'POST', `/instruments/${note.body['id'] as string}/verify`);
      expect(
        (await w.staff(w.completion, 'POST', `/deliveries/${deliveryId}/check`)).body['status'],
      ).toBe('verified');
      const archived = await w.staff(w.completion, 'POST', `/deliveries/${deliveryId}/archive`, {
        location: 'قفسه ب-۱۲',
      });
      expect(archived.body).toMatchObject({ status: 'archived', archiveLocation: 'قفسه ب-۱۲' });
      expect((archived.body['instruments'] as Body[]).every((i) => i['status'] === 'held')).toBe(
        true,
      );
    });

    // Doc 13 4-2: found by number through the blind index, typed any way.
    const found = await w.staff(
      w.completion,
      'GET',
      `/instruments?number=${encodeURIComponent('1234 5678-9012-3456')}`,
    );
    expect((found.body as unknown as Body[]).map((i) => i['id'])).toEqual([chequeId]);
    // The column holds no number in clear; the list shows four digits only.
    const { rows: stored } = await h.owner.query<Row>(
      'SELECT number_enc, number_bidx, number_last4 FROM instruments WHERE id = $1',
      [chequeId],
    );
    expect(stored[0]?.['number_enc']).toMatch(/^v1\./);
    expect(stored[0]?.['number_enc']).not.toContain(CHEQUE);
    expect(stored[0]?.['number_bidx']).toMatch(/^v1\./);
    expect(stored[0]?.['number_last4']).toBe('3456');
    const delivery = await w.staff(manager, 'GET', `/deliveries/${deliveryId}`);
    expect(JSON.stringify(delivery.body)).not.toContain(CHEQUE);

    // The full number: only with its permission, and the view is logged.
    expect((await w.staff(manager, 'GET', `/instruments/${chequeId}/number`)).status).toBe(403);
    const full = await w.staff(w.completion, 'GET', `/instruments/${chequeId}/number`);
    expect(full.body['number']).toBe(CHEQUE);
    const { rows: views } = await h.owner.query<Row>(
      `SELECT count(*)::int AS n FROM access_logs WHERE entity_type = 'instrument_number' AND entity_id = $1`,
      [chequeId],
    );
    expect(views[0]?.['n']).toBe(1);

    // Never in a log, the audit trail, an event or an SMS (rules 27 and 30).
    for (const number of [CHEQUE, NOTE]) {
      expect(logs).not.toContain(number);
      expect(sms.map((s) => s.text).join('\n')).not.toContain(number);
    }
    const { rows: audit } = await h.owner.query<Row>(
      'SELECT before::text AS b, after::text AS a, reason FROM audit_events',
    );
    const { rows: events } = await h.owner.query<Row>(
      'SELECT payload::text AS p FROM outbox_events',
    );
    const everywhere = JSON.stringify([audit, events]);
    expect(everywhere).not.toContain(CHEQUE);
    expect(everywhere).not.toContain(NOTE);
  });

  it('is only for an approved application, and only staff with the permission see it', async () => {
    const { applicationId } = await w.inReview();
    const early = await w.staff(w.completion, 'POST', '/deliveries', {
      creditApplicationId: applicationId,
      items: [{ kind: 'signed_contract', label: 'قرارداد امضاشده' }],
    });
    expect(early.body['error']).toBe('not_approved');
    expect(
      (await w.staff(w.doctor, 'GET', `/deliveries?creditApplicationId=${applicationId}`)).status,
    ).toBe(403);
    expect((await w.as({ ...(await w.patient()) }, 'GET', '/me/deliveries')).body).toEqual([]);
  });
});

describe('promissory notes off (owner 1405/07/27, plan e; 0096)', () => {
  it('no delivery item and no instrument of that kind; the form is told; cheques as ever', async () => {
    const { applicationId } = await approved();
    const flag = (on: boolean) =>
      h.owner.query(
        `INSERT INTO config_values (key, scope_level, value, effective_at, status, reason, decided_at)
         VALUES ('instrument.promissory_enabled', 'global', $1::jsonb, now(), 'approved', 'آزمون', now())`,
        [JSON.stringify(on)],
      );
    // Migration 0096's value: off.
    const { rows: seeded } = await h.owner.query<Row>(
      `SELECT value FROM config_values WHERE key = 'instrument.promissory_enabled' AND reason LIKE '%0096%'`,
    );
    expect(seeded).toEqual([{ value: false }]);
    await flag(false);
    try {
      expect((await w.staff(w.completion, 'GET', '/deliveries/options')).body).toEqual({
        promissoryNotesEnabled: false,
      });
      const refused = await w.staff(w.completion, 'POST', '/deliveries', {
        creditApplicationId: applicationId,
        items: [
          { kind: 'cheque', label: 'چک وام‌گیرنده' },
          { kind: 'promissory_note', label: 'سفته ضامن' },
        ],
      });
      expect(refused.status).toBe(409);
      expect(refused.body['error']).toBe('promissory_disabled');
      expect(
        (
          await h.owner.query<Row>(
            'SELECT count(*)::int AS n FROM physical_deliveries WHERE credit_application_id = $1',
            [applicationId],
          )
        ).rows[0]?.['n'],
      ).toBe(0);
      const cheques = await w.staff(w.completion, 'POST', '/deliveries', {
        creditApplicationId: applicationId,
        items: [{ kind: 'cheque', label: 'چک وام‌گیرنده' }],
      });
      expect(cheques.status).toBe(201);
      const items = cheques.body['items'] as Body[];
      // An instrument of that kind is refused too, before anything is looked at.
      const note = await w.staff(
        w.completion,
        'POST',
        `/deliveries/${cheques.body['id'] as string}/instruments`,
        {
          itemId: items[0]?.['id'],
          kind: 'promissory_note',
          issuer: { role: 'borrower' },
          amountRial: '20000000',
          number: NOTE,
        },
      );
      expect(note.status).toBe(409);
      expect(note.body['error']).toBe('promissory_disabled');
    } finally {
      await flag(true);
    }
  });
});

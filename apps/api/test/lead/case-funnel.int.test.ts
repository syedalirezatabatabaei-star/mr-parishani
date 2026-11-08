import { randomUUID } from 'node:crypto';
import type { EventEnvelope } from '@sepehr/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ACCESS_PORT, type AccessPort } from '../../src/common/auth/access.port';
import { OUTBOX, type OutboxPort } from '../../src/common/events/outbox.port';
import { DATABASE, type Database } from '../../src/db/database.module';
import { EventDispatcher } from '../../src/infra/outbox/event-dispatcher';
import { CaseFunnelConsumer } from '../../src/modules/lead/case-funnel.consumer';
import { FunnelEventEarly } from '../../src/modules/lead/case.service';
import { ReportService } from '../../src/modules/reporting/report.service';
import { startHarness, type Harness, type LoggedInAccount } from '../identity/harness';
import { CREDIT_HARNESS, creditWorld, type Body, type Row } from '../credit/world';

/**
 * The case funnel (owner 1405/07/23, question 8; docs/decisions/q8-case-funnel-financial-plan.md):
 * an appointment confirmed, examined, a proforma issued bring the case to appointment_booked,
 * examined, proforma_issued, one step at a time through CaseService, once per event, never
 * backwards, never skipping a step; closed cases and appointments without a case are left
 * alone; the database guard still takes one step at a time.
 */

type World = Awaited<ReturnType<typeof creditWorld>>;
type FunnelType =
  'booking.appointment_confirmed' | 'booking.appointment_examined' | 'proforma.issued';

const CHAIN = [
  'new',
  'advising',
  'appointment_booked',
  'examined',
  'proforma_issued',
  'credit_requested',
] as const;
type Stage = (typeof CHAIN)[number];

let h: Harness;
let w: World;
let ceo: LoggedInAccount;

beforeAll(async () => {
  h = await startHarness(CREDIT_HARNESS);
  w = await creditWorld(h);
  ceo = await w.role('ceo');
}, 180_000);

afterAll(async () => {
  await h.close();
});

/** A case walked along the chain, one allowed step at a time, to the stage asked for. */
async function caseAt(stage: Stage | 'cancelled' | 'completed'): Promise<string> {
  const person = (await h.owner.query<Row>('INSERT INTO persons DEFAULT VALUES RETURNING id'))
    .rows[0]?.['id'] as string;
  const id = (
    await h.owner.query<Row>(
      `INSERT INTO cases (person_id, queue_code, treatment_field_code, channel)
       VALUES ($1, 'new_customers', 'dental', 'app') RETURNING id`,
      [person],
    )
  ).rows[0]?.['id'] as string;
  const to = stage === 'cancelled' ? 'new' : stage === 'completed' ? 'advising' : stage;
  for (const next of CHAIN.slice(1, CHAIN.indexOf(to) + 1)) {
    await h.owner.query('UPDATE cases SET status = $2 WHERE id = $1', [id, next]);
  }
  if (stage === 'cancelled' || stage === 'completed') {
    await h.owner.query(
      `UPDATE cases SET status = $2, closed_at = now(),
         abandonment_reason_code = CASE WHEN $2 = 'cancelled' THEN 'other' END
       WHERE id = $1`,
      [id, stage],
    );
  }
  return id;
}

const statusOf = async (id: string) =>
  (await h.owner.query<Row>('SELECT status FROM cases WHERE id = $1', [id])).rows[0]?.['status'];

/** The funnel's steps of a case, in order. */
const funnelSteps = async (id: string) =>
  (
    await h.owner.query<Row>(
      `SELECT from_status, to_status, reason_code, note, actor_account_id FROM case_status_changes
       WHERE case_id = $1 AND reason_code = 'funnel_event' ORDER BY created_at, id`,
      [id],
    )
  ).rows;

/** An event published through the outbox (its payload checked by its schema), as delivered. */
async function publish(type: FunnelType, caseId: string | null): Promise<EventEnvelope> {
  const outbox = h.app.get<OutboxPort>(OUTBOX, { strict: false });
  const db = h.app.get<Database>(DATABASE);
  const payload =
    type === 'proforma.issued'
      ? {
          proformaId: randomUUID(),
          caseId,
          doctorId: randomUUID(),
          workplaceId: randomUUID(),
          version: 1,
          totalRial: '6000000',
        }
      : {
          appointmentId: randomUUID(),
          workplaceId: randomUUID(),
          doctorId: randomUUID(),
          caseId,
        };
  const aggregateId =
    (payload as { proformaId?: string; appointmentId?: string }).proformaId ??
    (payload as { appointmentId: string }).appointmentId;
  const id = await outbox.publish(
    {
      type,
      aggregateType: type === 'proforma.issued' ? 'proforma' : 'appointment',
      aggregateId,
      payload,
    },
    db,
  );
  return envelopeOf(id);
}

async function envelopeOf(id: string): Promise<EventEnvelope> {
  const { rows } = await h.owner.query<Row>(
    `SELECT id, event_type, aggregate_type, aggregate_id, payload, created_at FROM outbox_events
     WHERE id = $1`,
    [id],
  );
  const row = rows[0];
  expect(row).toBeDefined();
  return {
    id: row?.['id'] as string,
    type: row?.['event_type'] as string,
    aggregateType: row?.['aggregate_type'] as string,
    aggregateId: row?.['aggregate_id'] as string,
    payload: row?.['payload'],
    occurredAt: new Date(row?.['created_at'] as string).toISOString(),
  };
}

const deliver = (event: EventEnvelope) => h.app.get(EventDispatcher).dispatch(event);

const claimed = async (event: EventEnvelope) =>
  (
    await h.owner.query<Row>(
      `SELECT count(*)::int AS n FROM processed_events
       WHERE event_id = $1 AND consumer = 'lead.case_funnel'`,
      [event.id],
    )
  ).rows[0]?.['n'];

describe('the case funnel (owner 1405/07/23)', () => {
  it('listens to the three events only: a cancelled or moved appointment never takes a case back', () => {
    expect([...h.app.get(CaseFunnelConsumer).eventTypes].sort()).toEqual([
      'booking.appointment_confirmed',
      'booking.appointment_examined',
      'proforma.issued',
    ]);
  });

  it('1. a confirmed appointment: new -> advising -> appointment_booked, two steps, by the system', async () => {
    const id = await caseAt('new');
    const event = await publish('booking.appointment_confirmed', id);
    expect(await deliver(event)).toEqual(['lead.case_funnel']);
    expect(await statusOf(id)).toBe('appointment_booked');
    expect(await funnelSteps(id)).toEqual([
      {
        from_status: 'new',
        to_status: 'advising',
        reason_code: 'funnel_event',
        note: event.id,
        actor_account_id: null,
      },
      {
        from_status: 'advising',
        to_status: 'appointment_booked',
        reason_code: 'funnel_event',
        note: event.id,
        actor_account_id: null,
      },
    ]);
    const { rows: audit } = await h.owner.query<Row>(
      `SELECT before, after, actor_account_id, actor_roles FROM audit_events
       WHERE entity_id = $1 AND action = 'lead.case_status_changed' ORDER BY seq`,
      [id],
    );
    expect(audit).toEqual([
      {
        before: { status: 'new' },
        after: { status: 'advising', reasonCode: 'funnel_event' },
        actor_account_id: null,
        actor_roles: ['lead.case_funnel'],
      },
      {
        before: { status: 'advising' },
        after: { status: 'appointment_booked', reasonCode: 'funnel_event' },
        actor_account_id: null,
        actor_roles: ['lead.case_funnel'],
      },
    ]);
  });

  it('2. examined, then a proforma issued: examined, then proforma_issued, one step each', async () => {
    const id = await caseAt('advising');
    await deliver(await publish('booking.appointment_confirmed', id));
    await deliver(await publish('booking.appointment_examined', id));
    expect(await statusOf(id)).toBe('examined');
    await deliver(await publish('proforma.issued', id));
    expect(await statusOf(id)).toBe('proforma_issued');
    expect(
      (await funnelSteps(id)).map((s) => `${String(s['from_status'])}>${String(s['to_status'])}`),
    ).toEqual([
      'advising>appointment_booked',
      'appointment_booked>examined',
      'examined>proforma_issued',
    ]);
  });

  it('3. a repeated event takes effect once; one out of order waits, skips nothing, and is retried', async () => {
    const id = await caseAt('advising');
    const confirmed = await publish('booking.appointment_confirmed', id);
    expect(await deliver(confirmed)).toEqual(['lead.case_funnel']);
    expect(await deliver(confirmed)).toEqual([]);
    expect(await funnelSteps(id)).toHaveLength(1);

    // An examination before the confirmation reached the case: refused, not claimed, unmoved.
    const other = await caseAt('advising');
    const examined = await publish('booking.appointment_examined', other);
    await expect(deliver(examined)).rejects.toBeInstanceOf(FunnelEventEarly);
    expect(await claimed(examined)).toBe(0);
    expect(await statusOf(other)).toBe('advising');
    expect(await funnelSteps(other)).toEqual([]);
    // Likewise a proforma before the examination, from new.
    const fresh = await caseAt('new');
    const issued = await publish('proforma.issued', fresh);
    await expect(deliver(issued)).rejects.toBeInstanceOf(FunnelEventEarly);
    expect(await statusOf(fresh)).toBe('new');

    // The confirmation arrives; the retried examination now takes its one step.
    await deliver(await publish('booking.appointment_confirmed', other));
    expect(await deliver(examined)).toEqual(['lead.case_funnel']);
    expect(await claimed(examined)).toBe(1);
    expect(await statusOf(other)).toBe('examined');
  });

  it('4. a closed case, or one at the stage or past it, is left as it is (never backwards)', async () => {
    for (const [stage, type] of [
      ['cancelled', 'booking.appointment_confirmed'],
      ['completed', 'proforma.issued'],
      ['examined', 'booking.appointment_confirmed'],
      ['examined', 'booking.appointment_examined'],
      ['credit_requested', 'proforma.issued'],
    ] as const) {
      const id = await caseAt(stage);
      expect(await deliver(await publish(type, id)), `${stage} ${type}`).toEqual([
        'lead.case_funnel',
      ]);
      expect(await statusOf(id), `${stage} ${type}`).toBe(stage);
      expect(await funnelSteps(id)).toEqual([]);
    }
  });

  it('5. the guard is unchanged: a jump of two steps is still refused', async () => {
    const id = await caseAt('advising');
    await expect(
      h.owner.query("UPDATE cases SET status = 'examined' WHERE id = $1", [id]),
    ).rejects.toThrow(/cannot move from advising to examined/);
    expect(await statusOf(id)).toBe('advising');
  });

  it('6. an appointment without a case: nothing moves', async () => {
    const before = await h.owner.query<Row>(
      "SELECT count(*)::int AS n FROM case_status_changes WHERE reason_code = 'funnel_event'",
    );
    const event = await publish('booking.appointment_confirmed', null);
    expect(await deliver(event)).toEqual(['lead.case_funnel']);
    const after = await h.owner.query<Row>(
      "SELECT count(*)::int AS n FROM case_status_changes WHERE reason_code = 'funnel_event'",
    );
    expect(after.rows[0]?.['n']).toBe(before.rows[0]?.['n']);
  });

  it('6b. the real events of a visit: confirmed, examined, the proforma issued bring its case to proforma_issued', async () => {
    const { proformaId } = await w.confirmedProforma();
    const { rows: issued } = await h.owner.query<Row>(
      `SELECT id, payload->>'caseId' AS case_id FROM outbox_events
       WHERE event_type = 'proforma.issued' AND aggregate_id = $1`,
      [proformaId],
    );
    const caseId = issued[0]?.['case_id'] as string;
    expect(caseId).toMatch(/^[0-9a-f-]{36}$/);
    // The appointment's own events, published by booking as the center confirmed and examined it.
    const { rows: visit } = await h.owner.query<Row>(
      `SELECT id FROM outbox_events
       WHERE event_type IN ('booking.appointment_confirmed', 'booking.appointment_examined')
         AND payload->>'caseId' = $1
       ORDER BY created_at, id`,
      [caseId],
    );
    expect(visit).toHaveLength(2);
    // Delivered last first: each waits for the one before it, and nothing is skipped.
    const proforma = await envelopeOf(issued[0]?.['id'] as string);
    const events = [
      ...(await Promise.all(visit.map((r) => envelopeOf(r['id'] as string)))),
      proforma,
    ];
    await expect(deliver(proforma)).rejects.toBeInstanceOf(FunnelEventEarly);
    for (const event of events) await deliver(event);
    expect(await statusOf(caseId)).toBe('proforma_issued');
    expect((await funnelSteps(caseId)).map((s) => s['to_status'])).toEqual([
      'advising',
      'appointment_booked',
      'examined',
      'proforma_issued',
    ]);
  });

  it('7. the sales funnel report counts the stages the events brought cases to', async () => {
    const reports = h.app.get(ReportService);
    const access = await h.app.get<AccessPort>(ACCESS_PORT).resolve(ceo.id);
    const reached = async () => {
      await reports.refreshViews();
      const r = await reports.run(access, 'sales_funnel', { range: { relative: 'today' } });
      return Object.fromEntries(
        (r.rows as Body[]).map((x) => [x['stage'] as string, x['reached'] as number]),
      );
    };
    const before = await reached();
    const id = await caseAt('new');
    await deliver(await publish('booking.appointment_confirmed', id));
    await deliver(await publish('booking.appointment_examined', id));
    await deliver(await publish('proforma.issued', id));
    expect(await statusOf(id)).toBe('proforma_issued');
    const after = await reached();
    for (const stage of ['مشاوره', 'نوبت گرفته', 'معاینه‌شده', 'پیش‌فاکتور صادرشده']) {
      expect((after[stage] ?? 0) - (before[stage] ?? 0), stage).toBe(1);
    }
    expect((after['درخواست اعتبار'] ?? 0) - (before['درخواست اعتبار'] ?? 0)).toBe(0);
  });
});

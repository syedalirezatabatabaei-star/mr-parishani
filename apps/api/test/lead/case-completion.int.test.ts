import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { EffectiveAccess } from '../../src/common/auth/access.port';
import { CLI_ACTOR } from '../../src/common/auth/actor';
import { LEAD_CASES, type LeadCases } from '../../src/common/lead/lead-cases.port';
import { DATABASE, type Database } from '../../src/db/database.module';
import { CaseService } from '../../src/modules/lead/case.service';
import { startHarness, type Harness } from '../identity/harness';

/**
 * The cases guard narrowed (owner 1405/07/15, migration 0057), then widened (owner 1405/07/23,
 * option A, migration 0086): a settled case goes to completed from a settleable stage, advising
 * to proforma_issued, the stages the funnel brings it to, and in_treatment by the chain; a jump
 * from any other stage (new, credit_requested, contracted, funded) is refused by the database
 * itself.
 */

type Row = Record<string, unknown>;

const CHAIN = [
  'new',
  'advising',
  'appointment_booked',
  'examined',
  'proforma_issued',
  'credit_requested',
  'credit_decided',
  'contracted',
  'funded',
  'in_treatment',
] as const;
type Stage = (typeof CHAIN)[number];

let h: Harness;
let leads: LeadCases;
let db: Database;

beforeAll(async () => {
  h = await startHarness();
  leads = h.app.get<LeadCases>(LEAD_CASES, { strict: false });
  db = h.app.get<Database>(DATABASE);
});

afterAll(async () => {
  await h.close();
});

/** A case walked along the chain, one allowed step at a time, to the stage asked for. */
async function caseAt(stage: Stage): Promise<string> {
  const person = (await h.owner.query<Row>('INSERT INTO persons DEFAULT VALUES RETURNING id'))
    .rows[0]?.['id'] as string;
  const id = (
    await h.owner.query<Row>(
      `INSERT INTO cases (person_id, queue_code, treatment_field_code, channel)
       VALUES ($1, 'new_customers', 'dental', 'app') RETURNING id`,
      [person],
    )
  ).rows[0]?.['id'] as string;
  for (const next of CHAIN.slice(1, CHAIN.indexOf(stage) + 1)) {
    await h.owner.query('UPDATE cases SET status = $2 WHERE id = $1', [id, next]);
  }
  return id;
}

const complete = (id: string) =>
  h.owner.query("UPDATE cases SET status = 'completed', closed_at = now() WHERE id = $1", [id]);

const statusOf = async (id: string) =>
  (await h.owner.query<Row>('SELECT status FROM cases WHERE id = $1', [id])).rows[0]?.['status'];

describe('the cases guard: completed from a settleable stage (migrations 0057, 0086)', () => {
  it.each(['new', 'credit_requested', 'credit_decided', 'contracted', 'funded'] as const)(
    'a jump from %s to completed is refused',
    async (stage) => {
      const id = await caseAt(stage);
      await expect(complete(id)).rejects.toThrow(/cannot move from/);
      expect(await statusOf(id)).toBe(stage);
    },
  );

  it('advising -> completed (a settled case), and in_treatment -> completed (the chain)', async () => {
    const advising = await caseAt('advising');
    await complete(advising);
    expect(await statusOf(advising)).toBe('completed');
    const treated = await caseAt('in_treatment');
    await complete(treated);
    expect(await statusOf(treated)).toBe('completed');
  });

  it.each(['appointment_booked', 'examined', 'proforma_issued'] as const)(
    '%s -> completed (a settled case the funnel brought there; owner 1405/07/23)',
    async (stage) => {
      const id = await caseAt(stage);
      await complete(id);
      expect(await statusOf(id)).toBe('completed');
      const viaPort = await caseAt(stage);
      expect(await db.transaction((tx) => leads.completeCase(tx, CLI_ACTOR, viaPort))).toBe(true);
      expect(await statusOf(viaPort)).toBe('completed');
      const { rows: alerts } = await h.owner.query<Row>(
        'SELECT count(*)::int AS n FROM case_completion_alerts WHERE case_id = $1',
        [viaPort],
      );
      expect(alerts[0]?.['n']).toBe(0);
    },
  );

  it('completeCase from credit_requested: left to staff with an alert, as from new', async () => {
    const id = await caseAt('credit_requested');
    expect(await db.transaction((tx) => leads.completeCase(tx, CLI_ACTOR, id))).toBe(false);
    expect(await statusOf(id)).toBe('credit_requested');
    const { rows: alerts } = await h.owner.query<Row>(
      'SELECT status_at_settlement FROM case_completion_alerts WHERE case_id = $1',
      [id],
    );
    expect(alerts).toEqual([{ status_at_settlement: 'credit_requested' }]);
  });

  it('staff complete an alerted case the funnel then brought to proforma_issued; not one at credit_requested', async () => {
    const service = h.app.get(CaseService);
    const access = {
      accountId: randomUUID(),
      roles: ['test'],
      permissions: new Set(['lead.read_cases', 'lead.update_cases'] as const),
      scopes: [{ kind: 'global' as const }],
    } as unknown as EffectiveAccess;
    // Alerted at new (settled there), then moved along by the funnel.
    const id = await caseAt('new');
    expect(await db.transaction((tx) => leads.completeCase(tx, CLI_ACTOR, id))).toBe(false);
    for (const next of CHAIN.slice(1, CHAIN.indexOf('proforma_issued') + 1)) {
      await h.owner.query('UPDATE cases SET status = $2 WHERE id = $1', [id, next]);
    }
    expect((await service.completeSettled(CLI_ACTOR, access, id)).status).toBe('completed');

    const late = await caseAt('new');
    expect(await db.transaction((tx) => leads.completeCase(tx, CLI_ACTOR, late))).toBe(false);
    for (const next of CHAIN.slice(1, CHAIN.indexOf('credit_requested') + 1)) {
      await h.owner.query('UPDATE cases SET status = $2 WHERE id = $1', [late, next]);
    }
    await expect(service.completeSettled(CLI_ACTOR, access, late)).rejects.toMatchObject({
      response: { error: 'case_not_ready', status: 'credit_requested' },
    });
    expect(await statusOf(late)).toBe('credit_requested');
  });

  it('completeCase from new: never passed on (owner 1405/07/15); left to staff with one alert', async () => {
    const fresh = await caseAt('new');
    expect(await db.transaction((tx) => leads.completeCase(tx, CLI_ACTOR, fresh))).toBe(false);
    // Again (a second schedule settled, a replay): still one alert, still new.
    expect(await db.transaction((tx) => leads.completeCase(tx, CLI_ACTOR, fresh))).toBe(false);
    expect(await statusOf(fresh)).toBe('new');
    const { rows: changes } = await h.owner.query<Row>(
      'SELECT count(*)::int AS n FROM case_status_changes WHERE case_id = $1 AND from_status IS NOT NULL',
      [fresh],
    );
    expect(changes[0]?.['n']).toBe(0);
    const { rows: alerts } = await h.owner.query<Row>(
      'SELECT status_at_settlement FROM case_completion_alerts WHERE case_id = $1',
      [fresh],
    );
    expect(alerts).toEqual([{ status_at_settlement: 'new' }]);
    const { rows: audit } = await h.owner.query<Row>(
      `SELECT count(*)::int AS n FROM audit_events
       WHERE entity_id = $1 AND action = 'lead.case_completion_pending'`,
      [fresh],
    );
    expect(audit[0]?.['n']).toBe(1);

    const contracted = await caseAt('contracted');
    expect(await db.transaction((tx) => leads.completeCase(tx, CLI_ACTOR, contracted))).toBe(false);
    expect(await statusOf(contracted)).toBe('contracted');

    const advising = await caseAt('advising');
    expect(await db.transaction((tx) => leads.completeCase(tx, CLI_ACTOR, advising))).toBe(true);
    expect(await statusOf(advising)).toBe('completed');
  });
});

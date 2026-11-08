import { randomUUID } from 'node:crypto';
import type { INestApplicationContext } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import {
  addJalaliMonths,
  fromJalali,
  gregorianDayOf,
  payableDue,
  providerContractEndsOn,
  toJalali,
} from '@sepehr/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ACCESS_PORT, type AccessPort } from '../../src/common/auth/access.port';
import { LedgerReconciliation } from '../../src/modules/ledger/reconciliation';
import { CashServiceService, cashFeeKey } from '../../src/modules/settlement/cash-service.service';
import { CLI_ACTOR } from '../../src/common/auth/actor';
import { PersonService } from '../../src/modules/lead/person.service';
import { SettlementReconciliation } from '../../src/modules/settlement/settlement-reconciliation';
import { SettlementService } from '../../src/modules/settlement/settlement.service';
import { WorkerModule } from '../../src/worker.module';
import { ProviderContractCheck } from '../../src/modules/config/provider-contract-check';
import { startHarness, type Harness, type loggedInAccount } from '../identity/harness';
import { CREDIT_HARNESS, creditWorld, type Body, type Row } from '../credit/world';

/**
 * Task 5-3 [financial] (doc 06 §4; doc 14 ت; client answers 1405/07/10 §3; ADR-037): a cash
 * service needs a referral to this very doctor, at any time after it; the doctor's side
 * declares it (confirmed at once), an advisor records it (confirmed by someone else). Only a
 * confirmed one gets its fee: its own cash rate and the cycle, locked on the service's day.
 */

type Staff = Awaited<ReturnType<typeof loggedInAccount>>;

let h: Harness;
let w: Awaited<ReturnType<typeof creditWorld>>;
let finance: Staff;
let finance2: Staff;
let advisor: Staff;
let otherAdvisor: Staff;
let strategy: Staff;
let worker: INestApplicationContext | undefined;

beforeAll(async () => {
  h = await startHarness(CREDIT_HARNESS);
  w = await creditWorld(h);
  finance = await w.role('accounting');
  finance2 = await w.role('accounting');
  advisor = await w.role('advisor');
  otherAdvisor = await w.role('advisor');
  strategy = await w.role('strategy_manager');
  worker = await NestFactory.createApplicationContext(WorkerModule.forRoot({ relayLoop: false }), {
    logger: false,
  });
}, 180_000);

afterAll(async () => {
  await worker?.close();
  await h.close();
});

const today = () => gregorianDayOf(toJalali(new Date()));

async function setRate(key: string, value: unknown, level = 'global', ref: string | null = null) {
  await h.owner.query(
    `INSERT INTO config_values (key, scope_level, scope_ref, value, effective_at, status, reason, decided_at)
     VALUES ($1, $2, $3, $4, now(), 'approved', 'آزمون', now())`,
    [key, level, ref, JSON.stringify(value)],
  );
}

/** A patient referred to the world's doctor (booked through Sepehr), and that referral. */
async function referred() {
  const { patient } = await w.inReview();
  const { rows } = await h.owner.query<Row>(
    `SELECT r.id FROM referrals r JOIN user_accounts a ON a.person_id = r.person_id
     WHERE a.id = $1 ORDER BY r.referred_at DESC LIMIT 1`,
    [patient.id],
  );
  return rows[0]?.['id'] as string;
}

/**
 * R18 (owner 1405/07/18): an advisor works its own cases only, so the referral's case is
 * assigned to it by hand (with a reason, as a strategy manager does) before it records.
 */
async function assignTo(who: Staff, referralId: string) {
  const { rows } = await h.owner.query<Row>('SELECT case_id FROM referrals WHERE id = $1', [
    referralId,
  ]);
  const caseId = rows[0]?.['case_id'] as string;
  const moved = await w.staff(strategy, 'POST', `/lead/cases/${caseId}/assignments`, {
    accountId: who.id,
    reason: 'مشاور این پرونده',
  });
  expect(moved.status, JSON.stringify(moved.body)).toBe(201);
}

const list = async (who: Staff) =>
  ((await w.staff(who, 'GET', '/settlement/cash-services')).body as unknown as Body[]).map(
    (c) => c['id'],
  );

const record = (who: Staff, referralId: string, fields: Body = {}) =>
  w.staff(who, 'POST', '/settlement/cash-services', {
    referralId,
    serviceDate: today(),
    amountRial: '4000000',
    idempotencyKey: `cash-${randomUUID()}`,
    ...fields,
  });
const decide = (who: Staff, id: string, outcome: 'confirm' | 'void') =>
  w.staff(who, 'POST', `/settlement/cash-services/${id}/decide`, { outcome, reason: 'بررسی شد' });

async function sound() {
  const { rows } = await h.owner.query<Row>(
    `SELECT journal_entry_id FROM ledger_entries GROUP BY journal_entry_id
     HAVING sum(CASE direction WHEN 'debit' THEN amount_rial ELSE -amount_rial END) <> 0`,
  );
  expect(rows).toEqual([]);
  const ctx = worker as INestApplicationContext;
  expect(await ctx.get(LedgerReconciliation).run()).toMatchObject({ clean: true });
  expect(await ctx.get(SettlementReconciliation).run()).toMatchObject({ clean: true });
}

describe('cash services and their fee (task 5-3)', () => {
  it('declared by the doctor: confirmed at once, its fee at 0 (no document), due a cycle later', async () => {
    const referralId = await referred();
    const made = await record(w.doctor, referralId);
    expect(made.status).toBe(201);
    expect(made.body).toMatchObject({ source: 'doctor_declared', status: 'confirmed' });
    const fee = made.body['fee'] as Body;
    expect(fee).toMatchObject({ amountRial: '0', basis: 'percent', rateValue: '0' });
    const { rows } = await h.owner.query<Row>(
      'SELECT journal_entry_id, due_at FROM service_fees WHERE id = $1',
      [fee['id']],
    );
    expect(rows[0]?.['journal_entry_id']).toBeNull();
    expect(rows[0]?.['due_at']).toEqual(payableDue(new Date(`${today()}T00:00:00+03:30`), 1).dueAt);
    await sound();
  });

  it('only with a referral to this very doctor; never a negative or future one', async () => {
    const referralId = await referred();
    const other = await creditWorld(h);
    const elsewhere = await record(finance, referralId, { workplaceId: other.workplaceId });
    expect(elsewhere.status).toBe(409);
    expect(elsewhere.body['error']).toBe('no_referral_to_this_doctor');
    expect((await record(finance, randomUUID())).status).toBe(404);
    expect((await record(finance, referralId, { amountRial: '-1' })).status).toBe(400);
    const tomorrow = gregorianDayOf(addJalaliMonths(toJalali(new Date()), 1));
    expect((await record(finance, referralId, { serviceDate: tomorrow })).status).toBe(422);
  });

  it('recorded by an advisor: no fee until someone else confirms it; its own cash rate, not the credit one', async () => {
    await setRate('settlement.cash_service_fee', { basis: 'percent', bps: 1500 });
    await setRate('settlement.credit_service_fee', { basis: 'percent', bps: 300 });
    try {
      const referralId = await referred();
      await assignTo(advisor, referralId);
      const made = await record(advisor, referralId);
      expect(made.body).toMatchObject({
        source: 'advisor_recorded',
        status: 'recorded',
        fee: null,
      });
      const id = made.body['id'] as string;
      // The recorder never confirms it; the doctor's side or accounting does.
      expect((await decide(advisor, id, 'confirm')).status).toBe(403);
      const recordedByFinance = await record(finance, referralId);
      expect(
        (await decide(finance, recordedByFinance.body['id'] as string, 'confirm')).body['error'],
      ).toBe('same_person');
      const done = await decide(finance2, id, 'confirm');
      expect(done.body['status']).toBe('confirmed');
      // 15% of 4,000,000, the cash rate (not the credit one's 3%).
      expect(done.body['fee']).toMatchObject({ amountRial: '600000', rateValue: '1500' });
      // Confirmed twice at once: one fee, one document.
      const second = await record(advisor, referralId);
      const sid = second.body['id'] as string;
      await Promise.all([decide(finance, sid, 'confirm'), decide(finance2, sid, 'confirm')]);
      const { rows } = await h.owner.query<Row>(
        `SELECT (SELECT count(*)::int FROM service_fees WHERE cash_service_id = $1) AS fees,
                (SELECT count(*)::int FROM journal_entries WHERE idempotency_key = $2) AS docs`,
        [sid, cashFeeKey(sid)],
      );
      expect(rows[0]).toEqual({ fees: 1, docs: 1 });
      // A fixed amount at the doctor's level.
      const { rows: nodes } = await h.owner.query<Row>(
        'SELECT doctor_node_id FROM cash_services WHERE id = $1',
        [id],
      );
      await setRate(
        'settlement.cash_service_fee',
        { basis: 'fixed', rial: '250000' },
        'doctor',
        nodes[0]?.['doctor_node_id'] as string,
      );
      const fixed = await record(w.doctor, referralId);
      expect(fixed.body['fee']).toMatchObject({ amountRial: '250000', basis: 'fixed' });
      await setRate(
        'settlement.cash_service_fee',
        null,
        'doctor',
        nodes[0]?.['doctor_node_id'] as string,
      );
      await sound();
    } finally {
      await setRate('settlement.cash_service_fee', { basis: 'percent', bps: 0 });
      await setRate('settlement.credit_service_fee', { basis: 'percent', bps: 0 });
    }
  });

  it('no window: a cash service years after its referral is taken; due a cycle after its own day', async () => {
    await setRate('settlement.contract_cycle_months', 3);
    try {
      const referralId = await referred();
      const later = fromJalali(addJalaliMonths(toJalali(new Date()), 36), { hour: 10 });
      const day = gregorianDayOf(toJalali(later));
      const access = await h.app.get<AccessPort>(ACCESS_PORT).resolve(finance.id);
      const made = await h.app.get(CashServiceService).record(
        { accountId: finance.id, sessionId: null, ip: null, roles: ['accounting'] },
        access,
        {
          referralId,
          serviceDate: day,
          amountRial: '3000000',
          idempotencyKey: `cash-${randomUUID()}`,
        },
        later,
      );
      expect(made.status).toBe('recorded');
      const done = await decide(finance2, made.id, 'confirm');
      expect(new Date((done.body['fee'] as Body)['dueAt'] as string)).toEqual(
        payableDue(new Date(`${day}T00:00:00+03:30`), 3).dueAt,
      );
    } finally {
      await setRate('settlement.contract_cycle_months', 1);
    }
  });

  it('the doctor disputes an advisor record; then only accounting, not the recorder, decides', async () => {
    const referralId = await referred();
    await assignTo(advisor, referralId);
    const made = await record(advisor, referralId);
    const id = made.body['id'] as string;
    const disputed = await w.staff(w.doctor, 'POST', `/settlement/cash-services/${id}/dispute`, {
      reason: 'این بیمار نزد من خدمت نگرفته است',
    });
    expect(disputed.body['status']).toBe('disputed');
    // The doctor's side no longer decides it.
    expect((await decide(w.doctor, id, 'confirm')).status).toBe(403);
    const voided = await decide(finance, id, 'void');
    expect(voided.body).toMatchObject({ status: 'voided', fee: null });
  });

  it('an advisor records only for the cases assigned to it now; anything else is not found (R18)', async () => {
    const count = async (referralId: string) =>
      (
        await h.owner.query<Row>(
          'SELECT count(*)::int AS n FROM cash_services WHERE referral_id = $1',
          [referralId],
        )
      ).rows[0]?.['n'];
    // Another advisor's case.
    const others = await referred();
    await assignTo(otherAdvisor, others);
    const refused = await record(advisor, others);
    expect(refused.status).toBe(404);
    expect(refused.body).toEqual({ error: 'cash_service_not_found' });
    // No leak through validation: a future date on it is still only "not found".
    const future = await record(advisor, others, { serviceDate: '2999-01-01' });
    expect(future.status).toBe(404);
    expect(await count(others)).toBe(0);

    // A referral without a case (a person who asked not to be contacted).
    const quiet = await w.patient();
    const { rows: person } = await h.owner.query<Row>(
      'SELECT person_id FROM user_accounts WHERE id = $1',
      [quiet.id],
    );
    await h.app.get(PersonService).block(
      CLI_ACTOR,
      {
        accountId: '',
        roles: [],
        permissions: new Set(['lead.block_person'] as const),
        scopes: [{ kind: 'global' as const }],
      },
      person[0]?.['person_id'] as string,
      { kind: 'do_not_contact', reason: 'تماس نگیرید' },
    );
    // Booked and requested (a proforma needs a case; a cash service does not), on the last free
    // slot so the world's own bookings keep theirs.
    const from = new Date().toISOString().slice(0, 10);
    const to = new Date(Date.now() + 13 * 86_400_000).toISOString().slice(0, 10);
    const slots = (
      await w.as(
        quiet,
        'GET',
        `/booking/workplaces/${w.workplaceId}/free-slots?from=${from}&to=${to}`,
      )
    ).body as unknown as { startsAt: string }[];
    const held = await w.as(quiet, 'POST', '/booking/appointments/hold', {
      workplaceId: w.workplaceId,
      serviceCode: 'visit',
      startsAt: slots.at(-1)?.startsAt,
    });
    expect(held.status).toBe(201);
    await w.as(quiet, 'POST', `/booking/appointments/${held.body['id'] as string}/request`);
    const { rows: noCase } = await h.owner.query<Row>(
      'SELECT id, case_id FROM referrals WHERE person_id = $1',
      [person[0]?.['person_id']],
    );
    expect(noCase[0]?.['case_id']).toBeNull();
    const caseless = await record(advisor, noCase[0]?.['id'] as string);
    expect(caseless.status).toBe(404);
    expect(caseless.body).toEqual({ error: 'cash_service_not_found' });
    expect(await count(noCase[0]?.['id'] as string)).toBe(0);
    // Accounting (global) still records it: only the advisor's reach changed.
    expect((await record(finance, noCase[0]?.['id'] as string)).status).toBe(201);
  });

  it('once the case moves to another advisor, the first records nothing and lists nothing of it (R18)', async () => {
    const referralId = await referred();
    await assignTo(advisor, referralId);
    const made = await record(advisor, referralId);
    expect(made.status).toBe(201);
    const id = made.body['id'] as string;
    expect(await list(advisor)).toContain(id);
    expect(await list(otherAdvisor)).not.toContain(id);

    await assignTo(otherAdvisor, referralId);
    const after = await record(advisor, referralId);
    expect(after.status).toBe(404);
    expect(after.body).toEqual({ error: 'cash_service_not_found' });
    expect(await list(advisor)).not.toContain(id);
    expect(await list(otherAdvisor)).toContain(id);
    expect((await record(otherAdvisor, referralId)).status).toBe(201);
  });

  it('a confirmed cash fee disputed: held out of every payment; accepted, reversed exactly', async () => {
    await setRate('settlement.cash_service_fee', { basis: 'percent', bps: 1000 });
    try {
      const referralId = await referred();
      const made = await record(w.doctor, referralId);
      const fee = made.body['fee'] as Body;
      const { rows: nodes } = await h.owner.query<Row>(
        'SELECT doctor_node_id, journal_entry_id FROM service_fees WHERE id = $1',
        [fee['id']],
      );
      const node = nodes[0]?.['doctor_node_id'] as string;
      const opened = await w.staff(finance, 'POST', '/settlement/disputes', {
        subjectType: 'service_fee',
        subjectId: fee['id'],
        reason: 'پزشک به کارمزد نقدی اعتراض دارد',
      });
      expect(opened.status).toBe(201);
      expect(opened.body['items']).toHaveLength(1);
      expect((await h.app.get(SettlementService).payableItems(node)).fees).not.toContain(fee['id']);
      const done = await w.staff(
        finance2,
        'POST',
        `/settlement/disputes/${opened.body['id'] as string}/resolve`,
        { outcome: 'accepted', note: 'پذیرفته شد' },
      );
      expect(done.body['status']).toBe('resolved_accepted');
      const { rows } = await h.owner.query<Row>(
        `SELECT sum(CASE direction WHEN 'debit' THEN amount_rial ELSE -amount_rial END)::text AS net
         FROM ledger_entries WHERE journal_entry_id IN ($1, $2)`,
        [nodes[0]?.['journal_entry_id'], done.body['correctionJournalEntryId']],
      );
      expect(rows[0]?.['net']).toBe('0');
      await sound();
    } finally {
      await setRate('settlement.cash_service_fee', { basis: 'percent', bps: 0 });
    }
  });
});

// --- ADR-046: a doctor's or center's contract term (owner 1405/07/27) ---------------------

describe("a doctor's or center's contract term (ADR-046)", () => {
  const daysAgo = (n: number) =>
    gregorianDayOf(toJalali(new Date(Date.now() - n * 24 * 60 * 60 * 1000)));
  const DAY = 24 * 60 * 60 * 1000;

  async function doctorNode() {
    const { rows } = await h.owner.query<Row>(
      'SELECT node_id FROM doctor_workplaces WHERE id = $1',
      [w.workplaceId],
    );
    return rows[0]?.['node_id'] as string;
  }

  it('a cash service on or after its end is not recorded; renewed, it is', async () => {
    const node = await doctorNode();
    const referralId = await referred();
    const ended = { startsOn: daysAgo(215), months: 6 } as const;
    await setRate('settlement.provider_contract', ended, 'doctor', node);
    const refused = await record(w.doctor, referralId);
    expect(refused.status).toBe(409);
    expect(refused.body).toMatchObject({
      error: 'provider_contract_ended',
      endsOn: providerContractEndsOn(ended),
    });
    expect(
      (
        await h.owner.query<Row>(
          'SELECT count(*)::int AS n FROM cash_services WHERE referral_id = $1',
          [referralId],
        )
      ).rows[0]?.['n'],
    ).toBe(0);
    await setRate(
      'settlement.provider_contract',
      { startsOn: today(), months: 12 },
      'doctor',
      node,
    );
    expect((await record(w.doctor, referralId)).status).toBe(201);
    await sound();
  });

  it("the service's own day decides, not the day it is recorded on (referrals are append-only)", async () => {
    const node = await doctorNode();
    // Three months from 80 days ago: ends in about ten days.
    const term = { startsOn: daysAgo(80), months: 3 } as const;
    const ends = providerContractEndsOn(term) ?? '';
    await setRate('settlement.provider_contract', term, 'doctor', node);
    try {
      const service = h.app.get(CashServiceService);
      const access = await h.app.get<AccessPort>(ACCESS_PORT).resolve(finance.id);
      const actor = { accountId: finance.id, sessionId: null, ip: null, roles: ['accounting'] };
      // Recorded five days after the end.
      const after = new Date(Date.parse(`${ends}T12:00:00Z`) + 5 * DAY);
      // A service of today, before the end: taken, though recorded after it.
      const before = await service.record(
        actor,
        access,
        {
          referralId: await referred(),
          serviceDate: today(),
          amountRial: '3000000',
          idempotencyKey: `cash-${randomUUID()}`,
        },
        after,
      );
      expect(before.status).toBe('recorded');
      // A service on the end day itself: refused.
      await expect(
        service.record(
          actor,
          access,
          {
            referralId: await referred(),
            serviceDate: ends,
            amountRial: '3000000',
            idempotencyKey: `cash-${randomUUID()}`,
          },
          after,
        ),
      ).rejects.toMatchObject({ response: { error: 'provider_contract_ended', endsOn: ends } });
    } finally {
      await setRate(
        'settlement.provider_contract',
        { startsOn: today(), months: 12 },
        'doctor',
        node,
      );
    }
  });

  it('daily: a notice while any term ends within the warning days or has ended; closed once renewed', async () => {
    const check = (worker as INestApplicationContext).get(ProviderContractCheck);
    // A minute after the rows this test writes: their effective time is the database's clock,
    // which may run a few seconds ahead of this process's (seen in HEAVY 30b, 1405/07/29).
    const soon = () => new Date(Date.now() + 60_000);
    const node = await doctorNode();
    const notice = async () =>
      (
        await h.owner.query<Row>(
          `SELECT audience_permission, message FROM admin_notices
            WHERE code = 'provider_contracts_ending' AND resolved_at IS NULL AND deleted_at IS NULL`,
        )
      ).rows;
    // Renewed above: twelve months ahead, nothing to say.
    expect(await check.run(soon())).toMatchObject({ ending: 0, ended: 0, notice: 'resolved' });
    expect(await notice()).toEqual([]);
    // Six months from 160 days ago: ends in about 20 days, within the 30.
    await setRate(
      'settlement.provider_contract',
      { startsOn: daysAgo(160), months: 6 },
      'doctor',
      node,
    );
    expect(await check.run(soon())).toMatchObject({ ending: 1, ended: 0, notice: 'raised' });
    const [open] = await notice();
    expect(open?.['audience_permission']).toBe('config.manage_business');
    expect(open?.['message']).toMatch(/۱ پزشک یا مرکز تا ۳۰ روز/);
    // Seen 40 days later it is past its end: ended, still noticed.
    expect(await check.run(new Date(Date.now() + 40 * DAY))).toMatchObject({ ending: 0, ended: 1 });
    // The warning days from configuration: 10 days, so 20 ahead is not yet said.
    await setRate('settlement.provider_contract_warn_days', 10);
    expect(await check.run(soon())).toMatchObject({ ending: 0, ended: 0, notice: 'resolved' });
    await setRate('settlement.provider_contract_warn_days', 30);
    // Renewed: closed.
    await setRate(
      'settlement.provider_contract',
      { startsOn: today(), months: 12 },
      'doctor',
      node,
    );
    expect(await check.run(soon())).toMatchObject({ ending: 0, ended: 0, notice: 'resolved' });
    expect(await notice()).toEqual([]);
  });
});

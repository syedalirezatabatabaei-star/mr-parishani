import { randomUUID } from 'node:crypto';
import type { INestApplicationContext } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import {
  fromJalali,
  gregorianDayOf,
  nextJalaliDay,
  providerContractEndsOn,
  toJalali,
  type JalaliDate,
} from '@sepehr/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { EffectiveAccess } from '../../src/common/auth/access.port';
import type { Actor } from '../../src/common/audit/audit.port';
import {
  WORKPLACE_DIRECTORY,
  type WorkplaceDirectory,
} from '../../src/common/catalog/workplace-directory.port';
import { CONFIG } from '../../src/common/config/config.port';
import {
  CREDIT_CONTRACT_FACTS,
  type CreditContractFactsPort,
} from '../../src/common/credit/credit-contract-facts.port';
import { OUTBOX } from '../../src/common/events/outbox.port';
import {
  PROFORMA_DIRECTORY,
  type ProformaDirectory,
} from '../../src/common/proforma/proforma-directory.port';
import { OBJECT_STORAGE, type ObjectStorage } from '../../src/common/storage/object-storage.port';
import { WALLET, type WalletPort } from '../../src/common/wallet/wallet.port';
import { DATABASE, type Database } from '../../src/db/database.module';
import { ContractPrinter } from '../../src/modules/contract/contract-printer';
import { LedgerReconciliation } from '../../src/modules/ledger/reconciliation';
import { DoctorPatientsProjector } from '../../src/modules/service/doctor-patients.projector';
import {
  SERVICE_SMS_SENDER,
  ServiceAuthorizationService,
} from '../../src/modules/service/service-authorization.service';
import { WorkerModule } from '../../src/worker.module';
import {
  CapturingTextSender,
  newMobile,
  startHarness,
  type Harness,
  type loggedInAccount,
} from '../identity/harness';
import {
  CREDIT_HARNESS,
  creditWorld,
  PDF,
  type Body,
  type Patient,
  type Row,
} from '../credit/world';

/**
 * Task 4-6 [financial] (doc 12 §6, §9 tests 5–10, 13 and 14; owner 1405/07/12): a service
 * authorized on a funded purse's proforma lines reserves on the memo chain through phase 1's
 * wallet; the borrower's code registers it; final is a state and an event only (no
 * doctor.payable: phase 5); finance alone cancels, before final, by reversing the
 * registration; every wallet step keyed per authorization.
 */

type World = Awaited<ReturnType<typeof creditWorld>>;
type Staff = Awaited<ReturnType<typeof loggedInAccount>>;

let h: Harness;
let w: World;
let manager: Staff;
let finance: Staff;
let worker: INestApplicationContext | undefined;
const texts = new CapturingTextSender();

const alef = {
  job: 'official',
  employmentStartedOn: { year: 1398, month: 1, day: 1 },
  coverage: 'full',
  obligationsRial: '1000000',
  newInstallmentRial: '4000000',
};

beforeAll(async () => {
  h = await startHarness({ ...CREDIT_HARNESS, overrides: [[SERVICE_SMS_SENDER, texts]] });
  w = await creditWorld(h);
  manager = await w.role('credit_manager');
  finance = await w.role('accounting');
  worker = await NestFactory.createApplicationContext(WorkerModule.forRoot({ relayLoop: false }), {
    logger: false,
  });
}, 180_000);

afterAll(async () => {
  await worker?.close();
  await h.close();
});

// --- the path to a funded purse (as in the funding tests) ------------------------------

async function decide(world: World, applicationId: string) {
  await world.staff(
    world.creditSpecialist,
    'POST',
    `/credit/applications/${applicationId}/score-sheets`,
    {
      subject: 'borrower',
      raw: alef,
    },
  );
  await world.staff(
    world.creditSpecialist,
    'POST',
    `/credit/applications/${applicationId}/to-decision`,
  );
  const proposed = await world.staff(
    world.creditSpecialist,
    'POST',
    `/credit/applications/${applicationId}/decisions`,
    { outcome: 'approved', reason: 'رتبه الف' },
  );
  const confirmed = await world.staff(
    manager,
    'POST',
    `/credit/applications/${applicationId}/decisions/${proposed.body['id'] as string}/confirm`,
  );
  expect(confirmed.status).toBe(201);
}

async function uploadReceipt(p: Patient, applicationId: string, fields: Record<string, string>) {
  const form = new FormData();
  for (const [k, v] of Object.entries(fields)) form.append(k, v);
  form.append('file', new Blob([new Uint8Array(PDF)]), 'receipt.pdf');
  const res = await fetch(`${h.baseUrl}/me/completion/${applicationId}/receipts`, {
    method: 'POST',
    headers: { authorization: `Bearer ${p.token}` },
    body: form,
  });
  return { status: res.status, body: (await res.json()) as Body };
}

/** Contract printed and accepted, papers checked, receipts approved, completed, funded. */
async function fund(world: World, borrower: Patient, applicationId: string): Promise<string> {
  const contract = await world.staff(world.completion, 'POST', '/contracts', {
    creditApplicationId: applicationId,
  });
  expect(contract.status).toBe(201);
  const contractId = contract.body['id'] as string;
  const db = h.app.get<Database>(DATABASE);
  await db.transaction((tx) =>
    new ContractPrinter(
      { register: () => undefined },
      h.app.get(CONFIG),
      h.app.get(OUTBOX),
      { render: () => Promise.resolve(Buffer.from('%PDF-1.4\n%%EOF\n')) },
      h.app.get<ObjectStorage>(OBJECT_STORAGE),
    ).handle(
      {
        id: randomUUID(),
        type: 'contract.requested',
        aggregateType: 'contract',
        aggregateId: contractId,
        payload: { contractId, creditApplicationId: applicationId },
        occurredAt: new Date().toISOString(),
      },
      tx,
    ),
  );
  await world.as(borrower, 'POST', `/me/contracts/${contractId}/acceptance/request`, {
    role: 'borrower',
  });
  const accepted = await world.as(borrower, 'POST', `/me/contracts/${contractId}/acceptance`, {
    role: 'borrower',
    code: h.sms.lastCodeFor(borrower.mobile),
  });
  expect(accepted.body['status']).toBe('accepted');
  const delivery = await world.staff(world.completion, 'POST', '/deliveries', {
    creditApplicationId: applicationId,
    items: [{ kind: 'signed_contract', label: 'قرارداد امضاشده' }],
  });
  const deliveryId = delivery.body['id'] as string;
  await world.staff(world.completion, 'POST', `/deliveries/${deliveryId}/receive`, {
    method: 'in_person',
  });
  await world.staff(
    world.completion,
    'POST',
    `/deliveries/${deliveryId}/items/${(delivery.body['items'] as Body[])[0]?.['id'] as string}`,
    { status: 'received' },
  );
  await world.staff(world.completion, 'POST', `/deliveries/${deliveryId}/check`);
  const status = await world.staff(world.completion, 'GET', `/completion/${applicationId}`);
  for (const owed of status.body['owed'] as Body[]) {
    const sent = await uploadReceipt(borrower, applicationId, {
      kind: owed['kind'] as string,
      amountRial: owed['expectedRial'] as string,
      paidOn: '2026-10-01',
      reference: `REF-${owed['kind'] as string}-${randomUUID().slice(0, 8)}`,
    });
    expect(sent.status).toBe(201);
    const approved = await world.staff(
      finance,
      'POST',
      `/receipts/${sent.body['id'] as string}/approve`,
    );
    expect(approved.body['status']).toBe('approved');
  }
  expect(
    (await world.staff(world.completion, 'POST', `/completion/${applicationId}/complete`)).status,
  ).toBe(201);
  const asked = await world.staff(world.completion, 'POST', '/funding/requests', {
    creditApplicationId: applicationId,
  });
  const approved = await world.staff(
    finance,
    'POST',
    `/funding/requests/${asked.body['id'] as string}/approve`,
  );
  expect(approved.status).toBe(201);
  const purseId = approved.body['purseId'] as string;
  // The doctor's list, as the worker keeps it from wallet.funded.
  await project(applicationId, purseId);
  return purseId;
}

async function project(creditApplicationId: string, purseId: string) {
  const projector = new DoctorPatientsProjector(
    { register: () => undefined },
    h.app.get(CREDIT_CONTRACT_FACTS),
    h.app.get(PROFORMA_DIRECTORY),
    h.app.get(WORKPLACE_DIRECTORY),
    h.app.get(WALLET),
  );
  await h.app.get<Database>(DATABASE).transaction((tx) =>
    projector.handle(
      {
        id: randomUUID(),
        type: 'wallet.funded',
        aggregateType: 'funding_request',
        aggregateId: randomUUID(),
        payload: { creditApplicationId, purseId },
        occurredAt: new Date().toISOString(),
      },
      tx,
    ),
  );
}

interface Funded {
  patient: Patient;
  applicationId: string;
  purseId: string;
  lineIds: string[];
  lineAmounts: Map<string, bigint>;
}

async function linesOf(applicationId: string) {
  const facts = await h.app
    .get<CreditContractFactsPort>(CREDIT_CONTRACT_FACTS)
    .facts(applicationId);
  const lines = await h.app
    .get<ProformaDirectory>(PROFORMA_DIRECTORY)
    .lines(facts?.proformaId ?? '');
  return {
    lineIds: lines.map((l) => l.id),
    lineAmounts: new Map(lines.map((l) => [l.id, l.lineTotalRial])),
  };
}

/** One borrower's funded purse: 6,000,000 + 2 × 3,000,000 rials, all of it usable. */
async function funded(world: World = w): Promise<Funded> {
  const { patient, applicationId } = await world.inReview();
  await decide(world, applicationId);
  const purseId = await fund(world, patient, applicationId);
  return { patient, applicationId, purseId, ...(await linesOf(applicationId)) };
}

// --- calls --------------------------------------------------------------------------------

const issue = (who: Staff, purseId: string, proformaLineIds: string[]) =>
  w.staff(who, 'POST', '/service/authorizations', { purseId, proformaLineIds });
const deliver = (who: Staff, id: string, code: string) =>
  w.staff(who, 'POST', `/service/authorizations/${id}/deliver`, { code });
const cancel = (who: Staff, id: string, reason = 'خدمت انجام نشد') =>
  w.staff(who, 'POST', `/service/authorizations/${id}/cancel`, { reason });

/** The code in the last SMS to this mobile (never stored: only its HMAC is). */
function lastCode(mobile: string): string {
  const sms = [...texts.sent].reverse().find((s) => s.mobile === mobile);
  const code = /(\d{6})\s*$/.exec(sms?.text ?? '')?.[1];
  if (!code) throw new Error(`no service code sent to ${mobile}`);
  return code;
}
const wrong = (code: string) => (code === '000000' ? '111111' : '000000');

const service = () => h.app.get(ServiceAuthorizationService);
const wallet = () => h.app.get<WalletPort>(WALLET);
const balances = async (purseId: string) => (await wallet().summary(purseId)).balances;

function doctorOf(world: World): { actor: Actor; access: EffectiveAccess } {
  return {
    actor: { accountId: world.doctor.id, sessionId: null, ip: null, roles: ['doctor'] },
    access: {
      accountId: world.doctor.id,
      roles: ['doctor'],
      permissions: new Set(['service.authorize', 'service.read']),
      scopes: [],
    } as unknown as EffectiveAccess,
  };
}

async function operations(authorizationId: string) {
  const { rows } = await h.owner.query<Row>(
    `SELECT kind FROM purse_operations
      WHERE authorization_id = $1
         OR reverses_operation_id IN (SELECT id FROM purse_operations WHERE authorization_id = $1)
      ORDER BY created_at, id`,
    [authorizationId],
  );
  // Steps of one transaction share created_at: compared as a sorted list.
  return rows.map((r) => r['kind'] as string).sort();
}
const kinds = (...k: string[]) => [...k].sort();

async function setConfig(key: string, value: unknown) {
  await h.owner.query(
    `INSERT INTO config_values (key, scope_level, value, effective_at, status, reason, decided_at)
     VALUES ($1, 'global', $2::jsonb, now(), 'approved', 'آزمون ۴-۶', now())`,
    [key, JSON.stringify(value)],
  );
}

async function ledgerSound() {
  const { rows: unbalanced } = await h.owner.query<Row>(
    `SELECT journal_entry_id FROM ledger_entries GROUP BY journal_entry_id
     HAVING sum(CASE direction WHEN 'debit' THEN amount_rial ELSE -amount_rial END) <> 0`,
  );
  expect(unbalanced).toEqual([]);
  const { rows } = await h.owner.query<Row>(
    `SELECT coalesce(sum(amount_rial) FILTER (WHERE direction = 'debit'), 0)::text AS d,
            coalesce(sum(amount_rial) FILTER (WHERE direction = 'credit'), 0)::text AS c
       FROM ledger_entries`,
  );
  expect(rows[0]?.['d']).toBe(rows[0]?.['c']);
  const result = await (worker as INestApplicationContext).get(LedgerReconciliation).run();
  expect(result).toMatchObject({ clean: true, discrepancies: [] });
}

/** Journals of these authorizations that touch anything but the purse's memo chain. */
async function realAccountLines(purseId: string) {
  const { rows } = await h.owner.query<Row>(
    `SELECT DISTINCT a.code FROM purse_operations o
       JOIN ledger_entries e ON e.journal_entry_id = o.journal_entry_id
       JOIN ledger_accounts a ON a.id = e.account_id
      WHERE o.purse_id = $1
        AND o.kind IN ('reserve', 'cancel_reservation', 'register_service', 'reversal')
        AND a.code NOT LIKE 'purse.%'`,
    [purseId],
  );
  return rows.map((r) => r['code']);
}

describe('service authorization and delivery (doc 12 §6)', () => {
  it("reserves the lines, registers with the borrower's code, final at once; memo chain only (§9 tests 10, 13)", async () => {
    const f = await funded();
    const before = await balances(f.purseId);
    expect(before.availableRial).toBe(12_000_000n);
    // The proforma: the visit (6,000,000) and two scalings on one line (6,000,000).
    const [visit] = f.lineIds;
    expect(f.lineIds).toHaveLength(2);
    const made = await issue(w.doctor, f.purseId, [visit ?? '']);
    expect(made.status).toBe(201);
    expect(made.body).toMatchObject({
      status: 'code_sent',
      amountRial: '6000000',
      attemptsLeft: 5,
      sendsLeft: 2,
    });
    const id = made.body['id'] as string;
    expect(await balances(f.purseId)).toMatchObject({
      availableRial: 6_000_000n,
      reservedRial: 6_000_000n,
    });

    // Test 10: the code SMS names the amount and the place, never the treatment.
    const sms = [...texts.sent].reverse().find((s) => s.mobile === f.patient.mobile);
    expect(sms?.text).toContain('۶۰۰٬۰۰۰ تومان');
    expect(sms?.text).toContain('کلینیک اعتبار');
    expect(sms?.text).not.toMatch(/ویزیت|جرم|دندان|قسط|بدهی|رتبه/);
    // Only its HMAC is stored.
    const { rows: stored } = await h.owner.query<Row>(
      'SELECT code_hash FROM service_codes WHERE authorization_id = $1',
      [id],
    );
    expect(stored[0]?.['code_hash']).not.toContain(lastCode(f.patient.mobile));

    const done = await deliver(w.doctor, id, lastCode(f.patient.mobile));
    expect(done.status).toBe(201);
    expect(done.body).toMatchObject({ status: 'finalized' });
    expect(await balances(f.purseId)).toMatchObject({
      availableRial: 6_000_000n,
      reservedRial: 0n,
      consumedPendingRial: 6_000_000n,
    });
    // Owner, پ۱ and ت۱: no finalize to doctor.payable in 4-6, nothing outside the memo chain.
    expect(await operations(id)).toEqual(kinds('reserve', 'register_service'));
    expect(await realAccountLines(f.purseId)).toEqual([]);
    const { rows: events } = await h.owner.query<Row>(
      `SELECT event_type FROM outbox_events WHERE aggregate_id = $1 ORDER BY created_at, id`,
      [id],
    );
    expect(events.map((e) => e['event_type']).sort()).toEqual(
      kinds('service.authorized', 'service.code_sent', 'service.delivered', 'service.finalized'),
    );
    // The patient sees it; the payload of events holds ids and amounts only.
    const mine = await w.as(f.patient, 'GET', '/me/service/authorizations');
    expect(mine.body).toEqual([
      expect.objectContaining({ id, status: 'finalized', amountRial: '6000000' }),
    ]);
    await ledgerSound();
  });

  it('§9 test 14: the code entered twice at once, and again after a dropped answer, registers once', async () => {
    const f = await funded();
    const made = await issue(w.doctor, f.purseId, [f.lineIds[1] ?? '']);
    const id = made.body['id'] as string;
    const code = lastCode(f.patient.mobile);
    const both = await Promise.all([deliver(w.doctor, id, code), deliver(w.doctor, id, code)]);
    for (const r of both) {
      expect(r.status).toBe(201);
      expect(r.body['status']).toBe('finalized');
    }
    const again = await deliver(w.doctor, id, code);
    expect(again.status).toBe(201);
    expect(await operations(id)).toEqual(kinds('reserve', 'register_service'));
    expect((await balances(f.purseId)).consumedPendingRial).toBe(6_000_000n);
  });

  it('§9 test 6: four wrong codes count down; the fifth expires it and frees the reservation and lines', async () => {
    const f = await funded();
    const made = await issue(w.doctor, f.purseId, [f.lineIds[0] ?? '']);
    const id = made.body['id'] as string;
    const code = lastCode(f.patient.mobile);
    for (let left = 4; left >= 1; left--) {
      const r = await deliver(w.doctor, id, wrong(code));
      expect(r.status).toBe(422);
      expect(r.body).toMatchObject({ error: 'code_invalid', attemptsLeft: left });
    }
    const fifth = await deliver(w.doctor, id, wrong(code));
    expect(fifth.status).toBe(409);
    expect(fifth.body['error']).toBe('authorization_expired');
    // The right code is refused now too, and nothing was registered.
    expect((await deliver(w.doctor, id, code)).status).toBe(409);
    expect(await operations(id)).toEqual(kinds('reserve', 'cancel_reservation'));
    expect(await balances(f.purseId)).toMatchObject({
      availableRial: 12_000_000n,
      reservedRial: 0n,
    });
    // The line is free for a new authorization (owner, پ۷).
    expect((await issue(w.doctor, f.purseId, [f.lineIds[0] ?? ''])).status).toBe(201);
  });

  it('§9 test 6: an expired code expires the authorization and frees the reservation', async () => {
    const f = await funded();
    const made = await issue(w.doctor, f.purseId, [f.lineIds[1] ?? '']);
    const id = made.body['id'] as string;
    const { actor, access } = doctorOf(w);
    const later = new Date(Date.now() + 11 * 60_000);
    await expect(
      service().deliver(actor, access, id, lastCode(f.patient.mobile), later),
    ).rejects.toMatchObject({ response: { error: 'authorization_expired' } });
    expect(await operations(id)).toEqual(kinds('reserve', 'cancel_reservation'));
    expect((await balances(f.purseId)).availableRial).toBe(12_000_000n);
  });

  it('§9 test 7: unconfirmed after its TTL, the job expires it; run again, or twice at once, nothing more', async () => {
    const f = await funded();
    const made = await issue(w.doctor, f.purseId, [f.lineIds[1] ?? '']);
    const id = made.body['id'] as string;
    const after = new Date(Date.now() + 25 * 3_600_000);
    // Owner, پ۴: the re-run of the job is part of the test.
    await Promise.all([service().expireOverdue(after), service().expireOverdue(after)]);
    await service().expireOverdue(after);
    const { rows } = await h.owner.query<Row>(
      'SELECT status FROM service_authorizations WHERE id = $1',
      [id],
    );
    expect(rows[0]?.['status']).toBe('expired');
    expect(await operations(id)).toEqual(kinds('reserve', 'cancel_reservation'));
    expect((await balances(f.purseId)).availableRial).toBe(12_000_000n);
    const { rows: expiredEvents } = await h.owner.query<Row>(
      `SELECT count(*)::int AS n FROM outbox_events
        WHERE aggregate_id = $1 AND event_type = 'service.authorization_expired'`,
      [id],
    );
    expect(expiredEvents[0]).toEqual({ n: 1 });
  });

  it('owner پ۵: a new code no sooner than 60 s, three in all; the earlier code stops working', async () => {
    const f = await funded();
    const made = await issue(w.doctor, f.purseId, [f.lineIds[0] ?? '']);
    const id = made.body['id'] as string;
    const first = lastCode(f.patient.mobile);
    const soon = await w.staff(w.doctor, 'POST', `/service/authorizations/${id}/resend`);
    expect(soon.status).toBe(409);
    expect(soon.body['error']).toBe('code_resend_too_soon');
    const { actor, access } = doctorOf(w);
    const t1 = new Date(Date.now() + 61_000);
    const second = await service().resend(actor, access, id, t1);
    expect(second.sendsLeft).toBe(1);
    const secondCode = lastCode(f.patient.mobile);
    const t2 = new Date(t1.getTime() + 61_000);
    expect((await service().resend(actor, access, id, t2)).sendsLeft).toBe(0);
    await expect(
      service().resend(actor, access, id, new Date(t2.getTime() + 61_000)),
    ).rejects.toMatchObject({ response: { error: 'code_send_limit' } });
    const third = lastCode(f.patient.mobile);
    if (first !== third) {
      await expect(service().deliver(actor, access, id, first, t2)).rejects.toMatchObject({
        response: { error: 'code_invalid' },
      });
    }
    if (secondCode !== third) {
      await expect(service().deliver(actor, access, id, secondCode, t2)).rejects.toMatchObject({
        response: { error: 'code_invalid' },
      });
    }
    expect((await service().deliver(actor, access, id, third, t2)).status).toBe('finalized');
  });

  it('owner پ۷: a line in one live authorization only, free again once cancelled; only this purse\x27s lines', async () => {
    // Refusing more than the purse holds, whole (owner, پ۶), is §9 test 5 below.
    const f = await funded();
    const [visit, scaling] = f.lineIds;
    const first = await issue(w.doctor, f.purseId, [scaling ?? '']);
    expect(first.status).toBe(201);
    const twice = await issue(w.doctor, f.purseId, [scaling ?? '']);
    expect(twice.status).toBe(409);
    expect(twice.body['error']).toBe('line_already_authorized');
    // With another live line beside it, refused whole: nothing of it reserved.
    const mixed = await issue(w.doctor, f.purseId, [visit ?? '', scaling ?? '']);
    expect(mixed.status).toBe(409);
    expect((await balances(f.purseId)).availableRial).toBe(6_000_000n);
    expect((await issue(w.doctor, f.purseId, [visit ?? ''])).status).toBe(201);
    const { rows: countBefore } = await h.owner.query<Row>(
      'SELECT count(*)::int AS n FROM service_authorizations WHERE purse_id = $1',
      [f.purseId],
    );
    // A line of another proforma is not this purse's.
    const other = await funded();
    const foreign = await issue(w.doctor, f.purseId, [other.lineIds[0] ?? '']);
    expect(foreign.status).toBe(422);
    expect(foreign.body['error']).toBe('line_not_in_proforma');
    // Cancelled by finance: the line is free again.
    await cancel(finance, first.body['id'] as string);
    const { rows: countAfter } = await h.owner.query<Row>(
      'SELECT count(*)::int AS n FROM service_authorizations WHERE purse_id = $1',
      [f.purseId],
    );
    expect(countAfter).toEqual(countBefore);
    expect((await balances(f.purseId)).availableRial).toBe(6_000_000n);
    expect((await issue(w.doctor, f.purseId, [scaling ?? ''])).status).toBe(201);
  });

  it('§9 test 8: another doctor, or one without the permission, reaches nothing of it', async () => {
    const f = await funded();
    const made = await issue(w.doctor, f.purseId, [f.lineIds[1] ?? '']);
    const id = made.body['id'] as string;
    const w2 = await creditWorld(h);
    const stranger = w2.doctor;
    const refused = await issue(stranger, f.purseId, [f.lineIds[0] ?? '']);
    expect(refused.status).toBe(404);
    expect(refused.body['error']).toBe('purse_not_found');
    expect((await deliver(stranger, id, lastCode(f.patient.mobile))).status).toBe(404);
    expect((await w.staff(stranger, 'POST', `/service/authorizations/${id}/resend`)).status).toBe(
      404,
    );
    const theirs = await w.staff(stranger, 'GET', '/service/patients');
    expect(theirs.body).toEqual([]);
    // Case completion reads but never authorizes; the doctor never cancels.
    expect((await issue(w.completion, f.purseId, [f.lineIds[0] ?? ''])).status).toBe(403);
    expect((await cancel(w.doctor, id)).status).toBe(403);
    // Unchanged by any of it.
    expect(await operations(id)).toEqual(kinds('reserve'));
  });

  it("owner پ۲: the doctor's patients are names and allowed only, kept once per funding", async () => {
    const f = await funded();
    await project(f.applicationId, f.purseId); // a redelivered event
    const list = await w.staff(w.doctor, 'GET', '/service/patients');
    expect(list.status).toBe(200);
    const mine = (list.body as unknown as Body[]).filter((p) => p['purseId'] === f.purseId);
    expect(mine).toHaveLength(1);
    expect(Object.keys(mine[0] ?? {}).sort()).toEqual(
      ['allowed', 'creditApplicationId', 'patientName', 'purseId'].sort(),
    );
    expect(mine[0]?.['allowed']).toBe(true);
    expect(JSON.stringify(list.body)).not.toMatch(/Rial|balance|score|grade/i);
  });

  it("task 4-7: the doctor reads a patient's proforma lines to authorize from, with no balance; others nothing", async () => {
    const f = await funded();
    const before = await w.staff(w.doctor, 'GET', `/service/patients/${f.purseId}/lines`);
    expect(before.status).toBe(200);
    expect(before.body).toMatchObject({ purseId: f.purseId, allowed: true });
    const lines = before.body['lines'] as Body[];
    expect(lines.map((l) => [l['amountRial'], l['authorized']])).toEqual([
      ['6000000', false],
      ['6000000', false],
    ]);
    // Named as the catalog names them (the world names scaling «جرم‌گیری»).
    expect(lines[1]?.['serviceName']).toBe('جرم‌گیری');
    expect(lines[0]?.['serviceName']).not.toBe('visit');
    // The purse's balance is never in it (owner, پ۲).
    expect(Object.keys(before.body).sort()).toEqual(
      ['allowed', 'lines', 'patientName', 'purseId'].sort(),
    );
    await issue(w.doctor, f.purseId, [f.lineIds[0] ?? '']);
    const after = await w.staff(w.doctor, 'GET', `/service/patients/${f.purseId}/lines`);
    expect((after.body['lines'] as Body[]).map((l) => l['authorized'])).toEqual([true, false]);
    // Another doctor: it does not exist for them (test 8).
    const w2 = await creditWorld(h);
    expect((await w.staff(w2.doctor, 'GET', `/service/patients/${f.purseId}/lines`)).status).toBe(
      404,
    );
  });

  it("task 4-7: the patient's purse is named from configuration (wallet.purse_title)", async () => {
    const f = await funded();
    const view = await w.as(f.patient, 'GET', `/me/funding/${f.applicationId}`);
    expect(view.status).toBe(200);
    expect(view.body['purseTitle']).toBe('کیف اعتبار');
    await setConfig('wallet.purse_title', 'اعتبار درمان');
    try {
      expect(
        (await w.as(f.patient, 'GET', `/me/funding/${f.applicationId}`)).body['purseTitle'],
      ).toBe('اعتبار درمان');
    } finally {
      await setConfig('wallet.purse_title', 'کیف اعتبار');
    }
  });

  describe('cancelled by finance (owner, پ۳ and ت۲)', () => {
    it('a delivered service: reversed on the memo chain, the purse back to before; cancelling again changes nothing', async () => {
      await setConfig('service.finalize_after_hours', 24);
      try {
        const f = await funded();
        const before = await balances(f.purseId);
        const made = await issue(w.doctor, f.purseId, [f.lineIds[0] ?? '']);
        const id = made.body['id'] as string;
        const done = await deliver(w.doctor, id, lastCode(f.patient.mobile));
        expect(done.body['status']).toBe('delivered');
        expect((await balances(f.purseId)).consumedPendingRial).toBe(6_000_000n);

        // Only finance, and only with a reason.
        expect((await cancel(w.completion, id)).status).toBe(403);
        expect(
          (await w.staff(finance, 'POST', `/service/authorizations/${id}/cancel`, { reason: '' }))
            .status,
        ).toBe(400);
        const cancelled = await cancel(finance, id, 'بیمار خدمت را نگرفت');
        expect(cancelled.status).toBe(201);
        expect(cancelled.body).toMatchObject({
          status: 'cancelled',
          cancelReason: 'بیمار خدمت را نگرفت',
        });
        expect(await balances(f.purseId)).toEqual(before);
        expect(await operations(id)).toEqual(
          kinds('reserve', 'register_service', 'reversal', 'cancel_reservation'),
        );
        const again = await cancel(finance, id, 'دوباره');
        expect(again.status).toBe(201);
        expect(again.body['cancelReason']).toBe('بیمار خدمت را نگرفت');
        expect(await operations(id)).toHaveLength(4);
        const { rows: audit } = await h.owner.query<Row>(
          `SELECT reason FROM audit_events WHERE entity_id = $1 AND action = 'service.cancelled'`,
          [id],
        );
        expect(audit).toEqual([{ reason: 'بیمار خدمت را نگرفت' }]);
        await ledgerSound();
      } finally {
        await setConfig('service.finalize_after_hours', 0);
      }
    });

    it('a final service is not cancelled in 4-6 (phase 5); finalizing twice posts nothing and says it once', async () => {
      await setConfig('service.finalize_after_hours', 24);
      try {
        const f = await funded();
        const made = await issue(w.doctor, f.purseId, [f.lineIds[1] ?? '']);
        const id = made.body['id'] as string;
        await deliver(w.doctor, id, lastCode(f.patient.mobile));
        const after = new Date(Date.now() + 25 * 3_600_000);
        await Promise.all([service().finalizeDue(after), service().finalizeDue(after)]);
        await service().finalizeDue(after);
        const refused = await cancel(finance, id);
        expect(refused.status).toBe(409);
        expect(refused.body['error']).toBe('service_final');
        expect(await operations(id)).toEqual(kinds('reserve', 'register_service'));
        const { rows } = await h.owner.query<Row>(
          `SELECT count(*)::int AS n FROM outbox_events
            WHERE aggregate_id = $1 AND event_type = 'service.finalized'`,
          [id],
        );
        expect(rows[0]).toEqual({ n: 1 });
        expect((await balances(f.purseId)).consumedPendingRial).toBe(6_000_000n);
      } finally {
        await setConfig('service.finalize_after_hours', 0);
      }
    });

    it('an authorization still waiting for its code: the reservation cancelled', async () => {
      const f = await funded();
      const made = await issue(w.doctor, f.purseId, [f.lineIds[0] ?? '']);
      const id = made.body['id'] as string;
      expect((await cancel(finance, id)).body['status']).toBe('cancelled');
      expect(await operations(id)).toEqual(kinds('reserve', 'cancel_reservation'));
      expect((await balances(f.purseId)).availableRial).toBe(12_000_000n);
      // Its code no longer registers anything.
      expect((await deliver(w.doctor, id, lastCode(f.patient.mobile))).status).toBe(409);
    });
  });

  it('§9 test 5: fifty authorizations at once on one purse never take more than it holds', async () => {
    // A group member's purse of 12,000,000 rials, against a proforma of fifty lines
    // (6,000,000 + 49 × 3,000,000): each authorization asks for one line.
    const patient = await w.patient();
    let day: JalaliDate = toJalali(new Date());
    for (let i = 0; i < 5; i++) day = nextJalaliDay(day);
    const held = await w.as(patient, 'POST', '/booking/appointments/hold', {
      workplaceId: w.workplaceId,
      serviceCode: 'visit',
      startsAt: fromJalali(day, { hour: 19, minute: 30 }).toISOString(),
    });
    expect(held.status).toBe(201);
    await w.as(patient, 'POST', `/booking/appointments/${held.body['id'] as string}/request`);
    await w.examine(patient, held.body['id'] as string);
    const made = await w.staff(w.doctor, 'POST', '/proformas', {
      appointmentId: held.body['id'],
      lines: [
        { serviceCode: 'visit', quantity: 1, unitRial: '6000000' },
        ...Array.from({ length: 49 }, () => ({ serviceCode: 'scaling', quantity: 1 })),
      ],
    });
    expect(made.status).toBe(201);
    const proformaId = made.body['id'] as string;
    expect((await w.staff(w.doctor, 'POST', `/proformas/${proformaId}/issue`)).status).toBe(201);
    expect((await w.as(patient, 'POST', `/me/proformas/${proformaId}/confirm`)).status).toBe(201);
    const group = await w.as(patient, 'POST', '/me/credit-application-groups', {
      proformaId,
      members: [
        { planCode: 'dental_12', installmentCount: 12, shareRial: '12000000' },
        {
          planCode: 'dental_12',
          installmentCount: 12,
          shareRial: '141000000',
          borrowerMobile: `0${newMobile()}`,
        },
      ],
    });
    expect(group.status).toBe(201);
    const applicationId = (group.body as unknown as Body[])[0]?.['id'] as string;
    await w.as(patient, 'POST', `/me/credit-applications/${applicationId}/submit`);
    await w.consent(patient, applicationId, 'borrower');
    await w.documented(patient, applicationId, 'borrower');
    await w.staff(w.completion, 'POST', `/credit/applications/${applicationId}/ready-for-review`);
    await decide(w, applicationId);
    const purseId = await fund(w, patient, applicationId);
    expect((await balances(purseId)).availableRial).toBe(12_000_000n);
    const { lineIds } = await linesOf(applicationId);
    expect(lineIds).toHaveLength(50);

    const results = await Promise.all(lineIds.map((line) => issue(w.doctor, purseId, [line])));
    const ok = results.filter((r) => r.status === 201);
    const refused = results.filter((r) => r.status !== 201);
    for (const r of refused) {
      expect(r.status).toBe(409);
      expect(r.body['error']).toBe('amount_exceeds_available');
      // The doctor is never told the balance (owner, پ۲).
      expect(Object.keys(r.body)).not.toContain('availableRial');
    }
    const reserved = ok.reduce((sum, r) => sum + BigInt(r.body['amountRial'] as string), 0n);
    const after = await balances(purseId);
    expect(after.availableRial).toBeGreaterThanOrEqual(0n);
    expect(after.reservedRial).toBe(reserved);
    expect(after.availableRial + after.reservedRial).toBe(12_000_000n);
    // Every line is at least 3,000,000: what is left fits none of the refused ones.
    expect(after.availableRial).toBeLessThan(3_000_000n);
    const { rows } = await h.owner.query<Row>(
      `SELECT count(*)::int AS n FROM purse_operations WHERE purse_id = $1 AND kind = 'reserve'`,
      [purseId],
    );
    expect(rows[0]).toEqual({ n: ok.length });
    await ledgerSound();
  });

  it('§9 test 9: a suspended center authorizes nothing new; one authorized before is still recorded (owner, پ۴)', async () => {
    // Its own world: the suspension stays.
    const w3 = await creditWorld(h);
    const f = await funded(w3);
    const before = await w3.staff(w3.doctor, 'POST', '/service/authorizations', {
      purseId: f.purseId,
      proformaLineIds: [f.lineIds[0]],
    });
    expect(before.status).toBe(201);
    const workplace = await h.app
      .get<WorkplaceDirectory>(WORKPLACE_DIRECTORY)
      .workplace(w3.workplaceId);
    const suspended = await w3.staff(
      w3.specialist,
      'POST',
      `/catalog/centers/${workplace?.centerId ?? ''}/suspend`,
      { reason: 'تعلیق آزمون' },
    );
    expect(suspended.body['status']).toBe('suspended');
    const refused = await w3.staff(w3.doctor, 'POST', '/service/authorizations', {
      purseId: f.purseId,
      proformaLineIds: [f.lineIds[1]],
    });
    expect(refused.status).toBe(409);
    expect(refused.body['error']).toBe('center_suspended');
    const list = await w3.staff(w3.doctor, 'GET', '/service/patients');
    expect(
      (list.body as unknown as Body[]).find((p) => p['purseId'] === f.purseId)?.['allowed'],
    ).toBe(false);
    const done = await w3.staff(
      w3.doctor,
      'POST',
      `/service/authorizations/${before.body['id'] as string}/deliver`,
      { code: lastCode(f.patient.mobile) },
    );
    expect(done.status).toBe(201);
    expect(done.body['status']).toBe('finalized');
    await ledgerSound();
  });
});

// --- ADR-046: a doctor's or center's contract term (owner 1405/07/27) ---------------------

describe("past the doctor's or center's contract term, no new service (ADR-046)", () => {
  async function term(value: unknown, level: 'doctor' | 'center', ref: string) {
    await h.owner.query(
      `INSERT INTO config_values (key, scope_level, scope_ref, value, effective_at, status, reason, decided_at)
       VALUES ('settlement.provider_contract', $1, $2, $3::jsonb, now(), 'approved', 'آزمون', now())`,
      [level, ref, JSON.stringify(value)],
    );
  }
  const daysAgo = (n: number) =>
    gregorianDayOf(toJalali(new Date(Date.now() - n * 24 * 60 * 60 * 1000)));

  it('ended: refused with its end day, nothing reserved; renewed, issued as ever', async () => {
    const f = await funded();
    const { rows } = await h.owner.query<Row>(
      'SELECT node_id, center_id FROM doctor_workplaces WHERE id = $1',
      [w.workplaceId],
    );
    const doctorNode = rows[0]?.['node_id'] as string;
    // Six months from about seven months ago: ended about a month ago.
    const ended = { startsOn: daysAgo(215), months: 6 } as const;
    await term(ended, 'doctor', doctorNode);
    const [visit] = f.lineIds;
    const refused = await issue(w.doctor, f.purseId, [visit ?? '']);
    expect(refused.status).toBe(409);
    expect(refused.body).toMatchObject({
      error: 'provider_contract_ended',
      endsOn: providerContractEndsOn(ended),
    });
    expect((await balances(f.purseId)).reservedRial).toBe(0n);
    // Renewed from today for twelve months: issued.
    await term({ startsOn: daysAgo(0), months: 12 }, 'doctor', doctorNode);
    const made = await issue(w.doctor, f.purseId, [visit ?? '']);
    expect(made.status, JSON.stringify(made.body)).toBe(201);
    expect(made.body).toMatchObject({ status: 'code_sent' });
    // The doctor's level removed (null: the level above): the center's, ended, holds it back.
    await term(null, 'doctor', doctorNode);
    const { rows: centers } = await h.owner.query<Row>(
      `SELECT center_node_id FROM service_authorizations WHERE id = $1`,
      [made.body['id']],
    );
    const centerNode = centers[0]?.['center_node_id'] as string;
    await term(ended, 'center', centerNode);
    const [, scaling] = f.lineIds;
    expect((await issue(w.doctor, f.purseId, [scaling ?? ''])).body['error']).toBe(
      'provider_contract_ended',
    );
    // Cleaned up for the tests after: the center's term ends far ahead.
    await term({ startsOn: daysAgo(0), months: 12 }, 'center', centerNode);
  });
});

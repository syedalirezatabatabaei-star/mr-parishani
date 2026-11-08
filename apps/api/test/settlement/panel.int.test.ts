import { createHash, randomUUID } from 'node:crypto';
import { NestFactory } from '@nestjs/core';
import type { INestApplicationContext } from '@nestjs/common';
import { gregorianDayOf, JALALI_MONTH_NAMES, toJalali } from '@sepehr/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CLI_ACTOR } from '../../src/common/auth/actor';
import { WORKPLACE_DIRECTORY } from '../../src/common/catalog/workplace-directory.port';
import { OBJECT_STORAGE, type ObjectStorage } from '../../src/common/storage/object-storage.port';
import { DATABASE, type Database } from '../../src/db/database.module';
import { SERVICE_SMS_SENDER } from '../../src/modules/service/service-authorization.service';
import { SettlementService } from '../../src/modules/settlement/settlement.service';
import { StatementPrinter } from '../../src/modules/settlement/statement-printer';
import { StatementService } from '../../src/modules/settlement/statement.service';
import { WorkerModule } from '../../src/worker.module';
import {
  CapturingTextSender,
  startHarness,
  type Harness,
  type loggedInAccount,
} from '../identity/harness';
import { fundingSteps } from '../credit/funding-steps';
import { CREDIT_HARNESS, creditWorld, type Body, type Row } from '../credit/world';

/**
 * Task 5-6 (doc 06 §5 step 6, §6; doc 14 ث): the doctor's settlement panel. A doctor sees
 * only their own statements, PDF, upcoming and held items (IDOR); a center only its sums; a
 * paid statement is printed by the worker, Jalali only, its hash kept, fetched by a signed
 * link.
 */

type Staff = Awaited<ReturnType<typeof loggedInAccount>>;
type World = Awaited<ReturnType<typeof creditWorld>>;

let h: Harness;
let manager: Staff;
let finance: Staff;
let finance2: Staff;
let worker: INestApplicationContext | undefined;
const texts = new CapturingTextSender();

beforeAll(async () => {
  h = await startHarness({ ...CREDIT_HARNESS, overrides: [[SERVICE_SMS_SENDER, texts]] });
  const first = await creditWorld(h);
  manager = await first.role('credit_manager');
  finance = await first.role('accounting');
  finance2 = await first.role('accounting');
  worker = await NestFactory.createApplicationContext(WorkerModule.forRoot({ relayLoop: false }), {
    logger: false,
  });
}, 180_000);

afterAll(async () => {
  await worker?.close();
  await h.close();
});

const settlement = () => h.app.get(SettlementService);
const statements = () => h.app.get(StatementService);

async function setRate(key: string, value: unknown) {
  await h.owner.query(
    `INSERT INTO config_values (key, scope_level, value, effective_at, status, reason, decided_at)
     VALUES ($1, 'global', $2, now(), 'approved', 'آزمون', now())`,
    [key, JSON.stringify(value)],
  );
}

const lastCode = (mobile: string) =>
  /(\d{6})\s*$/.exec([...texts.sent].reverse().find((t) => t.mobile === mobile)?.text ?? '')?.[1] ??
  '';

interface Item {
  payableId: string;
  doctorId: string;
  centerId: string;
  dueAt: Date;
  amount: bigint;
  fee: bigint;
}

/** A doctor of their own center, with one final service at a 10% fee (accrued, not due). */
async function doctorWithService() {
  const w = await creditWorld(h);
  const steps = fundingSteps(h, w, { manager, finance });
  const { patient, applicationId } = await steps.approved();
  await steps.complete(patient, applicationId);
  const purseId = await steps.fund(applicationId);
  const lines = (await w.staff(w.doctor, 'GET', `/service/patients/${purseId}/lines`)).body[
    'lines'
  ] as Body[];
  const made = await w.staff(w.doctor, 'POST', '/service/authorizations', {
    purseId,
    proformaLineIds: [lines[0]?.['id']],
  });
  // The rate in force when the service becomes final is the one locked on it (5-1).
  await setRate('settlement.credit_service_fee', { basis: 'percent', bps: 1000 });
  try {
    await w.staff(
      w.doctor,
      'POST',
      `/service/authorizations/${made.body['id'] as string}/deliver`,
      { code: lastCode(patient.mobile) },
    );
  } finally {
    await setRate('settlement.credit_service_fee', { basis: 'percent', bps: 0 });
  }
  const { payableId } = await settlement().accrue(CLI_ACTOR, made.body['id'] as string);
  const { rows } = await h.owner.query<Row>(
    `SELECT p.doctor_id, p.center_id, p.due_at, p.amount_rial::text AS amount,
            f.amount_rial::text AS fee
     FROM doctor_payables p JOIN service_fees f ON f.doctor_payable_id = p.id WHERE p.id = $1`,
    [payableId],
  );
  const r = rows[0] as Row;
  const item: Item = {
    payableId,
    doctorId: r['doctor_id'] as string,
    centerId: r['center_id'] as string,
    dueAt: r['due_at'] as Date,
    amount: BigInt(r['amount'] as string),
    fee: BigInt(r['fee'] as string),
  };
  return { w, item };
}

/** Drafted, reviewed, approved and paid by accounting: returns the statement. */
async function paid(w: World, item: Item) {
  await settlement().markDue(item.dueAt);
  const j = toJalali(item.dueAt);
  const id = (await statements().generateFor(CLI_ACTOR, item.doctorId, j.year, j.month))
    ?.statementId as string;
  await w.staff(finance, 'POST', `/settlement/statements/${id}/review`);
  await w.staff(finance2, 'POST', `/settlement/statements/${id}/approve`);
  const orders = (await w.staff(finance, 'GET', `/settlement/payouts?statementId=${id}`))
    .body as unknown as Body[];
  const order = (orders[0] as Body)['id'] as string;
  await w.staff(finance, 'POST', '/settlement/payouts/export', { payoutIds: [order] });
  await w.staff(finance, 'POST', `/settlement/payouts/${order}/tracking`, {
    bankTrackingRef: `TRK-${randomUUID().slice(0, 8)}`,
    paidOn: gregorianDayOf(toJalali(new Date())),
  });
  await w.staff(finance2, 'POST', `/settlement/payouts/${order}/confirm`);
  return id;
}

/** The worker's printer, with a renderer that keeps the HTML it was given. */
async function print(statementId: string) {
  let html = '';
  const pdf = Buffer.from(`%PDF-1.4\n% ${randomUUID()}\n%%EOF\n`);
  const printer = new StatementPrinter(
    { register: () => undefined },
    {
      render: (given: string) => {
        html = given;
        return Promise.resolve(pdf);
      },
    },
    h.app.get<ObjectStorage>(OBJECT_STORAGE),
    h.app.get(WORKPLACE_DIRECTORY),
  );
  await h.app.get<Database>(DATABASE).transaction((tx) =>
    printer.handle(
      {
        id: randomUUID(),
        type: 'settlement.statement_paid',
        aggregateType: 'settlement_statement',
        aggregateId: statementId,
        payload: { statementId, doctorId: randomUUID() },
        occurredAt: new Date().toISOString(),
      },
      tx,
    ),
  );
  return { html, sha256: createHash('sha256').update(pdf).digest('hex') };
}

describe("the doctor's settlement panel (task 5-6)", () => {
  it('IDOR: a doctor sees only their own; a center only the sums of its own doctors', async () => {
    const a = await doctorWithService();
    const b = await doctorWithService();
    const upcoming = async (w: World) =>
      (
        (await w.staff(w.doctor, 'GET', '/settlement/panel/upcoming')).body as unknown as Body[]
      ).map((i) => i['itemId']);
    expect(await upcoming(a.w)).toEqual([a.item.payableId]);
    expect(await upcoming(b.w)).toEqual([b.item.payableId]);
    const upcomingA = (await a.w.staff(a.w.doctor, 'GET', '/settlement/panel/upcoming'))
      .body as unknown as Body[];
    expect(upcomingA[0]).toMatchObject({
      kind: 'credit_service',
      subjectType: 'doctor_payable',
      amountRial: a.item.amount.toString(),
      feeRial: a.item.fee.toString(),
      status: 'accrued',
    });

    const id = await paid(a.w, a.item);
    const mine = await a.w.staff(a.w.doctor, 'GET', '/settlement/panel/statements');
    expect((mine.body as unknown as Body[]).map((s) => s['id'])).toEqual([id]);
    expect(
      (await a.w.staff(a.w.doctor, 'GET', `/settlement/panel/statements/${id}`)).body,
    ).toMatchObject({ status: 'paid', grossCreditServicesRial: a.item.amount.toString() });
    // B never sees A's: not listed, 404 on the statement and its PDF.
    expect((await b.w.staff(b.w.doctor, 'GET', '/settlement/panel/statements')).body).toEqual([]);
    for (const path of [
      `/settlement/panel/statements/${id}`,
      `/settlement/panel/statements/${id}/pdf`,
    ]) {
      expect((await b.w.staff(b.w.doctor, 'GET', path)).status).toBe(404);
    }
    // Nor dispute A's item.
    const theirs = await b.w.staff(b.w.doctor, 'POST', '/settlement/disputes', {
      subjectType: 'doctor_payable',
      subjectId: b.item.payableId === a.item.payableId ? randomUUID() : a.item.payableId,
      reason: 'اعتراض به قلم دیگری',
    });
    expect(theirs.status).toBe(404);

    // A center manager: the sums of its own doctors only, never a doctor's items.
    const node = async (centerId: string) =>
      (await h.owner.query<Row>('SELECT node_id FROM centers WHERE id = $1', [centerId])).rows[0]?.[
        'node_id'
      ] as string;
    const managerA = await a.w.role('center_manager', {
      kind: 'center',
      nodeId: await node(a.item.centerId),
    });
    const managerB = await b.w.role('center_manager', {
      kind: 'center',
      nodeId: await node(b.item.centerId),
    });
    expect((await a.w.staff(managerA, 'GET', '/settlement/panel/statements')).status).toBe(403);
    expect((await a.w.staff(managerA, 'GET', `/settlement/panel/statements/${id}`)).status).toBe(
      403,
    );
    const sums = (await a.w.staff(managerA, 'GET', '/settlement/panel/center-summary'))
      .body as unknown as Body[];
    expect(sums).toHaveLength(1);
    expect(sums[0]).toMatchObject({
      grossRial: a.item.amount.toString(),
      feesRial: a.item.fee.toString(),
      paidRial: (a.item.amount - a.item.fee).toString(),
      statementStatus: 'paid',
      providerName: 'دکتر اعتبار',
    });
    expect((await b.w.staff(managerB, 'GET', '/settlement/panel/center-summary')).body).toEqual([]);
  });

  it('a dispute from the panel: the item held with its dispute, back among the upcoming once rejected', async () => {
    const { w, item } = await doctorWithService();
    const opened = await w.staff(w.doctor, 'POST', '/settlement/disputes', {
      subjectType: 'doctor_payable',
      subjectId: item.payableId,
      reason: 'مبلغ این خدمت درست نیست',
    });
    expect(opened.status).toBe(201);
    expect((await w.staff(w.doctor, 'GET', '/settlement/panel/upcoming')).body).toEqual([]);
    const held = (await w.staff(w.doctor, 'GET', '/settlement/panel/held'))
      .body as unknown as Body[];
    expect(held).toEqual([
      expect.objectContaining({
        itemId: item.payableId,
        disputeId: opened.body['id'],
        disputeStatus: 'open',
      }),
    ]);
    // The doctor never decides it.
    expect(
      (
        await w.staff(
          w.doctor,
          'POST',
          `/settlement/disputes/${opened.body['id'] as string}/resolve`,
          {
            outcome: 'rejected',
            note: 'خودم',
          },
        )
      ).status,
    ).toBe(403);
    await w.staff(finance, 'POST', `/settlement/disputes/${opened.body['id'] as string}/resolve`, {
      outcome: 'rejected',
      note: 'بررسی شد',
    });
    expect((await w.staff(w.doctor, 'GET', '/settlement/panel/held')).body).toEqual([]);
    const back = (await w.staff(w.doctor, 'GET', '/settlement/panel/upcoming'))
      .body as unknown as Body[];
    expect(back.map((i) => i['itemId'])).toEqual([item.payableId]);
  });

  it('a paid statement printed: Jalali only, its hash kept, fetched by a signed link; none before', async () => {
    const { w, item } = await doctorWithService();
    await settlement().markDue(item.dueAt);
    const j = toJalali(item.dueAt);
    const draft = (await statements().generateFor(CLI_ACTOR, item.doctorId, j.year, j.month))
      ?.statementId as string;
    const early = await w.staff(w.doctor, 'GET', `/settlement/panel/statements/${draft}/pdf`);
    expect(early.status).toBe(409);
    expect(early.body['error']).toBe('pdf_not_ready');
    // Not paid yet: the printer leaves it.
    expect((await print(draft)).html).toBe('');

    await w.staff(finance, 'POST', `/settlement/statements/${draft}/review`);
    await w.staff(finance2, 'POST', `/settlement/statements/${draft}/approve`);
    const orders = (await w.staff(finance, 'GET', `/settlement/payouts?statementId=${draft}`))
      .body as unknown as Body[];
    const order = (orders[0] as Body)['id'] as string;
    await w.staff(finance, 'POST', '/settlement/payouts/export', { payoutIds: [order] });
    await w.staff(finance, 'POST', `/settlement/payouts/${order}/tracking`, {
      bankTrackingRef: 'TRK-PDF-0001',
      paidOn: gregorianDayOf(toJalali(new Date())),
    });
    await w.staff(finance2, 'POST', `/settlement/payouts/${order}/confirm`);

    const { html, sha256 } = await print(draft);
    expect(html).toContain(JALALI_MONTH_NAMES[j.month - 1] as string);
    expect(html).toContain('دکتر اعتبار');
    expect(html).toContain('TRK-PDF-0001');
    // Never a Gregorian date in the file (doc 14 ث): no ISO day, no Gregorian year.
    const text = html.replace(/<style>[\s\S]*?<\/style>/, '');
    expect(text).not.toMatch(/\b20\d\d-\d\d-\d\d\b/);
    expect(text).not.toMatch(/\b20[23]\d\b/);
    const { rows } = await h.owner.query<Row>(
      'SELECT pdf_hash FROM settlement_statements WHERE id = $1',
      [draft],
    );
    expect(rows[0]?.['pdf_hash']).toBe(sha256);
    // Printed once: again, nothing.
    expect((await print(draft)).html).toBe('');

    const link = await w.staff(w.doctor, 'GET', `/settlement/panel/statements/${draft}/pdf`);
    expect(link.status).toBe(200);
    expect(link.body).toMatchObject({ expiresInSeconds: 60 });
    expect(link.body['url'] as string).toContain(sha256.slice(0, 16));
    expect(
      (
        (await w.staff(w.doctor, 'GET', '/settlement/panel/statements')).body as unknown as Body[]
      )[0],
    ).toMatchObject({ id: draft, pdfReady: true });
  });
});

import { randomUUID } from 'node:crypto';
import type { INestApplicationContext } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { gregorianDayOf, statementPeriod, toJalali } from '@sepehr/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CLI_ACTOR } from '../../src/common/auth/actor';
import { LEDGER, type LedgerPort } from '../../src/common/ledger/ledger.port';
import { LedgerReconciliation } from '../../src/modules/ledger/reconciliation';
import { SERVICE_SMS_SENDER } from '../../src/modules/service/service-authorization.service';
import { SettlementReconciliation } from '../../src/modules/settlement/settlement-reconciliation';
import { SettlementService } from '../../src/modules/settlement/settlement.service';
import { StatementService, statementKey } from '../../src/modules/settlement/statement.service';
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
 * Task 5-4 [financial] (doc 06 §2, §8 tests 1, 3, 4, 5; doc 14 ب, پ; doc 02 §4): a doctor's
 * monthly statement. Its items are what fell due in the Jalali month; the fees, cash fees and
 * what was carried in are offset against the services in the ledger, as far as the services
 * go; what is left is carried to the next month. Made once; a draft is cancelled by two.
 */

type Staff = Awaited<ReturnType<typeof loggedInAccount>>;
type World = Awaited<ReturnType<typeof creditWorld>>;

let h: Harness;
let manager: Staff;
let finance: Staff;
let finance2: Staff;
let advisor: Staff;
let worker: INestApplicationContext | undefined;
const texts = new CapturingTextSender();

beforeAll(async () => {
  h = await startHarness({ ...CREDIT_HARNESS, overrides: [[SERVICE_SMS_SENDER, texts]] });
  const first = await creditWorld(h);
  manager = await first.role('credit_manager');
  finance = await first.role('accounting');
  finance2 = await first.role('accounting');
  advisor = await first.role('advisor');
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
const ledger = () => h.app.get<LedgerPort>(LEDGER);

async function setRate(key: string, value: unknown) {
  await h.owner.query(
    `INSERT INTO config_values (key, scope_level, value, effective_at, status, reason, decided_at)
     VALUES ($1, 'global', $2, now(), 'approved', 'آزمون', now())`,
    [key, JSON.stringify(value)],
  );
}
const ZERO = { basis: 'percent', bps: 0 };

/** Each test its own doctor, so its months hold only its own items. */
async function doctor() {
  const w = await creditWorld(h);
  return { w, steps: fundingSteps(h, w, { manager, finance }) };
}

const lastCode = (mobile: string) =>
  /(\d{6})\s*$/.exec([...texts.sent].reverse().find((t) => t.mobile === mobile)?.text ?? '')?.[1] ??
  '';

interface Item {
  payableId: string;
  feeId: string;
  amount: bigint;
  fee: bigint;
  doctorId: string;
  doctorNodeId: string;
  dueAt: Date;
}

/** A funded purse, one service final, its payable and fee made and due. */
async function service(d: Awaited<ReturnType<typeof doctor>>): Promise<Item> {
  const { patient, applicationId } = await d.steps.approved();
  await d.steps.complete(patient, applicationId);
  const purseId = await d.steps.fund(applicationId);
  const lines = (await d.w.staff(d.w.doctor, 'GET', `/service/patients/${purseId}/lines`)).body[
    'lines'
  ] as Body[];
  const made = await d.w.staff(d.w.doctor, 'POST', '/service/authorizations', {
    purseId,
    proformaLineIds: [lines[0]?.['id']],
  });
  const done = await d.w.staff(
    d.w.doctor,
    'POST',
    `/service/authorizations/${made.body['id'] as string}/deliver`,
    { code: lastCode(patient.mobile) },
  );
  expect(done.body['status']).toBe('finalized');
  const { payableId } = await settlement().accrue(CLI_ACTOR, made.body['id'] as string);
  const { rows } = await h.owner.query<Row>(
    `SELECT p.doctor_id, p.doctor_node_id, p.amount_rial::text AS amount, p.due_at,
            f.id AS fee_id, f.amount_rial::text AS fee
     FROM doctor_payables p JOIN service_fees f ON f.doctor_payable_id = p.id WHERE p.id = $1`,
    [payableId],
  );
  const r = rows[0] as Row;
  const dueAt = r['due_at'] as Date;
  await settlement().markDue(dueAt);
  return {
    payableId,
    feeId: r['fee_id'] as string,
    amount: BigInt(r['amount'] as string),
    fee: BigInt(r['fee'] as string),
    doctorId: r['doctor_id'] as string,
    doctorNodeId: r['doctor_node_id'] as string,
    dueAt,
  };
}

/** A cash service the doctor declares (confirmed at once, with its fee). */
async function cash(w: World) {
  const { patient } = await w.inReview();
  const { rows } = await h.owner.query<Row>(
    `SELECT r.id FROM referrals r JOIN user_accounts a ON a.person_id = r.person_id
     WHERE a.id = $1 ORDER BY r.referred_at DESC LIMIT 1`,
    [patient.id],
  );
  const made = await w.staff(w.doctor, 'POST', '/settlement/cash-services', {
    referralId: rows[0]?.['id'],
    serviceDate: gregorianDayOf(toJalali(new Date())),
    amountRial: '4000000',
    idempotencyKey: `cash-${randomUUID()}`,
  });
  expect(made.status).toBe(201);
  const fee = made.body['fee'] as Body;
  const due = await h.owner.query<Row>('SELECT due_at FROM service_fees WHERE id = $1', [
    fee['id'],
  ]);
  await settlement().markDue(due.rows[0]?.['due_at'] as Date);
  return { feeId: fee['id'] as string, fee: BigInt(fee['amountRial'] as string) };
}

const monthOf = (at: Date) => {
  const j = toJalali(at);
  return { year: j.year, month: j.month };
};
const next = (p: { year: number; month: number }) =>
  p.month === 12 ? { year: p.year + 1, month: 1 } : { year: p.year, month: p.month + 1 };
const previous = (p: { year: number; month: number }) =>
  p.month === 1 ? { year: p.year - 1, month: 12 } : { year: p.year, month: p.month - 1 };

const generate = (doctorId: string, p: { year: number; month: number }) =>
  statements().generateFor(CLI_ACTOR, doctorId, p.year, p.month);

async function statement(id: string) {
  const { rows } = await h.owner.query<Row>(
    `SELECT status, gross_credit_services_rial::text AS gross, credit_fees_rial::text AS credit_fees,
            cash_fees_rial::text AS cash_fees, carried_in_rial::text AS carried_in,
            payable_rial::text AS payable, carried_out_rial::text AS carried_out,
            offset_rial::text AS offset, offset_journal_entry_id, previous_statement_id
     FROM settlement_statements WHERE id = $1`,
    [id],
  );
  return rows[0] as Row;
}

async function linesOf(id: string) {
  const { rows } = await h.owner.query<Row>(
    `SELECT line_type, ref_id, amount_rial::text AS amount FROM settlement_statement_lines
     WHERE statement_id = $1 ORDER BY line_type, ref_id`,
    [id],
  );
  return rows.map((r) => ({
    type: r['line_type'] as string,
    ref: r['ref_id'] as string,
    amount: r['amount'] as string,
  }));
}

async function balanceOf(code: 'doctor.payable' | 'doctor.fee_receivable', node: string) {
  const account = await ledger().findAccount({
    entityId: 'aramesh',
    code,
    ownerType: 'doctor',
    ownerId: node,
  });
  if (!account) return 0n;
  const b = await ledger().balanceOf(account.id);
  return code === 'doctor.payable' ? b.creditRial - b.debitRial : b.debitRial - b.creditRial;
}

async function itemState(table: 'doctor_payables' | 'service_fees', id: string) {
  const { rows } = await h.owner.query<Row>(
    `SELECT status, statement_id FROM ${table} WHERE id = $1`,
    [id],
  );
  return rows[0];
}

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

describe("a doctor's monthly statement (task 5-4)", () => {
  it('doc 06 test 1 and 5: an item comes in the month it falls due, not before; lines = ledger', async () => {
    await setRate('settlement.credit_service_fee', { basis: 'percent', bps: 1000 });
    const d = await doctor();
    let a: Item;
    let b: Item;
    try {
      a = await service(d);
      await setRate('settlement.contract_cycle_months', 2);
      b = await service(d);
    } finally {
      await setRate('settlement.contract_cycle_months', 1);
      await setRate('settlement.credit_service_fee', ZERO);
    }
    const pa = monthOf(a.dueAt);
    const pb = monthOf(b.dueAt);
    expect(pb).toEqual(next(pa));
    expect(a.fee).toBe(a.amount / 10n);

    // Not before: the month before it fell due has nothing.
    expect(await generate(a.doctorId, previous(pa))).toBeNull();

    const first = await generate(a.doctorId, pa);
    expect(first?.created).toBe(true);
    const s1 = await statement(first?.statementId as string);
    expect(s1).toMatchObject({
      status: 'draft',
      gross: a.amount.toString(),
      credit_fees: a.fee.toString(),
      cash_fees: '0',
      carried_in: '0',
      payable: (a.amount - a.fee).toString(),
      carried_out: '0',
      offset: a.fee.toString(),
    });
    expect(await linesOf(first?.statementId as string)).toEqual(
      [
        { type: 'credit_fee', ref: a.feeId, amount: a.fee.toString() },
        { type: 'credit_service', ref: a.payableId, amount: a.amount.toString() },
        { type: 'offset_fee', ref: a.doctorNodeId, amount: a.fee.toString() },
        { type: 'offset_payable', ref: a.doctorNodeId, amount: a.fee.toString() },
      ].sort((x, y) => x.type.localeCompare(y.type)),
    );
    expect(await itemState('doctor_payables', a.payableId)).toEqual({
      status: 'in_statement',
      statement_id: first?.statementId,
    });
    expect(await itemState('doctor_payables', b.payableId)).toMatchObject({ status: 'due' });

    // The offset's document, exactly the statement's lines (doc 06 test 5).
    const { rows: entries } = await h.owner.query<Row>(
      `SELECT a.code, e.direction, e.amount_rial::text AS amount
       FROM ledger_entries e JOIN ledger_accounts a ON a.id = e.account_id
       WHERE e.journal_entry_id = $1 ORDER BY a.code`,
      [s1['offset_journal_entry_id']],
    );
    expect(entries).toEqual([
      { code: 'doctor.fee_receivable', direction: 'credit', amount: a.fee.toString() },
      { code: 'doctor.payable', direction: 'debit', amount: a.fee.toString() },
    ]);
    const { rows: keyed } = await h.owner.query<Row>(
      'SELECT id FROM journal_entries WHERE idempotency_key = $1',
      [statementKey(first?.statementId as string, 'offset')],
    );
    expect(keyed.map((r) => r['id'])).toEqual([s1['offset_journal_entry_id']]);

    const second = await generate(a.doctorId, pb);
    const s2 = await statement(second?.statementId as string);
    expect(s2).toMatchObject({
      gross: b.amount.toString(),
      credit_fees: b.fee.toString(),
      previous_statement_id: first?.statementId,
    });
    // What is left owed to the doctor: the services less their fees; no fee left owed.
    expect(await balanceOf('doctor.payable', a.doctorNodeId)).toBe(
      a.amount - a.fee + b.amount - b.fee,
    );
    expect(await balanceOf('doctor.fee_receivable', a.doctorNodeId)).toBe(0n);
    await sound();
  });

  it('doc 06 test 3: a negative statement pays nothing; it carries to the next, offset only as far as services go', async () => {
    const d = await doctor();
    const a = await service(d);
    const owed = a.amount + 1_000_000n;
    await setRate('settlement.cash_service_fee', { basis: 'fixed', rial: owed.toString() });
    let c: { feeId: string; fee: bigint };
    try {
      c = await cash(d.w);
    } finally {
      await setRate('settlement.cash_service_fee', ZERO);
    }
    expect(c.fee).toBe(owed);
    const p = monthOf(a.dueAt);
    const s1 = (await generate(a.doctorId, p)) as { statementId: string };
    expect(await statement(s1.statementId)).toMatchObject({
      gross: a.amount.toString(),
      cash_fees: owed.toString(),
      payable: '-1000000',
      carried_out: '1000000',
      offset: a.amount.toString(),
    });
    expect(await linesOf(s1.statementId)).toContainEqual({
      type: 'carried_out',
      ref: a.doctorNodeId,
      amount: '1000000',
    });
    // Nothing owed to the doctor; the rest of the fee still owed by them.
    expect(await balanceOf('doctor.payable', a.doctorNodeId)).toBe(0n);
    expect(await balanceOf('doctor.fee_receivable', a.doctorNodeId)).toBe(1_000_000n);
    await sound();

    // Next month: what was carried comes in first.
    await setRate('settlement.contract_cycle_months', 2);
    let b: Item;
    try {
      b = await service(d);
    } finally {
      await setRate('settlement.contract_cycle_months', 1);
    }
    const s2 = (await generate(a.doctorId, next(p))) as { statementId: string };
    expect(await statement(s2.statementId)).toMatchObject({
      gross: b.amount.toString(),
      carried_in: '1000000',
      payable: (b.amount - 1_000_000n).toString(),
      carried_out: '0',
      offset: '1000000',
      previous_statement_id: s1.statementId,
    });
    expect(await balanceOf('doctor.payable', a.doctorNodeId)).toBe(b.amount - 1_000_000n);
    expect(await balanceOf('doctor.fee_receivable', a.doctorNodeId)).toBe(0n);
    await sound();
  });

  it('doc 06 test 4: an item under dispute stays out; once rejected, it comes in the next statement', async () => {
    const d = await doctor();
    const a = await service(d);
    const b = await service(d);
    const opened = await d.w.staff(finance, 'POST', '/settlement/disputes', {
      subjectType: 'doctor_payable',
      subjectId: b.payableId,
      reason: 'پزشک به این قلم اعتراض دارد',
    });
    expect(opened.status).toBe(201);
    const p = monthOf(a.dueAt);
    const s1 = (await generate(a.doctorId, p)) as { statementId: string };
    const refs = (await linesOf(s1.statementId)).map((l) => l.ref);
    expect(refs).toContain(a.payableId);
    expect(refs).not.toContain(b.payableId);
    expect(await itemState('doctor_payables', b.payableId)).toMatchObject({ status: 'on_hold' });

    const rejected = await d.w.staff(
      finance2,
      'POST',
      `/settlement/disputes/${opened.body['id'] as string}/resolve`,
      { outcome: 'rejected', note: 'بررسی شد' },
    );
    expect(rejected.status).toBe(201);
    expect(await itemState('doctor_payables', b.payableId)).toMatchObject({ status: 'due' });
    // The month's statement is made once; it is not changed.
    expect(await generate(a.doctorId, p)).toEqual({ statementId: s1.statementId, created: false });
    expect((await linesOf(s1.statementId)).map((l) => l.ref)).not.toContain(b.payableId);
    const s2 = (await generate(a.doctorId, next(p))) as { statementId: string };
    expect((await linesOf(s2.statementId)).map((l) => l.ref)).toContain(b.payableId);
    expect(await statement(s2.statementId)).toMatchObject({ gross: b.amount.toString() });
    await sound();
  });

  it('made once: run again, or twice at the same time, one statement and one document', async () => {
    await setRate('settlement.credit_service_fee', { basis: 'percent', bps: 500 });
    const d = await doctor();
    let a: Item;
    try {
      a = await service(d);
    } finally {
      await setRate('settlement.credit_service_fee', ZERO);
    }
    const p = monthOf(a.dueAt);
    const both = await Promise.all([generate(a.doctorId, p), generate(a.doctorId, p)]);
    expect(both.map((x) => x?.created).sort()).toEqual([false, true]);
    expect(both[0]?.statementId).toBe(both[1]?.statementId);
    const { rows } = await h.owner.query<Row>(
      `SELECT count(*)::int AS n FROM settlement_statements
       WHERE doctor_id = $1 AND period_year = $2 AND period_month = $3`,
      [a.doctorId, p.year, p.month],
    );
    expect(rows[0]?.['n']).toBe(1);
    const { rows: docs } = await h.owner.query<Row>(
      `SELECT count(*)::int AS n FROM journal_entries WHERE event_type = 'settlement.statement_offset'
         AND idempotency_key = $1`,
      [statementKey(both[0]?.statementId as string, 'offset')],
    );
    expect(docs[0]?.['n']).toBe(1);

    // The monthly run, once the month is over: nothing more for this doctor; nor run again.
    const after = new Date(statementPeriod(p.year, p.month).end.getTime() + 3_600_000);
    const run1 = await statements().generateMonth(CLI_ACTOR, p.year, p.month, after);
    const run2 = await statements().generateMonth(CLI_ACTOR, p.year, p.month, after);
    expect(run1.failed).toBe(0);
    expect(run2).toMatchObject({ made: 0, failed: 0 });
    const { rows: again } = await h.owner.query<Row>(
      `SELECT count(*)::int AS n FROM settlement_statements
       WHERE doctor_id = $1 AND period_year = $2 AND period_month = $3`,
      [a.doctorId, p.year, p.month],
    );
    expect(again[0]?.['n']).toBe(1);
    // A month not over yet is not drafted.
    await expect(
      statements().generateMonth(CLI_ACTOR, p.year, p.month, new Date(after.getTime() - 7_200_000)),
    ).rejects.toMatchObject({ response: { error: 'period_not_over' } });
    await sound();
  });

  it('a draft cancelled by two people: the offset reversed exactly, its items due again, the month made again', async () => {
    await setRate('settlement.credit_service_fee', { basis: 'percent', bps: 1000 });
    const d = await doctor();
    let a: Item;
    try {
      a = await service(d);
    } finally {
      await setRate('settlement.credit_service_fee', ZERO);
    }
    const p = monthOf(a.dueAt);
    const made = (await generate(a.doctorId, p)) as { statementId: string };
    const id = made.statementId;
    const offset = (await statement(id))['offset_journal_entry_id'] as string;

    // Read by accounting only.
    const read = await d.w.staff(finance, 'GET', `/settlement/statements/${id}`);
    expect(read.status).toBe(200);
    expect(read.body).toMatchObject({ status: 'draft', offsetRial: a.fee.toString() });
    const listed = await d.w.staff(finance, 'GET', `/settlement/statements?doctorId=${a.doctorId}`);
    expect((listed.body as unknown as Body[]).map((s) => s['id'])).toEqual([id]);
    expect((await d.w.staff(advisor, 'GET', `/settlement/statements/${id}`)).status).toBe(403);
    const cancel = (who: Staff) =>
      d.w.staff(who, 'POST', `/settlement/statements/${id}/cancel`, {
        reason: 'قلمی دیر به اختلاف خورد',
      });
    expect((await cancel(advisor)).status).toBe(403);

    // Asked by one: still a draft; asking again changes nothing.
    const asked = await cancel(finance);
    expect(asked.status).toBe(201);
    expect(asked.body).toMatchObject({ status: 'draft', cancelRequestedByMe: true });
    expect((await cancel(finance)).body).toMatchObject({ status: 'draft' });
    const before = await balanceOf('doctor.payable', a.doctorNodeId);

    // Done by another.
    const done = await cancel(finance2);
    expect(done.body).toMatchObject({ status: 'cancelled', cancelRequestedByMe: false });
    const { rows } = await h.owner.query<Row>(
      `SELECT cancel_journal_entry_id FROM settlement_statements WHERE id = $1`,
      [id],
    );
    const reversal = rows[0]?.['cancel_journal_entry_id'] as string;
    const sides = async (journal: string) =>
      (
        await h.owner.query<Row>(
          `SELECT account_id, direction, amount_rial::text AS amount FROM ledger_entries
           WHERE journal_entry_id = $1 ORDER BY account_id`,
          [journal],
        )
      ).rows;
    const flip = (r: Row) => ({
      ...r,
      direction: r['direction'] === 'debit' ? 'credit' : 'debit',
    });
    expect(await sides(reversal)).toEqual((await sides(offset)).map(flip));
    expect(await balanceOf('doctor.payable', a.doctorNodeId)).toBe(before + a.fee);
    expect(await balanceOf('doctor.fee_receivable', a.doctorNodeId)).toBe(a.fee);
    expect(await itemState('doctor_payables', a.payableId)).toEqual({
      status: 'due',
      statement_id: null,
    });
    expect(await itemState('service_fees', a.feeId)).toEqual({ status: 'due', statement_id: null });
    // Cancelled again: nothing more.
    expect((await cancel(finance2)).body).toMatchObject({ status: 'cancelled' });
    await sound();

    const again = await generate(a.doctorId, p);
    expect(again?.created).toBe(true);
    expect(again?.statementId).not.toBe(id);
    expect(await statement(again?.statementId as string)).toMatchObject({
      gross: a.amount.toString(),
      offset: a.fee.toString(),
      previous_statement_id: null,
    });
    await sound();
  });

  it('a doctor with only a cash fee: nothing to offset, the whole fee carried', async () => {
    const d = await doctor();
    await setRate('settlement.cash_service_fee', { basis: 'percent', bps: 1000 });
    let c: { feeId: string; fee: bigint };
    try {
      c = await cash(d.w);
    } finally {
      await setRate('settlement.cash_service_fee', ZERO);
    }
    expect(c.fee).toBe(400_000n);
    const { rows } = await h.owner.query<Row>(
      'SELECT doctor_id, doctor_node_id, due_at FROM service_fees WHERE id = $1',
      [c.feeId],
    );
    const r = rows[0] as Row;
    const made = (await generate(r['doctor_id'] as string, monthOf(r['due_at'] as Date))) as {
      statementId: string;
    };
    expect(await statement(made.statementId)).toMatchObject({
      gross: '0',
      cash_fees: '400000',
      payable: '-400000',
      carried_out: '400000',
      offset: '0',
      offset_journal_entry_id: null,
    });
    expect(await linesOf(made.statementId)).toEqual([
      { type: 'carried_out', ref: r['doctor_node_id'], amount: '400000' },
      { type: 'cash_fee', ref: c.feeId, amount: '400000' },
    ]);
    expect(await itemState('service_fees', c.feeId)).toMatchObject({ status: 'in_statement' });
    expect(await balanceOf('doctor.fee_receivable', r['doctor_node_id'] as string)).toBe(400_000n);
    await sound();
  });

  it('the database keeps it: amounts fixed, lines append-only, paths only, cancelled by another', async () => {
    const { rows } = await h.owner.query<Row>(
      "SELECT id FROM settlement_statements WHERE status = 'draft' LIMIT 1",
    );
    expect(rows).toHaveLength(1);
    const id = rows[0]?.['id'] as string;
    await expect(
      h.owner.query(
        'UPDATE settlement_statements SET payable_rial = payable_rial + 1 WHERE id = $1',
        [id],
      ),
    ).rejects.toThrow(/keeps its doctor, period and amounts/);
    await expect(
      h.owner.query("UPDATE settlement_statements SET status = 'paid' WHERE id = $1", [id]),
    ).rejects.toThrow(/cannot go from draft to paid/);
    await expect(
      h.owner.query(
        'UPDATE settlement_statement_lines SET amount_rial = 0 WHERE statement_id = $1',
        [id],
      ),
    ).rejects.toThrow();
    await expect(
      h.owner.query('DELETE FROM settlement_statements WHERE id = $1', [id]),
    ).rejects.toThrow();
    const someone = randomUUID();
    await expect(
      h.owner.query(
        `UPDATE settlement_statements SET status = 'cancelled', cancel_requested_by = $2,
           cancelled_by = $2, cancelled_at = now() WHERE id = $1`,
        [id, someone],
      ),
    ).rejects.toThrow(/settlement_statements_cancel_check/);
  });
});

import type { INestApplicationContext } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CLI_ACTOR } from '../../src/common/auth/actor';
import { LedgerReconciliation } from '../../src/modules/ledger/reconciliation';
import { SERVICE_SMS_SENDER } from '../../src/modules/service/service-authorization.service';
import { correctionKey } from '../../src/modules/settlement/dispute.service';
import { SettlementReconciliation } from '../../src/modules/settlement/settlement-reconciliation';
import { SettlementService } from '../../src/modules/settlement/settlement.service';
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
 * Task 5-2 [financial] (doc 14 5-2; doc 06 §4, §8 test 4; doc 02 §8 test 7; owner 1405/07/14):
 * a dispute holds a doctor's payable and its fee out of every payment; one live dispute per
 * item; never decided by who opened it. Rejected: back where they were. Accepted on a fee:
 * its document reversed whole, once. Accepted on a payable: accepted_pending_posting only;
 * both stay held and nothing is posted (5-2b).
 */

type Staff = Awaited<ReturnType<typeof loggedInAccount>>;

let h: Harness;
let w: Awaited<ReturnType<typeof creditWorld>>;
let finance: Staff;
let finance2: Staff;
let support: Staff;
let steps: ReturnType<typeof fundingSteps>;
let worker: INestApplicationContext | undefined;
const texts = new CapturingTextSender();

beforeAll(async () => {
  h = await startHarness({ ...CREDIT_HARNESS, overrides: [[SERVICE_SMS_SENDER, texts]] });
  w = await creditWorld(h);
  const manager = await w.role('credit_manager');
  finance = await w.role('accounting');
  finance2 = await w.role('accounting');
  support = await w.role('support');
  steps = fundingSteps(h, w, { manager, finance });
  worker = await NestFactory.createApplicationContext(WorkerModule.forRoot({ relayLoop: false }), {
    logger: false,
  });
  // A fee above 0, so an accepted dispute has a document to reverse.
  await h.owner.query(
    `INSERT INTO config_values (key, scope_level, value, effective_at, status, reason, decided_at)
     VALUES ('settlement.credit_service_fee', 'global', '{"basis":"percent","bps":1000}', now(), 'approved', 'آزمون', now())`,
  );
}, 180_000);

afterAll(async () => {
  await worker?.close();
  await h.close();
});

const settlement = () => h.app.get(SettlementService);

const lastCode = (mobile: string) =>
  /(\d{6})\s*$/.exec([...texts.sent].reverse().find((t) => t.mobile === mobile)?.text ?? '')?.[1] ??
  '';

/** A funded purse, one service final, its payable and fee made; optionally already due. */
async function heldReady(due: boolean) {
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
  await w.staff(w.doctor, 'POST', `/service/authorizations/${made.body['id'] as string}/deliver`, {
    code: lastCode(patient.mobile),
  });
  const { payableId } = await settlement().accrue(CLI_ACTOR, made.body['id'] as string);
  if (due) {
    const { rows } = await h.owner.query<Row>('SELECT due_at FROM doctor_payables WHERE id = $1', [
      payableId,
    ]);
    await settlement().markDue(rows[0]?.['due_at'] as Date);
  }
  const { rows } = await h.owner.query<Row>(
    `SELECT p.doctor_node_id, f.id AS fee_id, f.journal_entry_id AS fee_journal,
            f.amount_rial::text AS fee
     FROM doctor_payables p JOIN service_fees f ON f.doctor_payable_id = p.id WHERE p.id = $1`,
    [payableId],
  );
  const r = rows[0] as Row;
  return {
    payableId,
    feeId: r['fee_id'] as string,
    feeJournal: r['fee_journal'] as string,
    fee: BigInt(r['fee'] as string),
    doctorNodeId: r['doctor_node_id'] as string,
  };
}

async function statusOf(payableId: string) {
  const { rows } = await h.owner.query<Row>(
    `SELECT p.status AS payable, f.status AS fee, p.statement_id
     FROM doctor_payables p JOIN service_fees f ON f.doctor_payable_id = p.id WHERE p.id = $1`,
    [payableId],
  );
  return rows[0];
}

const open = (who: Staff, subjectType: string, subjectId: string) =>
  w.staff(who, 'POST', '/settlement/disputes', {
    subjectType,
    subjectId,
    reason: 'پزشک به این قلم اعتراض دارد',
  });
const resolve = (who: Staff, id: string, outcome: 'accepted' | 'rejected') =>
  w.staff(who, 'POST', `/settlement/disputes/${id}/resolve`, { outcome, note: 'بررسی شد' });

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

describe('financial disputes and holding an item (task 5-2)', () => {
  it('holds the payable and its fee out of every payment; one live dispute per item', async () => {
    const item = await heldReady(true);
    expect((await settlement().payableItems(item.doctorNodeId)).payables).toContain(item.payableId);
    const opened = await open(support, 'doctor_payable', item.payableId);
    expect(opened.status).toBe(201);
    expect(opened.body['items']).toHaveLength(2);
    expect(await statusOf(item.payableId)).toMatchObject({ payable: 'on_hold', fee: 'on_hold' });
    // Doc 02 §8 test 7: out of what may be paid.
    const queue = await settlement().payableItems(item.doctorNodeId);
    expect(queue.payables).not.toContain(item.payableId);
    expect(queue.fees).not.toContain(item.feeId);
    // One live dispute per item, by either of them.
    expect((await open(finance, 'doctor_payable', item.payableId)).body['error']).toBe(
      'dispute_open',
    );
    expect((await open(finance, 'service_fee', item.feeId)).body['error']).toBe('dispute_open');
    await sound();
  });

  it('never decided by who opened it; rejected, each item goes back where it was', async () => {
    const item = await heldReady(true);
    const opened = await open(finance, 'service_fee', item.feeId);
    const id = opened.body['id'] as string;
    expect((await resolve(finance, id, 'rejected')).body['error']).toBe('same_person');
    expect((await resolve(support, id, 'rejected')).status).toBe(403);
    const done = await resolve(finance2, id, 'rejected');
    expect(done.body['status']).toBe('resolved_rejected');
    expect(await statusOf(item.payableId)).toMatchObject({ payable: 'due', fee: 'due' });
    expect((await settlement().payableItems(item.doctorNodeId)).payables).toContain(item.payableId);
    // Accrued before: accrued again (not yet due).
    const early = await heldReady(false);
    const second = await open(finance, 'doctor_payable', early.payableId);
    await resolve(finance2, second.body['id'] as string, 'rejected');
    expect(await statusOf(early.payableId)).toMatchObject({ payable: 'accrued', fee: 'accrued' });
    // Rejecting again changes nothing.
    expect((await resolve(finance2, second.body['id'] as string, 'rejected')).status).toBe(201);
    await sound();
  });

  it('accepted on a fee: its document reversed exactly, once; the payable back where it was', async () => {
    const item = await heldReady(true);
    expect(item.fee).toBeGreaterThan(0n);
    const opened = await open(finance, 'service_fee', item.feeId);
    const id = opened.body['id'] as string;
    const done = await resolve(finance2, id, 'accepted');
    expect(done.body).toMatchObject({ status: 'resolved_accepted' });
    const correction = done.body['correctionJournalEntryId'] as string;
    expect(correction).toBeTruthy();
    // The exact opposite of the fee's document, line by line (doc 02 §8 test 8).
    const lines = async (journal: string) =>
      (
        await h.owner.query<Row>(
          `SELECT account_id, direction, amount_rial::text AS amount FROM ledger_entries
           WHERE journal_entry_id = $1 ORDER BY account_id, direction`,
          [journal],
        )
      ).rows;
    const original = await lines(item.feeJournal);
    const reversed = await lines(correction);
    expect(reversed).toEqual(
      original
        .map((l): Row => ({ ...l, direction: l['direction'] === 'debit' ? 'credit' : 'debit' }))
        .sort((a, b) =>
          `${String(a['account_id'])}${String(a['direction'])}`.localeCompare(
            `${String(b['account_id'])}${String(b['direction'])}`,
          ),
        ),
    );
    expect(await statusOf(item.payableId)).toMatchObject({ payable: 'due', fee: 'reversed' });
    // Accepting again posts nothing more.
    const again = await resolve(finance2, id, 'accepted');
    expect(again.body['correctionJournalEntryId']).toBe(correction);
    const { rows } = await h.owner.query<Row>(
      'SELECT count(*)::int AS n FROM journal_entries WHERE idempotency_key = $1',
      [correctionKey(id)],
    );
    expect(rows[0]?.['n']).toBe(1);
    // A reversed fee is held no more.
    expect((await open(finance, 'service_fee', item.feeId)).body['error']).toBe('not_holdable');
    await sound();
  });

  it('accepted on a payable: pending its posting, both still held, nothing posted (5-2b)', async () => {
    const item = await heldReady(true);
    const opened = await open(finance, 'doctor_payable', item.payableId);
    const before = await h.owner.query<Row>('SELECT count(*)::int AS n FROM journal_entries');
    const done = await resolve(finance2, opened.body['id'] as string, 'accepted');
    expect(done.body).toMatchObject({
      status: 'accepted_pending_posting',
      correctionJournalEntryId: null,
    });
    const after = await h.owner.query<Row>('SELECT count(*)::int AS n FROM journal_entries');
    expect(after.rows[0]?.['n']).toBe(before.rows[0]?.['n']);
    expect(await statusOf(item.payableId)).toMatchObject({ payable: 'on_hold', fee: 'on_hold' });
    const queue = await settlement().payableItems(item.doctorNodeId);
    expect(queue.payables).not.toContain(item.payableId);
    expect(queue.fees).not.toContain(item.feeId);
    // Still the one live dispute on it.
    expect((await open(support, 'doctor_payable', item.payableId)).body['error']).toBe(
      'dispute_open',
    );
    await sound();
  });

  it('the database keeps a dispute to its paths, and its opener off its decision', async () => {
    const item = await heldReady(false);
    const opened = await open(finance, 'doctor_payable', item.payableId);
    const id = opened.body['id'] as string;
    await expect(
      h.owner.query(
        `UPDATE financial_disputes SET status = 'resolved_rejected', resolved_by = opened_by,
           resolved_at = now(), resolution_note = 'x' WHERE id = $1`,
        [id],
      ),
    ).rejects.toThrow();
    await expect(
      h.owner.query(`UPDATE financial_disputes SET subject_id = gen_random_uuid() WHERE id = $1`, [
        id,
      ]),
    ).rejects.toThrow();
  });
});

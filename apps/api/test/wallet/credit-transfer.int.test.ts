import { randomUUID } from 'node:crypto';
import type { INestApplicationContext } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { sql, type SQL } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { WORKPLACE_DIRECTORY } from '../../src/common/catalog/workplace-directory.port';
import { CREDIT_CONTRACT_FACTS } from '../../src/common/credit/credit-contract-facts.port';
import { PROFORMA_DIRECTORY } from '../../src/common/proforma/proforma-directory.port';
import { WALLET, type WalletPort } from '../../src/common/wallet/wallet.port';
import { DATABASE, type Database } from '../../src/db/database.module';
import { DownPaymentReconciliation } from '../../src/modules/contract/down-payment-reconciliation';
import { LedgerReconciliation } from '../../src/modules/ledger/reconciliation';
import { DoctorPatientsProjector } from '../../src/modules/service/doctor-patients.projector';
import { SERVICE_SMS_SENDER } from '../../src/modules/service/service-authorization.service';
import { WorkerModule } from '../../src/worker.module';
import { nationalId } from '../catalog/fixtures';
import {
  CapturingTextSender,
  newMobile,
  startHarness,
  type Harness,
  type loggedInAccount,
} from '../identity/harness';
import { fundingSteps } from '../credit/funding-steps';
import { CREDIT_HARNESS, creditWorld, type Body, type Row } from '../credit/world';

/**
 * Task 4-8 [financial], part 5 (doc 12 §7, §9 test 11; owner 1405/07/14, س۳ to س۹): a
 * credit transfer to an AuthorizedRecipient. Asked with a code to the recipient and one to
 * the borrower, approved by another person in accounting; no ledger entry, the debt stays
 * with the borrower; the service codes go to the recipient, up to the transfer's amount;
 * revoked by the borrower at once or by two people in finance. Behind its flag.
 */

type Staff = Awaited<ReturnType<typeof loggedInAccount>>;

let h: Harness;
let w: Awaited<ReturnType<typeof creditWorld>>;
let finance: Staff;
let finance2: Staff;
let steps: ReturnType<typeof fundingSteps>;
let worker: INestApplicationContext | undefined;
const texts = new CapturingTextSender();

beforeAll(async () => {
  h = await startHarness({ ...CREDIT_HARNESS, overrides: [[SERVICE_SMS_SENDER, texts]] });
  w = await creditWorld(h);
  const manager = await w.role('credit_manager');
  finance = await w.role('accounting');
  finance2 = await w.role('accounting');
  steps = fundingSteps(h, w, { manager, finance });
  worker = await NestFactory.createApplicationContext(WorkerModule.forRoot({ relayLoop: false }), {
    logger: false,
  });
}, 180_000);

afterAll(async () => {
  await worker?.close();
  await h.close();
});

const wallet = () => h.app.get<WalletPort>(WALLET);

async function setConfig(key: string, value: unknown) {
  await h.owner.query(
    `INSERT INTO config_values (key, scope_level, value, effective_at, status, reason, decided_at)
     VALUES ($1, 'global', $2, now(), 'approved', 'آزمون', now())`,
    [key, JSON.stringify(value)],
  );
}

async function project(payload: Body) {
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
        aggregateType: 'test',
        aggregateId: randomUUID(),
        payload,
        occurredAt: new Date().toISOString(),
      },
      tx,
    ),
  );
}

async function fundedPurse() {
  const { patient, applicationId } = await steps.approved();
  await steps.complete(patient, applicationId);
  const purseId = await steps.fund(applicationId);
  await project({ creditApplicationId: applicationId, purseId });
  return { patient, applicationId, purseId };
}

const ask = (who: Staff, purseId: string, recipient: Body, amountRial = '8000000') =>
  w.staff(who, 'POST', '/wallet/credit-transfers', {
    purseId,
    recipient,
    amountRial,
    reason: 'بیمار در سفر است و همسرش درمان را پیگیری می‌کند',
    // ADR-047: the number of the paper the borrower signed.
    paperDocumentNumber: 'P-1405-0001',
  });
/** ADR-047: approving a transfer says its signed paper was received. */
const decide = (who: Staff, path: string, reason = 'مدارک بررسی شد') =>
  w.staff(
    who,
    'POST',
    `/wallet/credit-transfers/${path}`,
    /^[^/]+\/approve$/.test(path) ? { reason, paperReceived: true } : { reason },
  );
const newRecipient = () => ({ name: 'مریم رضایی', nationalId: nationalId(), mobile: newMobile() });
const lastText = (mobile: string) =>
  [...texts.sent].reverse().find((t) => t.mobile === mobile)?.text ?? null;

/** Asked by `asker`, both codes entered: waiting for accounting. */
async function asked(asker: Staff, purseId: string, borrowerMobile: string, amountRial?: string) {
  const recipient = newRecipient();
  // One borrower asked again within the resend cooldown (as credit-scoring's tests do).
  await h.redis.del(`identity:challenge-cooldown:credit_transfer_consent:${borrowerMobile}`);
  const made = await ask(asker, purseId, recipient, amountRial);
  expect(made.status).toBe(201);
  expect(made.body).toMatchObject({
    status: 'awaiting_codes',
    recipientMobileLast4: recipient.mobile.slice(-4),
  });
  const coded = await w.staff(
    asker,
    'POST',
    `/wallet/credit-transfers/${made.body['id'] as string}/codes`,
    {
      recipientCode: h.sms.lastCodeFor(recipient.mobile),
      borrowerCode: h.sms.lastCodeFor(borrowerMobile),
    },
  );
  expect(coded.body['status']).toBe('requested');
  return { id: made.body['id'] as string, recipient };
}

async function ledgerSound() {
  const { rows } = await h.owner.query<Row>(
    `SELECT journal_entry_id FROM ledger_entries GROUP BY journal_entry_id
     HAVING sum(CASE direction WHEN 'debit' THEN amount_rial ELSE -amount_rial END) <> 0`,
  );
  expect(rows).toEqual([]);
  const ctx = worker as INestApplicationContext;
  expect(await ctx.get(LedgerReconciliation).run()).toMatchObject({ clean: true });
  expect(await ctx.get(DownPaymentReconciliation).run()).toMatchObject({ clean: true });
}

describe('credit transfer to an AuthorizedRecipient (task 4-8, part 5)', () => {
  it('is off behind its flag (owner س۳)', async () => {
    const f = await fundedPurse();
    const off = await ask(w.completion, f.purseId, newRecipient());
    expect(off.status).toBe(404);
    expect(off.body['error']).toBe('feature_disabled');
    await setConfig('wallet.credit_transfer_enabled', true);
    await setConfig('wallet.credit_transfer_limits', { maxAmountRial: '8000000', maxPerPurse: 2 });
  });

  it('doc 12 §9 test 11: the codes go to the recipient, the debt stays with the borrower', async () => {
    const f = await fundedPurse();
    const before = await wallet().summary(f.purseId);
    const { id, recipient } = await asked(finance, f.purseId, f.patient.mobile);
    // Owner س۵: never the one who asked; case completion asks, never approves.
    expect((await decide(finance, `${id}/approve`)).body['error']).toBe('same_person');
    expect((await decide(w.completion, `${id}/approve`)).status).toBe(403);
    const done = await decide(finance2, `${id}/approve`);
    expect(done.status).toBe(201);
    expect(done.body['status']).toBe('approved');
    // Approving twice changes nothing.
    expect((await decide(finance2, `${id}/approve`)).body['status']).toBe('approved');

    // No ledger entry: the same balances, the same debt (test 11).
    const after = await wallet().summary(f.purseId);
    expect(after.balances).toEqual(before.balances);
    expect(after.approvedAmountRial).toBe(before.approvedAmountRial);

    // The doctor sees the recipient's name; the code goes to the recipient, not the borrower.
    const patients = (await w.staff(w.doctor, 'GET', '/service/patients'))
      .body as unknown as Body[];
    expect(patients.find((p) => p['purseId'] === f.purseId)).toMatchObject({
      recipientName: recipient.name,
    });
    const lines = (await w.staff(w.doctor, 'GET', `/service/patients/${f.purseId}/lines`)).body[
      'lines'
    ] as Body[];
    const borrowerTexts = texts.sent.filter((t) => t.mobile === f.patient.mobile).length;
    const made = await w.staff(w.doctor, 'POST', '/service/authorizations', {
      purseId: f.purseId,
      proformaLineIds: [lines[0]?.['id']],
    });
    expect(made.status).toBe(201);
    const code = /(\d{6})\s*$/.exec(lastText(recipient.mobile) ?? '')?.[1];
    expect(code).toMatch(/^\d{6}$/);
    expect(texts.sent.filter((t) => t.mobile === f.patient.mobile).length).toBe(borrowerTexts);

    const delivered = await w.staff(
      w.doctor,
      'POST',
      `/service/authorizations/${made.body['id'] as string}/deliver`,
      { code },
    );
    expect(['delivered', 'finalized']).toContain(delivered.body['status']);
    // Owner س۸: the borrower is told, with no code and no amount.
    const told = lastText(f.patient.mobile) ?? '';
    expect(told).toContain('گیرنده مجاز');
    expect(told).not.toMatch(/\d{4,}/);
    // The debt is the borrower's still; what was used came off their purse.
    expect((await wallet().summary(f.purseId)).balances.borrowerDebtRial).toBe(
      before.balances.borrowerDebtRial,
    );
    await ledgerSound();
  });

  it('never the borrower; a national ID of another person is refused', async () => {
    const f = await fundedPurse();
    const self = await ask(w.completion, f.purseId, {
      name: 'خود وام‌گیرنده',
      nationalId: nationalId(),
      mobile: f.patient.mobile,
    });
    expect(self.status).toBe(409);
    expect(self.body['error']).toBe('recipient_is_borrower');
    // A person known with one national ID, asked with another mobile and that ID's owner's.
    const known = newRecipient();
    const first = await asked(w.completion, f.purseId, f.patient.mobile);
    await decide(finance, `${first.id}/reject`);
    const again = await ask(w.completion, f.purseId, {
      ...known,
      mobile: first.recipient.mobile,
    });
    expect(again.status).toBe(409);
    expect(again.body['error']).toBe('national_id_mismatch');
  });

  it('within the caps, with fresh codes; the amount bounds what the recipient may use', async () => {
    const f = await fundedPurse();
    // More than the configured cap: refused at approval.
    const big = await asked(w.completion, f.purseId, f.patient.mobile, '9000000');
    const refused = await decide(finance, `${big.id}/approve`);
    expect(refused.status).toBe(409);
    expect(refused.body).toMatchObject({ error: 'exceeds_transfer_cap', capRial: '8000000' });
    await decide(finance, `${big.id}/reject`);

    // Codes older than the hours configured: refused.
    const stale = await asked(w.completion, f.purseId, f.patient.mobile);
    await h.owner.query(
      `UPDATE credit_transfers SET recipient_verified_at = now() - interval '25 hours'
       WHERE id = $1`,
      [stale.id],
    );
    expect((await decide(finance, `${stale.id}/approve`)).body['error']).toBe('codes_expired');
    await decide(finance, `${stale.id}/reject`);

    // A small transfer: the recipient may not authorize more than it.
    const small = await asked(w.completion, f.purseId, f.patient.mobile, '1000000');
    expect((await decide(finance, `${small.id}/approve`)).status).toBe(201);
    const lines = (await w.staff(w.doctor, 'GET', `/service/patients/${f.purseId}/lines`)).body[
      'lines'
    ] as Body[];
    const over = await w.staff(w.doctor, 'POST', '/service/authorizations', {
      purseId: f.purseId,
      proformaLineIds: [lines[0]?.['id']],
    });
    expect(over.status).toBe(409);
    expect(over.body['error']).toBe('recipient_limit_reached');
    // Refused whole: nothing reserved.
    expect((await wallet().summary(f.purseId)).balances.reservedRial).toBe(0n);
  });

  it('revoked by the borrower at once, or by two people in finance; open codes cancelled', async () => {
    const f = await fundedPurse();
    const first = await asked(w.completion, f.purseId, f.patient.mobile);
    await decide(finance, `${first.id}/approve`);
    const lines = (await w.staff(w.doctor, 'GET', `/service/patients/${f.purseId}/lines`)).body[
      'lines'
    ] as Body[];
    const open = await w.staff(w.doctor, 'POST', '/service/authorizations', {
      purseId: f.purseId,
      proformaLineIds: [lines[1]?.['id']],
    });
    expect(open.status).toBe(201);

    // Two people in finance: the asker never approves it.
    const asking = await decide(finance, `${first.id}/revoke`, 'وام‌گیرنده تماس گرفت');
    expect(asking.body['status']).toBe('revoke_requested');
    expect((await decide(finance, `${first.id}/revoke/approve`)).body['error']).toBe('same_person');
    const revoked = await decide(finance2, `${first.id}/revoke/approve`);
    expect(revoked.body).toMatchObject({ status: 'revoked', revokedVia: 'finance' });
    const { rows } = await h.owner.query<Row>(
      'SELECT status FROM service_authorizations WHERE id = $1',
      [open.body['id']],
    );
    expect(rows[0]).toEqual({ status: 'cancelled' });
    expect((await wallet().summary(f.purseId)).balances.reservedRial).toBe(0n);

    // The borrower revokes the next one in the portal, at once.
    const second = await asked(w.completion, f.purseId, f.patient.mobile);
    await decide(finance, `${second.id}/approve`);
    const mine = await w.as(f.patient, 'GET', `/me/credit-transfers/${f.applicationId}`);
    expect((mine.body as unknown as Body[]).map((t) => t['status'])).toContain('approved');
    const gone = await w.as(
      f.patient,
      'POST',
      `/me/credit-transfers/${f.applicationId}/${second.id}/revoke`,
      {},
    );
    expect(gone.status).toBe(201);
    expect(await wallet().activeRecipient(f.purseId)).toBeNull();
    // Owner: at most two transfers for a purse.
    const third = await asked(w.completion, f.purseId, f.patient.mobile);
    expect((await decide(finance, `${third.id}/approve`)).body['error']).toBe(
      'transfer_limit_reached',
    );
    await ledgerSound();
  });
});

// --- ADR-047: no cap but the purse; the signed paper received (owner 1405/07/27) -----------

describe('credit transfer, ADR-047: the purse is the cap; the signed paper, numbered and received', () => {
  it('asked with the paper number; approved only with the paper received, once, by the approver', async () => {
    await setConfig('wallet.credit_transfer_enabled', true);
    await setConfig('wallet.credit_transfer_limits', { maxAmountRial: null, maxPerPurse: 2 });
    const f = await fundedPurse();
    // Without the paper number: refused before anything is made.
    const bare = await w.staff(w.completion, 'POST', '/wallet/credit-transfers', {
      purseId: f.purseId,
      recipient: newRecipient(),
      amountRial: '1000000',
      reason: 'بی سند',
    });
    expect(bare.status).toBe(400);
    const t = await asked(w.completion, f.purseId, f.patient.mobile, '1000000');
    const journals = async () =>
      Number(
        (await h.owner.query<Row>('SELECT count(*)::int AS n FROM journal_entries')).rows[0]?.['n'],
      );
    const before = await journals();
    // The paper not received: refused, still waiting.
    const unconfirmed = await w.staff(finance, 'POST', `/wallet/credit-transfers/${t.id}/approve`, {
      reason: 'مدارک بررسی شد',
      paperReceived: false,
    });
    expect(unconfirmed.status).toBe(422);
    expect(unconfirmed.body['error']).toBe('paper_receipt_required');
    const done = await decide(finance, `${t.id}/approve`);
    expect(done.status, JSON.stringify(done.body)).toBe(201);
    expect(done.body).toMatchObject({
      status: 'approved',
      paperDocumentNumber: 'P-1405-0001',
    });
    expect(typeof done.body['paperReceivedAt']).toBe('string');
    const { rows } = await h.owner.query<Row>(
      'SELECT received_by FROM credit_transfer_paper_receipts WHERE transfer_id = $1',
      [t.id],
    );
    expect(rows).toEqual([{ received_by: finance.id }]);
    // No ledger entry: a transfer posts nothing (doc 02; the debt stays with the borrower).
    expect(await journals()).toBe(before);

    // Append-only for the application role: the receipt, and the paper number on the transfer.
    const app = h.app.get<Database>(DATABASE);
    const refusal = async (q: SQL) =>
      app.execute(q).then(
        () => 'accepted',
        (e: unknown) => {
          const err = e as { message?: string; cause?: { message?: string } };
          return `${err.message ?? ''} ${err.cause?.message ?? ''}`;
        },
      );
    expect(
      await refusal(
        sql`UPDATE credit_transfer_paper_receipts SET received_at = now() WHERE transfer_id = ${t.id}`,
      ),
    ).toMatch(/permission denied|append/);
    expect(
      await refusal(sql`DELETE FROM credit_transfer_paper_receipts WHERE transfer_id = ${t.id}`),
    ).toMatch(/permission denied|append/);
    expect(
      await refusal(
        sql`UPDATE credit_transfers SET paper_document_number = 'X' WHERE id = ${t.id}`,
      ),
    ).toMatch(/permission denied|keeps its purse/);
    await ledgerSound();
  });

  it('no cap configured: up to what the purse holds, never more', async () => {
    // Migration 0095's version: no amount cap, two transfers per purse.
    const { rows: seeded } = await h.owner.query<Row>(
      `SELECT value FROM config_values WHERE key = 'wallet.credit_transfer_limits'
         AND reason LIKE '%ADR-047%'`,
    );
    expect(seeded).toEqual([{ value: { maxAmountRial: null, maxPerPurse: 2 } }]);
    await setConfig('wallet.credit_transfer_enabled', true);
    await setConfig('wallet.credit_transfer_limits', { maxAmountRial: null, maxPerPurse: 2 });
    const f = await fundedPurse();
    const available = (await wallet().summary(f.purseId)).balances.availableRial;
    // Beyond what the old cap allowed (8,000,000 in the tests above), within the purse: approved.
    const over = await asked(
      w.completion,
      f.purseId,
      f.patient.mobile,
      (available + 1n).toString(),
    );
    expect((await decide(finance, `${over.id}/approve`)).body['error']).toBe('exceeds_available');
    await decide(finance, `${over.id}/reject`);
    const all = await asked(w.completion, f.purseId, f.patient.mobile, available.toString());
    const done = await decide(finance, `${all.id}/approve`);
    expect(done.status, JSON.stringify(done.body)).toBe(201);
    expect(done.body['amountRial']).toBe(available.toString());
    await ledgerSound();
  });
});

import { FINANCIAL_STEP_UP } from '../../src/common/auth/step-up.port';
import { randomUUID } from 'node:crypto';
import type { INestApplicationContext } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { buildInstallmentSchedule } from '@sepehr/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { EffectiveAccess } from '../../src/common/auth/access.port';
import { ACCOUNT_DIRECTORY } from '../../src/common/auth/account-directory.port';
import { CLI_ACTOR } from '../../src/common/auth/actor';
import { AUDIT_LOG } from '../../src/common/audit/audit.port';
import { CONFIG } from '../../src/common/config/config.port';
import { BORROWER_EXPOSURE } from '../../src/common/credit/borrower-exposure.port';
import {
  CREDIT_CONTRACT_FACTS,
  type CreditContractFactsPort,
} from '../../src/common/credit/credit-contract-facts.port';
import {
  CREDIT_FUNDING_FACTS,
  type CreditFundingFactsPort,
} from '../../src/common/credit/credit-funding-facts.port';
import { OUTBOX } from '../../src/common/events/outbox.port';
import { LEAD_CASES } from '../../src/common/lead/lead-cases.port';
import { PROFORMA_DIRECTORY } from '../../src/common/proforma/proforma-directory.port';
import { REPAYMENT, type RepaymentPort } from '../../src/common/repayment/repayment.port';
import { OBJECT_STORAGE, type ObjectStorage } from '../../src/common/storage/object-storage.port';
import { WALLET, type WalletPort } from '../../src/common/wallet/wallet.port';
import { DATABASE, type Database } from '../../src/db/database.module';
import type { Alert, AlertSink } from '../../src/infra/ops/alerts';
import { CompletionService } from '../../src/modules/contract/completion.service';
import { ContractPrinter } from '../../src/modules/contract/contract-printer';
import { DownPaymentService } from '../../src/modules/contract/down-payment.service';
import { LedgerReconciliation } from '../../src/modules/ledger/reconciliation';
import { FundingNotifier } from '../../src/modules/wallet/funding-notifier';
import { FundingService } from '../../src/modules/wallet/funding.service';
import { WorkerModule } from '../../src/worker.module';
import {
  call,
  grantRole,
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
 * Task 4-5 [financial] (doc 12 §5, §9 tests 1–4 and 13; ADR-034; owner 1405/07/11):
 * funding a completed application, asked by case completion and approved by another
 * person in finance, in one transaction; the down payment (held by Aramesh since its
 * receipt, posted retroactively for receipts of 4-3) moved into the purse beside the loan,
 * the borrower owing only the loan and the spread fee; the schedule from funded_at and
 * exactly the contract's; one purse and one debt per member of a group; the ledger
 * balanced and the nightly reconciliation clean.
 */

let h: Harness;
let w: Awaited<ReturnType<typeof creditWorld>>;
type Staff = Awaited<ReturnType<typeof loggedInAccount>>;
let manager: Staff;
let finance: Staff;
let finance2: Staff;
let worker: INestApplicationContext | undefined;
const alerts: Alert[] = [];
const sink: AlertSink = {
  raise(alert) {
    alerts.push(alert);
    return Promise.resolve();
  },
};

const alef = {
  job: 'official',
  employmentStartedOn: { year: 1398, month: 1, day: 1 },
  coverage: 'full',
  obligationsRial: '1000000',
  newInstallmentRial: '4000000',
};

/** The world's proforma: 6,000,000 + 2 × 3,000,000 = 12,000,000 rials. */
const SHARE = 12_000_000n;
const DOWN = 2_400_000n; // 20%
const LOAN = SHARE - DOWN; // 9,600,000
const FEE = 960_000n; // 10% of the loan, spread

beforeAll(async () => {
  h = await startHarness(CREDIT_HARNESS);
  w = await creditWorld(h);
  manager = await w.role('credit_manager');
  finance = await w.role('accounting');
  finance2 = await w.role('accounting');
  worker = await NestFactory.createApplicationContext(
    WorkerModule.forRoot({ alertSink: sink, relayLoop: false }),
    { logger: false },
  );
}, 180_000);

afterAll(async () => {
  await worker?.close();
  await h.close();
});

/** Scored, proposed by the specialist, confirmed by the manager. */
async function decide(applicationId: string) {
  await w.staff(w.creditSpecialist, 'POST', `/credit/applications/${applicationId}/score-sheets`, {
    subject: 'borrower',
    raw: alef,
  });
  await w.staff(w.creditSpecialist, 'POST', `/credit/applications/${applicationId}/to-decision`);
  const proposed = await w.staff(
    w.creditSpecialist,
    'POST',
    `/credit/applications/${applicationId}/decisions`,
    { outcome: 'approved', reason: 'رتبه الف' },
  );
  const confirmed = await w.staff(
    manager,
    'POST',
    `/credit/applications/${applicationId}/decisions/${proposed.body['id'] as string}/confirm`,
  );
  expect(confirmed.status).toBe(201);
}

async function upload(p: Patient, applicationId: string, fields: Record<string, string>) {
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

const STAFF_ACCESS: EffectiveAccess = {
  accountId: '00000000-0000-7000-8000-000000000000',
  kind: 'staff',
  roles: ['case_completion'],
  permissions: new Set(['contract.complete', 'contract.read']),
  scopes: [{ kind: 'global' }],
} as unknown as EffectiveAccess;

/**
 * Everything of doc 12 §2–§4 for an approved application: the contract printed and
 * accepted, the papers checked, each receipt owed approved by finance, then completed.
 * `legacyDownPayment`: the down payment's receipt approved as task 4-3 did, with no
 * posting (written to the database as it stood then). `completedAt`: completion recorded
 * at that instant (an indicator only, doc 02 §5).
 */
async function complete(
  borrower: Patient,
  applicationId: string,
  options: { legacyDownPayment?: boolean; completedAt?: Date } = {},
) {
  const contract = await w.staff(w.completion, 'POST', '/contracts', {
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
  await w.as(borrower, 'POST', `/me/contracts/${contractId}/acceptance/request`, {
    role: 'borrower',
  });
  const accepted = await w.as(borrower, 'POST', `/me/contracts/${contractId}/acceptance`, {
    role: 'borrower',
    code: h.sms.lastCodeFor(borrower.mobile),
  });
  expect(accepted.body['status']).toBe('accepted');

  const delivery = await w.staff(w.completion, 'POST', '/deliveries', {
    creditApplicationId: applicationId,
    items: [{ kind: 'signed_contract', label: 'قرارداد امضاشده' }],
  });
  const deliveryId = delivery.body['id'] as string;
  await w.staff(w.completion, 'POST', `/deliveries/${deliveryId}/receive`, { method: 'in_person' });
  await w.staff(
    w.completion,
    'POST',
    `/deliveries/${deliveryId}/items/${(delivery.body['items'] as Body[])[0]?.['id'] as string}`,
    { status: 'received' },
  );
  await w.staff(w.completion, 'POST', `/deliveries/${deliveryId}/check`);

  const status = await w.staff(w.completion, 'GET', `/completion/${applicationId}`);
  const receipts: Record<string, string> = {};
  for (const owed of status.body['owed'] as Body[]) {
    const kind = owed['kind'] as string;
    const amount = owed['expectedRial'] as string;
    if (kind === 'down_payment' && options.legacyDownPayment) {
      const { rows } = await h.owner.query<Row>(
        `INSERT INTO completion_receipts (credit_application_id, kind, amount_rial, expected_rial,
           paid_on, reference, storage_key, mime, size_bytes, sha256, status, uploaded_by,
           decided_by, decided_at)
         VALUES ($1, 'down_payment', $2, $2, '2026-09-30', 'REF-LEGACY', $3, 'application/pdf',
           100, $4, 'approved', $5, $6, now())
         RETURNING id`,
        [applicationId, amount, `legacy/${randomUUID()}`, 'a'.repeat(64), borrower.id, finance.id],
      );
      receipts[kind] = rows[0]?.['id'] as string;
      continue;
    }
    const sent = await upload(borrower, applicationId, {
      kind,
      amountRial: amount,
      paidOn: '2026-10-01',
      reference: `REF-${kind}`,
    });
    expect(sent.status).toBe(201);
    receipts[kind] = sent.body['id'] as string;
    const approved = await w.staff(
      finance,
      'POST',
      `/receipts/${sent.body['id'] as string}/approve`,
    );
    expect(approved.body['status']).toBe('approved');
  }

  if (options.completedAt) {
    await h.app
      .get(CompletionService)
      .complete(
        { ...CLI_ACTOR, accountId: w.completion.id },
        STAFF_ACCESS,
        applicationId,
        options.completedAt,
      );
  } else {
    expect(
      (await w.staff(w.completion, 'POST', `/completion/${applicationId}/complete`)).status,
    ).toBe(201);
  }
  return { receipts };
}

/** An approved application of one borrower, the patient themselves. */
async function approvedApplication() {
  const { patient, applicationId } = await w.inReview();
  await decide(applicationId);
  return { patient, applicationId };
}

const ask = (applicationId: string) =>
  w.staff(w.completion, 'POST', '/funding/requests', { creditApplicationId: applicationId });

/**
 * ADR-039: the schedule is the contract's to the rial, rounded by the version the case
 * locked at creation, and stores that version.
 */
async function expectContractSchedule(applicationId: string, scheduleId: string) {
  const contract = await h.app
    .get<CreditContractFactsPort>(CREDIT_CONTRACT_FACTS)
    .facts(applicationId);
  const { rows: made } = await h.owner.query<Row>(
    `SELECT s.total_rial::text AS total, s.rounding_unit_rial::text AS unit,
            s.rounding_config_version_id AS version, a.rounding_version_id AS locked,
            v.value #>> '{}' AS locked_unit
       FROM installment_schedules s, credit_applications a, config_values v
      WHERE s.id = $1 AND a.id = $2 AND v.id = a.rounding_version_id`,
    [scheduleId, applicationId],
  );
  const schedule = made[0] ?? {};
  expect(schedule['version']).toBe(schedule['locked']);
  expect(schedule['unit']).toBe(schedule['locked_unit']);
  expect(schedule['unit']).toBe('10000');
  expect(BigInt(schedule['total'] as string)).toBe(contract?.totalObligationRial);
  const { rows: installments } = await h.owner.query<Row>(
    `SELECT index, amount_rial::text AS amount FROM installments
      WHERE schedule_id = $1 ORDER BY index`,
    [scheduleId],
  );
  expect(installments.map((i) => [i['index'], BigInt(i['amount'] as string)])).toEqual(
    (contract?.installments ?? []).map((i) => [i.index, i.amountRial]),
  );
  expect(installments).toHaveLength(12);
}

/** Each account's net balance for an application's purse and borrower, by code. */
async function balances(applicationId: string) {
  const { rows } = await h.owner.query<Row>(
    `SELECT a.code,
            coalesce(sum(CASE e.direction WHEN 'debit' THEN e.amount_rial ELSE -e.amount_rial END), 0)::text AS net
       FROM ledger_entries e
       JOIN ledger_accounts a ON a.id = e.account_id
       JOIN journal_entries j ON j.id = e.journal_entry_id
      WHERE j.credit_application_id = $1
         OR a.owner_id IN (SELECT id FROM credit_purses WHERE credit_application_id = $1)
      GROUP BY a.code ORDER BY a.code`,
    [applicationId],
  );
  return Object.fromEntries(rows.map((r) => [r['code'] as string, BigInt(r['net'] as string)]));
}

async function ledgerSound() {
  const { rows } = await h.owner.query<Row>(
    `SELECT coalesce(sum(amount_rial) FILTER (WHERE direction = 'debit'), 0)::text AS d,
            coalesce(sum(amount_rial) FILTER (WHERE direction = 'credit'), 0)::text AS c
       FROM ledger_entries`,
  );
  expect(rows[0]?.['d']).toBe(rows[0]?.['c']);
  const { rows: unbalanced } = await h.owner.query<Row>(
    `SELECT journal_entry_id FROM ledger_entries GROUP BY journal_entry_id
     HAVING sum(CASE direction WHEN 'debit' THEN amount_rial ELSE -amount_rial END) <> 0`,
  );
  expect(unbalanced).toEqual([]);
  const result = await (worker as INestApplicationContext).get(LedgerReconciliation).run();
  expect(result).toMatchObject({ clean: true, discrepancies: [] });
}

describe('funding (doc 12 §5)', () => {
  it('§9 test 1: is refused before completion, asked and approved', async () => {
    const { patient, applicationId } = await approvedApplication();
    const early = await ask(applicationId);
    expect(early.status).toBe(409);
    expect(early.body['error']).toBe('not_completed');
    await complete(patient, applicationId);
    // Only case completion asks; finance cannot.
    expect(
      (await w.staff(finance, 'POST', '/funding/requests', { creditApplicationId: applicationId }))
        .status,
    ).toBe(403);
    const asked = await ask(applicationId);
    expect(asked.status).toBe(201);
    expect(asked.body).toMatchObject({ status: 'requested', approvedAmountRial: LOAN.toString() });
    expect((await ask(applicationId)).body['error']).toBe('funding_exists');
  });

  it('§9 test 2: never by one person alone', async () => {
    const { patient, applicationId } = await approvedApplication();
    await complete(patient, applicationId);
    // One account that may both ask and approve.
    const both = await w.role('case_completion');
    await grantRole(h, both.id, 'accounting');
    const asked = await w.staff(both, 'POST', '/funding/requests', {
      creditApplicationId: applicationId,
    });
    expect(asked.status).toBe(201);
    const self = await w.staff(
      both,
      'POST',
      `/funding/requests/${asked.body['id'] as string}/approve`,
    );
    expect(self.status).toBe(409);
    expect(self.body['error']).toBe('same_person');
    // The database refuses it too.
    await expect(
      h.owner.query(
        `UPDATE funding_requests SET status = 'rejected', decided_by = requested_by,
           decided_at = now(), decision_reason = 'x' WHERE id = $1`,
        [asked.body['id']],
      ),
    ).rejects.toThrow(/two_people/);
    const { rows } = await h.owner.query<Row>(
      'SELECT count(*)::int AS n FROM credit_purses WHERE credit_application_id = $1',
      [applicationId],
    );
    expect(rows[0]).toEqual({ n: 0 });
  });

  it('ADR-034, §9 tests 3, 4 and 13: one transaction, the down payment in the purse, the debt the loan', async () => {
    const { patient, applicationId } = await approvedApplication();
    const completedAt = new Date(Date.now() - 45 * 86_400_000);
    await complete(patient, applicationId, { completedAt });
    // The down payment is held for the borrower since its receipt was approved.
    expect(await balances(applicationId)).toMatchObject({
      'bank.collection': DOWN + 500_000n,
      'downpayment.held': -DOWN,
    });
    const asked = await ask(applicationId);
    const id = asked.body['id'] as string;
    const approved = await w.staff(finance, 'POST', `/funding/requests/${id}/approve`);
    expect(approved.status).toBe(201);
    expect(approved.body).toMatchObject({ status: 'approved' });

    // Test 3: again, and twice at once: the same purse and schedule, nothing posted twice.
    const journalsBefore = await h.owner.query<Row>(
      'SELECT count(*)::int AS n FROM journal_entries WHERE credit_application_id = $1 OR case_id IN (SELECT case_id FROM credit_purses WHERE credit_application_id = $1)',
      [applicationId],
    );
    const again = await Promise.all([
      w.staff(finance, 'POST', `/funding/requests/${id}/approve`),
      w.staff(finance2, 'POST', `/funding/requests/${id}/approve`),
    ]);
    for (const r of again) {
      expect(r.status).toBe(201);
      expect(r.body['purseId']).toBe(approved.body['purseId']);
      expect(r.body['scheduleId']).toBe(approved.body['scheduleId']);
    }
    const journalsAfter = await h.owner.query<Row>(
      'SELECT count(*)::int AS n FROM journal_entries WHERE credit_application_id = $1 OR case_id IN (SELECT case_id FROM credit_purses WHERE credit_application_id = $1)',
      [applicationId],
    );
    expect(journalsAfter.rows).toEqual(journalsBefore.rows);
    const { rows: counts } = await h.owner.query<Row>(
      `SELECT (SELECT count(*)::int FROM credit_purses WHERE credit_application_id = $1) AS purses,
              (SELECT count(*)::int FROM installment_schedules s JOIN credit_purses p ON p.id = s.purse_id
                WHERE p.credit_application_id = $1) AS schedules`,
      [applicationId],
    );
    expect(counts[0]).toEqual({ purses: 1, schedules: 1 });

    // ADR-034: the borrower owes the loan and the spread fee; the purse holds loan and down
    // payment; nothing is held any more.
    const purse = await h.app.get<WalletPort>(WALLET).summary(approved.body['purseId'] as string);
    expect(purse.approvedAmountRial).toBe(LOAN);
    expect(purse.downPaymentRial).toBe(DOWN);
    expect(purse.balances.availableRial).toBe(LOAN + DOWN);
    expect(purse.balances.borrowerDebtRial).toBe(LOAN + FEE);
    const net = await balances(applicationId);
    expect(net['downpayment.held']).toBe(0n);
    expect(net['company.fee_income']).toBe(-(500_000n + FEE));

    // Test 4: due dates from funded_at, not completed_at (45 days earlier).
    const schedule = await h.app
      .get<RepaymentPort>(REPAYMENT)
      .schedule(approved.body['scheduleId'] as string);
    const fundedAt = purse.fundedAt ?? new Date(0);
    const expected = buildInstallmentSchedule({
      totalRial: LOAN + FEE,
      count: 12,
      fundedAt,
      roundingUnitRial: 10_000n,
    });
    expect(schedule.installments.map((i) => i.dueOn)).toEqual(expected.map((i) => i.dueOn));
    const fromCompletion = buildInstallmentSchedule({
      totalRial: LOAN + FEE,
      count: 12,
      fundedAt: completedAt,
      roundingUnitRial: 10_000n,
    });
    expect(schedule.installments[0]?.dueOn).not.toBe(fromCompletion[0]?.dueOn);
    expect(schedule.totalRial).toBe(LOAN + FEE);

    // The patient sees the purse and the installments; a stranger nothing.
    const mine = await w.as(patient, 'GET', `/me/funding/${applicationId}`);
    expect(mine.body).toMatchObject({
      funded: true,
      availableRial: (LOAN + DOWN).toString(),
      totalRial: (LOAN + FEE).toString(),
    });
    expect(mine.body['installments'] as Body[]).toHaveLength(12);
    const stranger = await w.patient();
    expect((await w.as(stranger, 'GET', `/me/funding/${applicationId}`)).status).toBe(404);

    // Spending all of it (doc 02 §3): the chain and the held account end at zero, the doctor
    // is owed loan and down payment, and only the borrower's debt remains.
    const wallet = h.app.get<WalletPort>(WALLET);
    const purseId = purse.id;
    const auth = `auth-${randomUUID()}`;
    const amount = LOAN + DOWN;
    await wallet.reserve(CLI_ACTOR, purseId, {
      idempotencyKey: `${auth}:r`,
      authorizationId: auth,
      amountRial: amount,
      service: purse.scope,
    });
    await wallet.registerService(CLI_ACTOR, purseId, {
      idempotencyKey: `${auth}:s`,
      authorizationId: auth,
      amountRial: amount,
    });
    await wallet.finalize(CLI_ACTOR, purseId, {
      idempotencyKey: `${auth}:f`,
      authorizationId: auth,
      amountRial: amount,
    });
    const spent = await wallet.summary(purseId);
    expect(spent.balances).toMatchObject({
      approvedRial: 0n,
      availableRial: 0n,
      reservedRial: 0n,
      consumedPendingRial: 0n,
      borrowerDebtRial: LOAN + FEE,
    });
    // One rial more than the purse holds is refused (the hard rule, ADR-034 change 3).
    await expect(
      wallet.reserve(CLI_ACTOR, purseId, {
        idempotencyKey: `${auth}:more`,
        authorizationId: `${auth}-more`,
        amountRial: 1n,
        service: purse.scope,
      }),
    ).rejects.toMatchObject({ response: { error: 'insufficient_available' } });

    // Test 13: balanced, reconciled.
    await ledgerSound();
  });

  it('ADR-052: no code, or a code for something else, funds nothing; the signer’s own code does', async () => {
    const { patient, applicationId } = await approvedApplication();
    await complete(patient, applicationId);
    const asked = await ask(applicationId);
    const id = asked.body['id'] as string;
    const journals = async () =>
      (
        await h.owner.query<Row>(
          'SELECT count(*)::int AS n FROM journal_entries WHERE credit_application_id = $1 OR case_id IN (SELECT case_id FROM credit_purses WHERE credit_application_id = $1)',
          [applicationId],
        )
      ).rows[0]?.['n'];
    const before = await journals();
    const path = `/funding/requests/${id}/approve`;
    // Straight to the API, no code: refused, naming what to sign.
    const bare = await call(h, 'POST', path, { bearer: finance.access, stepUp: false });
    expect([bare.status, bare.body['error']]).toEqual([403, 'step_up_required']);
    expect(bare.body['operation']).toMatchObject({ type: 'funding', id, step: 'approve' });
    // A real code, for another request: refused.
    await h.owner.query(
      `UPDATE user_accounts SET mobile = COALESCE(mobile, $2), mobile_verified_at = COALESCE(mobile_verified_at, now())
        WHERE id = $1`,
      [finance.id, newMobile()],
    );
    const other = await call(h, 'POST', '/identity/step-up/challenges', {
      bearer: finance.access,
      body: { ...(bare.body['operation'] as Row), id: randomUUID() },
    });
    expect(other.status, JSON.stringify(other.body)).toBe(201);
    const mobile = (
      await h.owner.query<Row>('SELECT mobile FROM user_accounts WHERE id = $1', [finance.id])
    ).rows[0]?.['mobile'] as string;
    const wrong = await call(h, 'POST', path, {
      bearer: finance.access,
      stepUp: false,
      headers: {
        'x-step-up': `${other.body['challengeId'] as string}.${h.stepUps.lastCodeFor(mobile)}`,
      },
    });
    expect([wrong.status, wrong.body['error']]).toEqual([403, 'step_up_invalid']);
    expect(await journals()).toBe(before);
    // The signer's own code for this one: funded.
    const signed = await w.staff(finance, 'POST', path);
    expect(signed.status, JSON.stringify(signed.body)).toBe(201);
    expect(await journals()).not.toBe(before);
  }, 600_000);

  it('ADR-034: a down payment of 4-3 is posted once, retroactively, then funded', async () => {
    const { patient, applicationId } = await approvedApplication();
    const { receipts } = await complete(patient, applicationId, { legacyDownPayment: true });
    const service = h.app.get(DownPaymentService);
    expect(await service.receiptsWithoutPosting()).toContain(receipts['down_payment']);
    const first = await service.postMissing(CLI_ACTOR);
    expect(first.posted).toBeGreaterThanOrEqual(1);
    expect((await service.postMissing(CLI_ACTOR)).posted).toBe(0);
    const { rows } = await h.owner.query<Row>(
      `SELECT count(*)::int AS n FROM journal_entries WHERE idempotency_key = $1`,
      [`contract:receipt:${receipts['down_payment'] ?? ''}`],
    );
    expect(rows[0]).toEqual({ n: 1 });
    expect(await service.receiptsWithoutPosting()).not.toContain(receipts['down_payment']);
    // Every approved receipt equals its bank.collection debit (owner's requirement 1).
    const { rows: bank } = await h.owner.query<Row>(
      `SELECT (SELECT coalesce(sum(amount_rial), 0) FROM completion_receipts
                WHERE credit_application_id = $1 AND status = 'approved')::text AS receipts,
              (SELECT coalesce(sum(e.amount_rial), 0) FROM journal_entries j
                 JOIN ledger_entries e ON e.journal_entry_id = j.id
                 JOIN ledger_accounts a ON a.id = e.account_id
                WHERE j.credit_application_id = $1 AND j.idempotency_key LIKE 'contract:receipt:%'
                  AND a.code = 'bank.collection' AND e.direction = 'debit')::text AS bank`,
      [applicationId],
    );
    expect(bank[0]?.['receipts']).toBe(bank[0]?.['bank']);
    const asked = await ask(applicationId);
    const approved = await w.staff(
      finance,
      'POST',
      `/funding/requests/${asked.body['id'] as string}/approve`,
    );
    expect(approved.status).toBe(201);
    expect((await balances(applicationId))['downpayment.held']).toBe(0n);
    await ledgerSound();
  });

  it('ADR-034: before funding, finance reverses the down payment; funding then refuses it', async () => {
    const { patient, applicationId } = await approvedApplication();
    const { receipts } = await complete(patient, applicationId);
    const receiptId = receipts['down_payment'] ?? '';
    const path = `/receipts/${receiptId}/reverse-down-payment`;
    expect((await w.staff(w.completion, 'POST', path, { reason: 'برگشت' })).status).toBe(403);
    const reversed = await w.staff(finance, 'POST', path, { reason: 'فیش اشتباه، استرداد' });
    expect(reversed.status).toBe(201);
    expect(reversed.body).toMatchObject({ reversed: true, funded: false });
    // Once: again returns the same, posts nothing.
    expect((await w.staff(finance, 'POST', path, { reason: 'دوباره' })).body['reversedAt']).toBe(
      reversed.body['reversedAt'],
    );
    const net = await balances(applicationId);
    expect(net['downpayment.held']).toBe(0n);
    expect(net['bank.collection']).toBe(500_000n);
    const asked = await ask(applicationId);
    const refused = await w.staff(
      finance,
      'POST',
      `/funding/requests/${asked.body['id'] as string}/approve`,
    );
    expect(refused.status).toBe(409);
    expect(refused.body['error']).toBe('down_payment_reversed');
    const { rows } = await h.owner.query<Row>(
      'SELECT count(*)::int AS n FROM credit_purses WHERE credit_application_id = $1',
      [applicationId],
    );
    expect(rows[0]).toEqual({ n: 0 });
    await ledgerSound();
  });

  it('ADR-034: after funding, the down payment is not reversed', async () => {
    const { patient, applicationId } = await approvedApplication();
    const { receipts } = await complete(patient, applicationId);
    const asked = await ask(applicationId);
    await w.staff(finance, 'POST', `/funding/requests/${asked.body['id'] as string}/approve`);
    const late = await w.staff(
      finance,
      'POST',
      `/receipts/${receipts['down_payment'] ?? ''}/reverse-down-payment`,
      {
        reason: 'دیر',
      },
    );
    expect(late.status).toBe(409);
    expect(late.body['error']).toBe('already_funded');
  });

  it("ADR-039 (was owner's decision 6): the rounding unit changes after the decision; funding uses the case's locked unit, to the rial", async () => {
    const { patient, applicationId } = await approvedApplication();
    await complete(patient, applicationId);
    // The rounding unit changes after the decision (launch blocker م۱).
    await h.owner.query(
      `INSERT INTO config_values (key, scope_level, value, effective_at, status, reason, decided_at)
       VALUES ('repayment.rounding_unit_rial', 'global', '"100000"'::jsonb, now(), 'approved', 'آزمون', now())`,
    );
    try {
      const asked = await ask(applicationId);
      const path = `/funding/requests/${asked.body['id'] as string}/approve`;
      const approved = await w.staff(finance, 'POST', path);
      expect(approved.status).toBe(201);
      expect(approved.body['status']).toBe('approved');
      await expectContractSchedule(applicationId, approved.body['scheduleId'] as string);
      // Again: the same schedule, nothing new.
      const again = await w.staff(finance, 'POST', path);
      expect(again.body['scheduleId']).toBe(approved.body['scheduleId']);
      const { rows } = await h.owner.query<Row>(
        `SELECT count(*)::int AS n FROM installment_schedules s
           JOIN credit_purses p ON p.id = s.purse_id WHERE p.credit_application_id = $1`,
        [applicationId],
      );
      expect(rows[0]).toEqual({ n: 1 });
    } finally {
      await h.owner.query(
        `INSERT INTO config_values (key, scope_level, value, effective_at, status, reason, decided_at)
         VALUES ('repayment.rounding_unit_rial', 'global', '"10000"'::jsonb, now(), 'approved', 'آزمون', now())`,
      );
    }
    await ledgerSound();
  });

  it('ADR-039: a new unit too large for the total does not stop a case locked to the old one', async () => {
    const { patient, applicationId } = await approvedApplication();
    await complete(patient, applicationId);
    // 12 × 1,000,000 > 10,560,000: under the new unit this total is too small for 12.
    await h.owner.query(
      `INSERT INTO config_values (key, scope_level, value, effective_at, status, reason, decided_at)
       VALUES ('repayment.rounding_unit_rial', 'global', '"1000000"'::jsonb, now(), 'approved', 'آزمون', now())`,
    );
    try {
      const asked = await ask(applicationId);
      const approved = await w.staff(
        finance,
        'POST',
        `/funding/requests/${asked.body['id'] as string}/approve`,
      );
      expect(approved.status).toBe(201);
      await expectContractSchedule(applicationId, approved.body['scheduleId'] as string);
    } finally {
      await h.owner.query(
        `INSERT INTO config_values (key, scope_level, value, effective_at, status, reason, decided_at)
         VALUES ('repayment.rounding_unit_rial', 'global', '"10000"'::jsonb, now(), 'approved', 'آزمون', now())`,
      );
    }
    await ledgerSound();
  });

  it("owner's decision 6: a schedule unlike the contract still rolls the whole funding back", async () => {
    const { patient, applicationId } = await approvedApplication();
    await complete(patient, applicationId);
    const asked = await ask(applicationId);
    const facts = h.app.get<CreditFundingFactsPort>(CREDIT_FUNDING_FACTS);
    // Another mismatch than rounding: the contract says one rial more than the schedule.
    const service = new FundingService(
      h.app.get(DATABASE),
      h.app.get(AUDIT_LOG),
      h.app.get(OUTBOX),
      h.app.get(WALLET),
      h.app.get(REPAYMENT),
      h.app.get(DownPaymentService),
      {
        lockForFunding: async (id, tx) => {
          const real = await facts.lockForFunding(id, tx);
          return real && { ...real, totalObligationRial: real.totalObligationRial + 1n };
        },
      },
      h.app.get(CREDIT_CONTRACT_FACTS),
      h.app.get(PROFORMA_DIRECTORY),
      h.app.get(ACCOUNT_DIRECTORY),
      h.app.get(LEAD_CASES),
      h.app.get(CONFIG),
      h.app.get(BORROWER_EXPOSURE),
      h.app.get(FINANCIAL_STEP_UP),
    );
    const access = {
      accountId: finance.id,
      kind: 'staff',
      roles: ['accounting'],
      permissions: new Set(['wallet.approve_funding']),
      scopes: [{ kind: 'global' }],
    } as unknown as EffectiveAccess;
    await expect(
      service.approve({ ...CLI_ACTOR, accountId: finance.id }, access, asked.body['id'] as string),
    ).rejects.toMatchObject({ response: { error: 'schedule_differs_from_contract' } });
    const { rows } = await h.owner.query<Row>(
      `SELECT (SELECT count(*)::int FROM credit_purses WHERE credit_application_id = $1) AS purses,
              (SELECT status FROM funding_requests WHERE id = $2) AS status,
              (SELECT funded_purse_id FROM down_payment_postings WHERE credit_application_id = $1) AS funded`,
      [applicationId, asked.body['id']],
    );
    expect(rows[0]).toEqual({ purses: 0, status: 'requested', funded: null });
    await ledgerSound();
  });

  it('ADR-039: a schedule is never made without the case’s rounding version', async () => {
    const repayment = h.app.get<RepaymentPort>(REPAYMENT);
    const input = {
      idempotencyKey: `m1-${randomUUID()}`,
      purseId: randomUUID(),
      installmentCount: 12,
      planFeeRial: 0n,
      // ADR-041's versions valid, so only the rounding version is missing.
      shiftConfigVersionId: randomUUID(),
      graceConfigVersionId: randomUUID(),
    };
    for (const roundingConfigVersionId of [undefined, '', 'not-a-uuid']) {
      await expect(
        repayment.createSchedule(CLI_ACTOR, {
          ...input,
          roundingConfigVersionId: roundingConfigVersionId as unknown as string,
        }),
      ).rejects.toMatchObject({ status: 400, response: { error: 'rounding_version_required' } });
    }
  });

  it('posts only for aramesh (ADR-007), whatever the contract says', async () => {
    const { patient, applicationId } = await approvedApplication();
    await complete(patient, applicationId);
    const asked = await ask(applicationId);
    const completion = h.app.get(DownPaymentService);
    const service = new FundingService(
      h.app.get(DATABASE),
      h.app.get(AUDIT_LOG),
      h.app.get(OUTBOX),
      h.app.get(WALLET),
      h.app.get(REPAYMENT),
      {
        completedAt: (id) => completion.completedAt(id),
        lockForFunding: async (actor, id, tx) => ({
          ...(await completion.lockForFunding(actor, id, tx)),
          entityId: 'sepehr',
        }),
        markDownPaymentFunded: (...args) => completion.markDownPaymentFunded(...args),
      },
      h.app.get(CREDIT_FUNDING_FACTS),
      h.app.get(CREDIT_CONTRACT_FACTS),
      h.app.get(PROFORMA_DIRECTORY),
      h.app.get(ACCOUNT_DIRECTORY),
      h.app.get(LEAD_CASES),
      h.app.get(CONFIG),
      h.app.get(BORROWER_EXPOSURE),
      h.app.get(FINANCIAL_STEP_UP),
    );
    const access = {
      accountId: finance.id,
      kind: 'staff',
      roles: ['accounting'],
      permissions: new Set(['wallet.approve_funding']),
      scopes: [{ kind: 'global' }],
    } as unknown as EffectiveAccess;
    await expect(
      service.approve({ ...CLI_ACTOR, accountId: finance.id }, access, asked.body['id'] as string),
    ).rejects.toMatchObject({ response: { error: 'entity_not_allowed' } });
    const { rows } = await h.owner.query<Row>(
      'SELECT count(*)::int AS n FROM credit_purses WHERE credit_application_id = $1',
      [applicationId],
    );
    expect(rows[0]).toEqual({ n: 0 });
  });

  it("owner's decision 5: two members of a group, one case, each its own purse and debt", async () => {
    const { patient, proformaId } = await w.confirmedProforma();
    const otherMobile = newMobile();
    const made = await w.as(patient, 'POST', '/me/credit-application-groups', {
      proformaId,
      members: [
        { planCode: 'dental_12', installmentCount: 12, shareRial: '7000000' },
        {
          planCode: 'dental_12',
          installmentCount: 12,
          shareRial: '5000000',
          borrowerMobile: `0${otherMobile}`,
        },
      ],
    });
    expect(made.status).toBe(201);
    const [mine, theirs] = made.body as unknown as Body[];
    const other = await w.patient(otherMobile);
    const members = [
      { borrower: patient, id: mine?.['id'] as string, loan: 5_600_000n, down: 1_400_000n },
      { borrower: other, id: theirs?.['id'] as string, loan: 4_000_000n, down: 1_000_000n },
    ];
    for (const m of members) {
      await w.as(patient, 'POST', `/me/credit-applications/${m.id}/submit`);
      await w.consent(m.borrower, m.id, 'borrower');
      await w.documented(m.borrower, m.id, 'borrower');
      await w.staff(w.completion, 'POST', `/credit/applications/${m.id}/ready-for-review`);
      await decide(m.id);
      await complete(m.borrower, m.id);
      const asked = await ask(m.id);
      const approved = await w.staff(
        finance,
        'POST',
        `/funding/requests/${asked.body['id'] as string}/approve`,
      );
      expect(approved.status).toBe(201);
    }
    const { rows } = await h.owner.query<Row>(
      `SELECT credit_application_id, case_id, approved_amount_rial::text AS a, down_payment_rial::text AS d
         FROM credit_purses WHERE credit_application_id = ANY($1::uuid[]) ORDER BY approved_amount_rial DESC`,
      [members.map((m) => m.id)],
    );
    expect(rows).toHaveLength(2);
    expect(rows[0]?.['case_id']).toBe(rows[1]?.['case_id']);
    const wallet = h.app.get<WalletPort>(WALLET);
    for (const m of members) {
      const { rows: p } = await h.owner.query<Row>(
        'SELECT id FROM credit_purses WHERE credit_application_id = $1',
        [m.id],
      );
      const purse = await wallet.summary(p[0]?.['id'] as string);
      expect(purse.downPaymentRial).toBe(m.down);
      expect(purse.balances.availableRial).toBe(m.loan + m.down);
      // Each owes its own loan and its own spread fee (10%), nothing of the other's.
      expect(purse.balances.borrowerDebtRial).toBe(m.loan + m.loan / 10n);
    }
    const { rows: schedules } = await h.owner.query<Row>(
      `SELECT count(*)::int AS n FROM installment_schedules s JOIN credit_purses p ON p.id = s.purse_id
        WHERE p.credit_application_id = ANY($1::uuid[])`,
      [members.map((m) => m.id)],
    );
    expect(schedules[0]).toEqual({ n: 2 });
    await ledgerSound();
  });

  it("owner 1405/07/11: a group's plan fees, one journal per member, each its own, none counted twice", async () => {
    const { patient, proformaId } = await w.confirmedProforma();
    const otherMobile = newMobile();
    const made = await w.as(patient, 'POST', '/me/credit-application-groups', {
      proformaId,
      members: [
        { planCode: 'dental_12', installmentCount: 12, shareRial: '7000000' },
        {
          planCode: 'dental_12',
          installmentCount: 12,
          shareRial: '5000000',
          borrowerMobile: `0${otherMobile}`,
        },
      ],
    });
    expect(made.status).toBe(201);
    const [mine, theirs] = made.body as unknown as Body[];
    const other = await w.patient(otherMobile);
    // The spread plan fee is 10% of each member's own loan.
    const members = [
      { borrower: patient, id: mine?.['id'] as string, fee: 560_000n },
      { borrower: other, id: theirs?.['id'] as string, fee: 400_000n },
    ];
    for (const m of members) {
      await w.as(patient, 'POST', `/me/credit-applications/${m.id}/submit`);
      await w.consent(m.borrower, m.id, 'borrower');
      await w.documented(m.borrower, m.id, 'borrower');
      await w.staff(w.completion, 'POST', `/credit/applications/${m.id}/ready-for-review`);
      await decide(m.id);
      await complete(m.borrower, m.id);
      const asked = await ask(m.id);
      const approved = await w.staff(
        finance,
        'POST',
        `/funding/requests/${asked.body['id'] as string}/approve`,
      );
      expect(approved.status).toBe(201);
    }
    const ids = members.map((m) => m.id);

    // One plan-fee journal per member, under its own application and its own key; the case
    // the members share is on both.
    const { rows: journals } = await h.owner.query<Row>(
      `SELECT j.credit_application_id AS app, j.case_id, j.idempotency_key AS key,
              e.amount_rial::text AS amount
         FROM journal_entries j
         JOIN ledger_entries e ON e.journal_entry_id = j.id
         JOIN ledger_accounts a ON a.id = e.account_id
        WHERE j.event_type = 'repayment.plan_fee' AND a.code = 'company.fee_income'
          AND e.direction = 'credit'
          AND j.case_id IN (SELECT case_id FROM credit_purses WHERE credit_application_id = ANY($1::uuid[]))`,
      [ids],
    );
    expect(journals).toHaveLength(2);
    expect(new Set(journals.map((j) => j['key'])).size).toBe(2);
    expect(journals[0]?.['case_id']).toBe(journals[1]?.['case_id']);
    for (const m of members) {
      const own = journals.filter((j) => j['app'] === m.id);
      expect(own).toHaveLength(1);
      expect(BigInt(own[0]?.['amount'] as string)).toBe(m.fee);
    }

    // Each member's ledger, by its application, holds its own plan fee and none of the
    // other's; the two together are exactly the members' fees, nothing counted twice.
    const planFeeIncome = async (applicationIds: string[]) => {
      const { rows } = await h.owner.query<Row>(
        `SELECT coalesce(sum(CASE e.direction WHEN 'credit' THEN e.amount_rial ELSE -e.amount_rial END), 0)::text AS net
           FROM ledger_entries e
           JOIN ledger_accounts a ON a.id = e.account_id
           JOIN journal_entries j ON j.id = e.journal_entry_id
          WHERE a.code = 'company.fee_income' AND j.event_type = 'repayment.plan_fee'
            AND j.credit_application_id = ANY($1::uuid[])`,
        [applicationIds],
      );
      return BigInt(rows[0]?.['net'] as string);
    };
    const each = await Promise.all(members.map((m) => planFeeIncome([m.id])));
    expect(each).toEqual(members.map((m) => m.fee));
    const together = await planFeeIncome(ids);
    expect(together).toBe(560_000n + 400_000n);
    expect(together).toBe(each.reduce((a, b) => a + b, 0n));
    await ledgerSound();
  });

  it('§9 test 10: tells the patient the amounts, the doctor none', async () => {
    const { patient, applicationId } = await approvedApplication();
    await complete(patient, applicationId);
    const asked = await ask(applicationId);
    const approved = await w.staff(
      finance,
      'POST',
      `/funding/requests/${asked.body['id'] as string}/approve`,
    );
    const doctorAccount = (
      await h.owner.query<Row>(
        `SELECT payload->>'doctorAccountId' AS d FROM outbox_events
          WHERE event_type = 'wallet.funded' AND aggregate_id = $1`,
        [approved.body['id']],
      )
    ).rows[0]?.['d'] as string | null;
    const sent: { mobile: string; text: string }[] = [];
    const notifier = new FundingNotifier(
      { register: () => undefined },
      h.app.get(CONFIG),
      h.app.get(CREDIT_CONTRACT_FACTS),
      h.app.get(LEAD_CASES),
      h.app.get(ACCOUNT_DIRECTORY),
      h.app.get(WALLET),
      h.app.get(REPAYMENT),
      {
        sendText: (message) => {
          sent.push(message);
          return Promise.resolve();
        },
      },
    );
    const db = h.app.get<Database>(DATABASE);
    await db.transaction((tx) =>
      notifier.handle(
        {
          id: randomUUID(),
          type: 'wallet.funded',
          aggregateType: 'funding_request',
          aggregateId: approved.body['id'] as string,
          payload: {
            fundingRequestId: approved.body['id'],
            creditApplicationId: applicationId,
            caseId: randomUUID(),
            purseId: approved.body['purseId'],
            scheduleId: approved.body['scheduleId'],
            doctorAccountId: doctorAccount ?? w.doctor.id,
          },
          occurredAt: new Date().toISOString(),
        },
        tx,
      ),
    );
    const toPatient = sent.find((s) => s.mobile === patient.mobile);
    expect(toPatient?.text).toContain('۱٬۲۰۰٬۰۰۰ تومان');
    const toDoctor = sent.filter((s) => s.mobile !== patient.mobile);
    expect(toDoctor).toHaveLength(1);
    expect(toDoctor[0]?.text).not.toMatch(/تومان|ریال|[۰-۹0-9]/);
  });
});

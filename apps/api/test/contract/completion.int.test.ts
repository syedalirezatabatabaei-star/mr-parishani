import { randomUUID } from 'node:crypto';
import type { INestApplicationContext } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CONFIG } from '../../src/common/config/config.port';
import { OUTBOX } from '../../src/common/events/outbox.port';
import { OBJECT_STORAGE, type ObjectStorage } from '../../src/common/storage/object-storage.port';
import { DATABASE, type Database } from '../../src/db/database.module';
import type { Alert, AlertSink } from '../../src/infra/ops/alerts';
import type { EffectiveAccess } from '../../src/common/auth/access.port';
import { CompletionService } from '../../src/modules/contract/completion.service';
import { ContractPrinter } from '../../src/modules/contract/contract-printer';
import { LedgerReconciliation } from '../../src/modules/ledger/reconciliation';
import { WorkerModule } from '../../src/worker.module';
import { startHarness, type Harness, type loggedInAccount } from '../identity/harness';
import {
  CREDIT_HARNESS,
  creditWorld,
  PDF,
  PLAN,
  type Body,
  type Patient,
  type Row,
} from '../credit/world';

/**
 * Task 4-3 [financial] (doc 12 §4; owner 1405/07/11): completion refused until every
 * condition holds (doc 12 §9 test 1), checked in the service; receipts approved by
 * finance only at the exact amount owed, the fees posting debit bank.collection and credit
 * company.fee_income through the ledger's port once, the down payment (from task 4-5,
 * ADR-034) debiting bank.collection and crediting the borrower's downpayment.held once, on
 * its link row, its receipt's row as 4-3 left it;
 * the ledger balanced and the nightly reconciliation clean after it (doc 13).
 */

let h: Harness;
let w: Awaited<ReturnType<typeof creditWorld>>;
type Staff = Awaited<ReturnType<typeof loggedInAccount>>;
let manager: Staff;
let finance: Staff;
let worker: INestApplicationContext | undefined;
const alerts: Alert[] = [];
const sink: AlertSink = {
  raise(alert) {
    alerts.push(alert);
    return Promise.resolve();
  },
};

/** The plan of the world with its fee paid at completion (doc 10 §3, `at_completion`). */
const AT_COMPLETION = {
  ...PLAN,
  code: 'dental_12_ac',
  title: 'طرح دندانپزشکی، کارمزد هنگام تکمیل',
  planFee: { basis: 'percent', bps: 1000, timing: 'at_completion' },
} as const;

const alef = {
  job: 'official',
  employmentStartedOn: { year: 1398, month: 1, day: 1 },
  coverage: 'full',
  obligationsRial: '1000000',
  newInstallmentRial: '4000000',
};

beforeAll(async () => {
  h = await startHarness(CREDIT_HARNESS);
  w = await creditWorld(h);
  manager = await w.role('credit_manager');
  finance = await w.role('accounting');
  // The second plan, proposed by one strategy manager and approved by another.
  const [a, b] = [await w.role('strategy_manager'), await w.role('strategy_manager')];
  const proposal = await w.staff(a, 'POST', '/config/proposals', {
    key: 'credit.plans',
    scope: { level: 'global' },
    value: { plans: [PLAN, AT_COMPLETION] },
    reason: 'طرح با کارمزد هنگام تکمیل',
  });
  expect(
    (await w.staff(b, 'POST', `/config/proposals/${proposal.body['id'] as string}/approve`)).status,
  ).toBe(200);
  worker = await NestFactory.createApplicationContext(
    WorkerModule.forRoot({ alertSink: sink, relayLoop: false }),
    { logger: false },
  );
}, 180_000);

afterAll(async () => {
  await worker?.close();
  await h.close();
});

/** Conditionally approved with one condition, on the plan with its fee at completion. */
async function conditional() {
  const { patient, proformaId } = await w.confirmedProforma();
  const made = await w.as(patient, 'POST', '/me/credit-applications', {
    proformaId,
    planCode: AT_COMPLETION.code,
    installmentCount: 12,
  });
  const applicationId = made.body['id'] as string;
  await w.as(patient, 'POST', `/me/credit-applications/${applicationId}/submit`);
  await w.consent(patient, applicationId, 'borrower');
  await w.documented(patient, applicationId, 'borrower');
  await w.staff(w.completion, 'POST', `/credit/applications/${applicationId}/ready-for-review`);
  await w.staff(w.creditSpecialist, 'POST', `/credit/applications/${applicationId}/score-sheets`, {
    subject: 'borrower',
    raw: alef,
  });
  await w.staff(w.creditSpecialist, 'POST', `/credit/applications/${applicationId}/to-decision`);
  const proposed = await w.staff(
    w.creditSpecialist,
    'POST',
    `/credit/applications/${applicationId}/decisions`,
    {
      outcome: 'conditional',
      conditions: ['چک ضمانت به مبلغ کل اقساط'],
      reason: 'رتبه الف؛ چک ضمانت لازم است',
    },
  );
  await w.staff(
    manager,
    'POST',
    `/credit/applications/${applicationId}/decisions/${proposed.body['id'] as string}/confirm`,
  );
  return { patient, applicationId };
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

const missingOf = async (applicationId: string) =>
  (await w.staff(w.completion, 'POST', `/completion/${applicationId}/complete`)).body['missing'];

describe('completion (doc 12 §4; §9 test 1)', () => {
  it('is refused until every condition holds; each receipt posts once (ADR-034)', async () => {
    const { patient, applicationId } = await conditional();
    const before = await w.staff(w.completion, 'GET', `/completion/${applicationId}`);
    expect(before.body['owed']).toEqual([
      { kind: 'origination_fee', expectedRial: '500000', approved: false },
      { kind: 'plan_fee', expectedRial: '960000', approved: false },
      { kind: 'down_payment', expectedRial: '2400000', approved: false },
    ]);
    expect(await missingOf(applicationId)).toEqual([
      'contract',
      'delivery',
      'condition:0',
      'receipt:origination_fee',
      'receipt:plan_fee',
      'receipt:down_payment',
    ]);

    // The contract: asked for, printed, accepted by the borrower.
    const contract = await w.staff(w.completion, 'POST', '/contracts', {
      creditApplicationId: applicationId,
    });
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
          aggregateId: contract.body['id'] as string,
          payload: { contractId: contract.body['id'], creditApplicationId: applicationId },
          occurredAt: new Date().toISOString(),
        },
        tx,
      ),
    );
    const contractId = contract.body['id'] as string;
    await w.as(patient, 'POST', `/me/contracts/${contractId}/acceptance/request`, {
      role: 'borrower',
    });
    await w.as(patient, 'POST', `/me/contracts/${contractId}/acceptance`, {
      role: 'borrower',
      code: h.sms.lastCodeFor(patient.mobile),
    });

    // The delivery: the signed contract came and was checked.
    const delivery = await w.staff(w.completion, 'POST', '/deliveries', {
      creditApplicationId: applicationId,
      items: [{ kind: 'signed_contract', label: 'قرارداد امضاشده' }],
    });
    const deliveryId = delivery.body['id'] as string;
    await w.staff(w.completion, 'POST', `/deliveries/${deliveryId}/receive`, {
      method: 'in_person',
    });
    await w.staff(
      w.completion,
      'POST',
      `/deliveries/${deliveryId}/items/${(delivery.body['items'] as Body[])[0]?.['id'] as string}`,
      { status: 'received' },
    );
    await w.staff(w.completion, 'POST', `/deliveries/${deliveryId}/check`);
    // The condition, ticked by case completion, once.
    expect(
      (
        await w.staff(
          w.doctor,
          'POST',
          `/credit/applications/${applicationId}/conditions/0/check`,
          {},
        )
      ).status,
    ).toBe(403);
    expect(
      (
        await w.staff(
          w.completion,
          'POST',
          `/credit/applications/${applicationId}/conditions/0/check`,
          { note: 'چک رسید' },
        )
      ).status,
    ).toBe(201);
    expect(
      (
        await w.staff(
          w.completion,
          'POST',
          `/credit/applications/${applicationId}/conditions/0/check`,
          {},
        )
      ).body['error'],
    ).toBe('already_checked');
    expect(await missingOf(applicationId)).toEqual([
      'receipt:origination_fee',
      'receipt:plan_fee',
      'receipt:down_payment',
    ]);

    // Receipts: only what is owed, by its own payer; the exact amount only (owner, پ۴).
    const stranger = await w.patient();
    expect(
      (
        await upload(stranger, applicationId, {
          kind: 'origination_fee',
          amountRial: '500000',
          paidOn: '2026-10-01',
          reference: 'REF-1',
        })
      ).status,
    ).toBe(404);
    const wrong = await upload(patient, applicationId, {
      kind: 'origination_fee',
      amountRial: '400000',
      paidOn: '2026-10-01',
      reference: 'REF-1',
    });
    expect(wrong.status).toBe(201);
    expect(
      (await w.staff(w.completion, 'POST', `/receipts/${wrong.body['id'] as string}/approve`))
        .status,
    ).toBe(403);
    const mismatch = await w.staff(
      finance,
      'POST',
      `/receipts/${wrong.body['id'] as string}/approve`,
    );
    expect(mismatch.body).toMatchObject({ error: 'amount_mismatch', expectedRial: '500000' });
    expect(
      (
        await upload(patient, applicationId, {
          kind: 'origination_fee',
          amountRial: '500000',
          paidOn: '2026-10-01',
          reference: 'REF-2',
        })
      ).body['error'],
    ).toBe('receipt_exists');
    expect(
      (
        await w.staff(finance, 'POST', `/receipts/${wrong.body['id'] as string}/reject`, {
          reason: 'مبلغ فیش کمتر از هزینه تشکیل پرونده است',
        })
      ).body['status'],
    ).toBe('rejected');

    const ids: Record<string, string> = {};
    for (const [kind, amountRial] of [
      ['origination_fee', '500000'],
      ['plan_fee', '960000'],
      ['down_payment', '2400000'],
    ] as const) {
      const sent = await upload(patient, applicationId, {
        kind,
        amountRial,
        paidOn: '2026-10-01',
        reference: `REF-${kind}`,
      });
      expect(sent.status).toBe(201);
      ids[kind] = sent.body['id'] as string;
    }
    const pending = await w.staff(finance, 'GET', '/receipts');
    expect((pending.body as unknown as Body[]).map((r) => r['id'])).toEqual(
      expect.arrayContaining(Object.values(ids)),
    );
    const approvals: Body[] = [];
    for (const kind of ['origination_fee', 'plan_fee', 'down_payment']) {
      const approved = await w.staff(finance, 'POST', `/receipts/${ids[kind] ?? ''}/approve`);
      expect(approved.body['status']).toBe('approved');
      approvals.push(approved.body);
    }
    // Approving twice posts nothing more (rule 5).
    const again = await w.staff(
      finance,
      'POST',
      `/receipts/${ids['origination_fee'] ?? ''}/approve`,
    );
    expect(again.body['journalEntryId']).toBe(approvals[0]?.['journalEntryId']);
    // The down payment's receipt row keeps no journal (owner, decision 3: unchanged); its
    // posting is on the link row (ADR-034, task 4-5).
    expect(approvals[2]?.['journalEntryId']).toBeNull();
    const { rows: links } = await h.owner.query<Row>(
      'SELECT amount_rial::text AS amount FROM down_payment_postings WHERE receipt_id = $1',
      [ids['down_payment']],
    );
    expect(links).toEqual([{ amount: '2400000' }]);

    // The fees' journals: debit bank.collection, credit company.fee_income, each once; the
    // down payment's: debit bank.collection, credit downpayment.held, once.
    const { rows: lines } = await h.owner.query<Row>(
      `SELECT j.event_type, a.code, e.direction, e.amount_rial::text AS amount
         FROM journal_entries j JOIN ledger_entries e ON e.journal_entry_id = j.id
         JOIN ledger_accounts a ON a.id = e.account_id
        WHERE j.credit_application_id = $1 ORDER BY j.event_type, e.direction DESC`,
      [applicationId],
    );
    expect(lines).toEqual([
      {
        event_type: 'contract.down_payment_received',
        code: 'bank.collection',
        direction: 'debit',
        amount: '2400000',
      },
      {
        event_type: 'contract.down_payment_received',
        code: 'downpayment.held',
        direction: 'credit',
        amount: '2400000',
      },
      {
        event_type: 'contract.origination_fee_received',
        code: 'bank.collection',
        direction: 'debit',
        amount: '500000',
      },
      {
        event_type: 'contract.origination_fee_received',
        code: 'company.fee_income',
        direction: 'credit',
        amount: '500000',
      },
      {
        event_type: 'contract.plan_fee_received',
        code: 'bank.collection',
        direction: 'debit',
        amount: '960000',
      },
      {
        event_type: 'contract.plan_fee_received',
        code: 'company.fee_income',
        direction: 'credit',
        amount: '960000',
      },
    ]);
    // A decided receipt never changes.
    await expect(
      h.owner.query(
        `UPDATE completion_receipts SET status = 'rejected', rejection_reason = 'x' WHERE id = $1`,
        [ids['origination_fee']],
      ),
    ).rejects.toThrow(/decided/);

    // Now complete; once.
    // Two completions at once: one is recorded, the other refused (unique per application).
    const both = await Promise.all([
      w.staff(w.completion, 'POST', `/completion/${applicationId}/complete`),
      w.staff(w.completion, 'POST', `/completion/${applicationId}/complete`),
    ]);
    expect(both.map((r) => r.status).sort()).toEqual([201, 409]);
    const done = both.find((r) => r.status === 201) ?? both[0];
    expect(both.find((r) => r.status === 409)?.body['error']).toBe('already_completed');
    const { rows: recorded } = await h.owner.query<Row>(
      'SELECT count(*)::int AS n FROM case_completions WHERE credit_application_id = $1',
      [applicationId],
    );
    expect(recorded[0]?.['n']).toBe(1);
    expect(done.body).toMatchObject({
      missing: [],
      contractAccepted: true,
      deliveryVerified: true,
    });
    expect(done.body['completedAt']).toEqual(expect.any(String));
    expect(
      (await w.staff(w.completion, 'POST', `/completion/${applicationId}/complete`)).body['error'],
    ).toBe('already_completed');
    expect(
      (
        await upload(patient, applicationId, {
          kind: 'origination_fee',
          amountRial: '500000',
          paidOn: '2026-10-01',
          reference: 'REF-9',
        })
      ).body['error'],
    ).toBe('already_completed');
  });

  it('posts income only to aramesh, whatever a contract says (ADR-007)', async () => {
    const { patient, applicationId } = await conditional();
    // A contract under another entity, as if it came from the database.
    const { rows: version } = await h.owner.query<Row>(
      `SELECT id FROM config_values WHERE key = 'contract.loan_template' AND status = 'approved' LIMIT 1`,
    );
    await h.owner.query(
      `INSERT INTO contracts (credit_application_id, entity_id, jalali_year, sequence, number,
         template_version_id, fields, sample, parties, created_by)
       VALUES ($1, 'sepehr', 1405, 999999, '1405-999999', $2, '{}'::jsonb, true, '[]'::jsonb, $3)`,
      [applicationId, version[0]?.['id'], w.completion.id],
    );
    const sent = await upload(patient, applicationId, {
      kind: 'origination_fee',
      amountRial: '500000',
      paidOn: '2026-10-01',
      reference: 'REF-ENTITY',
    });
    const refused = await w.staff(
      finance,
      'POST',
      `/receipts/${sent.body['id'] as string}/approve`,
    );
    expect(refused.status).toBe(409);
    expect(refused.body).toMatchObject({ error: 'entity_not_allowed', entityId: 'sepehr' });
    const { rows } = await h.owner.query<Row>(
      `SELECT (SELECT count(*)::int FROM journal_entries WHERE credit_application_id = $1) AS journals,
              (SELECT status FROM completion_receipts WHERE id = $2) AS status`,
      [applicationId, sent.body['id']],
    );
    expect(rows[0]).toEqual({ journals: 0, status: 'pending_approval' });
  });

  it('is never approved by who uploaded it (maker-checker, doc 04 §5)', async () => {
    const { patient, applicationId } = await conditional();
    const sent = await upload(patient, applicationId, {
      kind: 'origination_fee',
      amountRial: '500000',
      paidOn: '2026-10-01',
      reference: 'REF-SAME',
    });
    // A patient-kind account holds no role, so through the API no uploader can approve;
    // the service refuses it anyway, should an uploader ever hold the permission.
    const uploader = patient.id;
    const access: EffectiveAccess = {
      accountId: uploader,
      roles: ['accounting'],
      permissions: new Set(['repayment.approve_payment']),
      scopes: [{ kind: 'global' }],
    };
    await expect(
      h.app
        .get(CompletionService)
        .approve(
          { accountId: uploader, sessionId: null, ip: null, roles: ['accounting'] },
          access,
          sent.body['id'] as string,
        ),
    ).rejects.toMatchObject({ response: { error: 'same_person' } });
    const { rows } = await h.owner.query<Row>(
      `SELECT (SELECT count(*)::int FROM journal_entries WHERE credit_application_id = $1) AS journals,
              (SELECT status FROM completion_receipts WHERE id = $2) AS status`,
      [applicationId, sent.body['id']],
    );
    expect(rows[0]).toEqual({ journals: 0, status: 'pending_approval' });
  });

  it('leaves the ledger balanced and the nightly reconciliation clean (doc 13)', async () => {
    const { rows } = await h.owner.query<Row>(
      `SELECT coalesce(sum(amount_rial) FILTER (WHERE direction = 'debit'), 0)::text AS d,
              coalesce(sum(amount_rial) FILTER (WHERE direction = 'credit'), 0)::text AS c
         FROM ledger_entries`,
    );
    expect(rows[0]?.['d']).toBe(rows[0]?.['c']);
    const { rows: unbalanced } = await h.owner.query<Row>(
      `SELECT journal_entry_id FROM ledger_entries GROUP BY journal_entry_id
       HAVING sum(CASE WHEN direction = 'debit' THEN amount_rial ELSE -amount_rial END) <> 0`,
    );
    expect(unbalanced).toEqual([]);
    alerts.length = 0;
    const result = await (worker as INestApplicationContext).get(LedgerReconciliation).run();
    expect(result).toMatchObject({ clean: true, discrepancies: [], overdueUnapplied: 0 });
    expect(alerts).toEqual([]);
  });
});

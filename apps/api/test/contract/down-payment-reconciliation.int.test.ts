import { randomUUID } from 'node:crypto';
import type { INestApplicationContext } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CLI_ACTOR } from '../../src/common/auth/actor';
import {
  CREDIT_CONTRACT_FACTS,
  type CreditContractFactsPort,
} from '../../src/common/credit/credit-contract-facts.port';
import { LEDGER, type LedgerPort } from '../../src/common/ledger/ledger.port';
import type { Alert, AlertSink } from '../../src/infra/ops/alerts';
import {
  DOWN_PAYMENT_ALERT,
  DownPaymentReconciliation,
  type DownPaymentIssue,
} from '../../src/modules/contract/down-payment-reconciliation';
import { WorkerModule } from '../../src/worker.module';
import { startHarness, type Harness, type loggedInAccount } from '../identity/harness';
import { fundingSteps } from '../credit/funding-steps';
import { CREDIT_HARNESS, creditWorld, type Row } from '../credit/world';

/**
 * Task 4-6b [financial] (doc 02 §7; ADR-034 item 9; owner 1405/07/13): the nightly
 * reconciliation of down payments, read only. الف: each approved receipt, one posting of
 * its amount; ب: each borrower's downpayment.held equals their postings neither funded nor
 * reversed; ج: a funded posting is the down payment its purse took in. Clean on sound data;
 * each corruption found; a count-only alert; run again, the same; nothing written.
 */

type Staff = Awaited<ReturnType<typeof loggedInAccount>>;

let h: Harness;
let w: Awaited<ReturnType<typeof creditWorld>>;
let finance: Staff;
let steps: ReturnType<typeof fundingSteps>;
let worker: INestApplicationContext | undefined;
const alerts: Alert[] = [];
const sink: AlertSink = {
  raise(alert) {
    alerts.push(alert);
    return Promise.resolve();
  },
};

const DOWN = 2_400_000n; // 20% of the world's 12,000,000 proforma

beforeAll(async () => {
  h = await startHarness(CREDIT_HARNESS);
  w = await creditWorld(h);
  const manager = await w.role('credit_manager');
  finance = await w.role('accounting');
  steps = fundingSteps(h, w, { manager, finance });
  worker = await NestFactory.createApplicationContext(
    WorkerModule.forRoot({ alertSink: sink, relayLoop: false }),
    { logger: false },
  );
}, 180_000);

afterAll(async () => {
  await worker?.close();
  await h.close();
});

const reconcile = () => (worker as INestApplicationContext).get(DownPaymentReconciliation).run();
const ledger = () => h.app.get<LedgerPort>(LEDGER);
const borrowerOf = async (applicationId: string) =>
  (await h.app.get<CreditContractFactsPort>(CREDIT_CONTRACT_FACTS).facts(applicationId))
    ?.borrowerPersonId ?? '';

/** Every row the ledger has: the reconciliation must add none. */
async function ledgerRows() {
  const { rows } = await h.owner.query<Row>(
    `SELECT (SELECT count(*)::int FROM journal_entries) AS journals,
            (SELECT count(*)::int FROM ledger_entries) AS entries,
            (SELECT count(*)::int FROM ledger_accounts) AS accounts`,
  );
  return rows[0];
}

const heldAccount = (borrowerPersonId: string) =>
  ledger().openAccount({
    entityId: 'aramesh',
    code: 'downpayment.held',
    name: 'پیش‌پرداخت نزد آرامش',
    kind: 'liability',
    ownerType: 'borrower',
    ownerId: borrowerPersonId,
  });
const bank = () =>
  ledger().openAccount({
    entityId: 'aramesh',
    code: 'bank.collection',
    name: 'حساب دریافت',
    kind: 'asset',
    ownerType: 'company',
    ownerId: null,
  });

/** A journal outside every rule, as a fault would leave it: Dr bank, Cr held (or reverse). */
async function strayJournal(borrowerPersonId: string, amount: bigint, toHeld = true) {
  const held = (await heldAccount(borrowerPersonId)).id;
  const bankId = (await bank()).id;
  return ledger().postJournal(CLI_ACTOR, {
    entityId: 'aramesh',
    eventType: 'contract.down_payment_received',
    occurredAt: new Date(),
    idempotencyKey: `test:stray:${randomUUID()}`,
    lines: [
      { accountId: toHeld ? bankId : held, direction: 'debit', amountRial: amount },
      { accountId: toHeld ? held : bankId, direction: 'credit', amountRial: amount },
    ],
  });
}

/** An approved down-payment receipt written as data, as 4-3 left them (no posting). */
async function approvedReceipt(applicationId: string, amount: bigint) {
  const { rows } = await h.owner.query<Row>(
    `INSERT INTO completion_receipts (credit_application_id, kind, amount_rial, expected_rial,
       paid_on, reference, storage_key, mime, size_bytes, sha256, status, uploaded_by,
       decided_by, decided_at)
     VALUES ($1, 'down_payment', $2, $2, '2026-10-01', $3, $4, 'application/pdf', 100, $5,
       'approved', $6, $7, now())
     RETURNING id`,
    [
      applicationId,
      amount.toString(),
      `REF-${randomUUID().slice(0, 8)}`,
      `test/${randomUUID()}`,
      'a'.repeat(64),
      w.completion.id,
      finance.id,
    ],
  );
  return rows[0]?.['id'] as string;
}

async function posting(input: {
  receiptId: string;
  applicationId: string;
  borrowerPersonId: string;
  amount: bigint;
  journalEntryId: string;
  fundedPurseId?: string;
}) {
  const { rows } = await h.owner.query<Row>(
    `INSERT INTO down_payment_postings (receipt_id, credit_application_id, borrower_person_id,
       entity_id, amount_rial, journal_entry_id, created_by, funded_purse_id, funded_at)
     VALUES ($1, $2, $3, 'aramesh', $4, $5, $6, $7::uuid, CASE WHEN $7::uuid IS NULL THEN NULL ELSE now() END)
     RETURNING id`,
    [
      input.receiptId,
      input.applicationId,
      input.borrowerPersonId,
      input.amount.toString(),
      input.journalEntryId,
      finance.id,
      input.fundedPurseId ?? null,
    ],
  );
  return rows[0]?.['id'] as string;
}

const kinds = (issues: readonly DownPaymentIssue[]) => issues.map((i) => i.kind).sort();

describe('down payments reconciliation (task 4-6b; doc 02 §7)', () => {
  let fundedPurseId = '';
  let heldApplication = '';

  it('is clean on sound data: funded, held, reversed (الف, ب, ج); writes nothing; again the same', async () => {
    // Funded: posted at its receipt, moved into the purse at funding (held back to zero).
    const a = await steps.approved();
    await steps.complete(a.patient, a.applicationId);
    fundedPurseId = await steps.fund(a.applicationId);
    // Completed, not funded: held.
    const b = await steps.approved();
    await steps.complete(b.patient, b.applicationId);
    heldApplication = b.applicationId;
    // Reversed by finance before funding: posted, then its full opposite.
    const c = await steps.approved();
    const { receipts } = await steps.complete(c.patient, c.applicationId);
    const reversed = await w.staff(
      finance,
      'POST',
      `/receipts/${receipts['down_payment'] ?? ''}/reverse-down-payment`,
      { reason: 'برگشت آزمون' },
    );
    expect(reversed.status).toBe(201);

    const before = await ledgerRows();
    const first = await reconcile();
    expect(first).toMatchObject({ clean: true, issues: [] });
    expect(first.receiptsChecked).toBe(3);
    expect(first.accountsChecked).toBe(3);
    expect(first.pursesChecked).toBe(1);
    // ب, by the ledger itself: the held one holds the down payment, the others nothing.
    for (const [app, held] of [
      [a.applicationId, 0n],
      [b.applicationId, DOWN],
      [c.applicationId, 0n],
    ] as const) {
      const account = await ledger().findAccount({
        entityId: 'aramesh',
        code: 'downpayment.held',
        ownerType: 'borrower',
        ownerId: await borrowerOf(app),
      });
      const balance = await ledger().balanceOf(account?.id ?? '');
      expect(balance.creditRial - balance.debitRial).toBe(held);
    }
    const again = await reconcile();
    expect(again).toEqual(first);
    expect(await ledgerRows()).toEqual(before);
    expect(alerts).toEqual([]);
  });

  it('finds each corruption (الف, ب, ج), alerts with counts only, the same again, and writes nothing', async () => {
    // الف: an approved receipt with no posting.
    const r1 = await steps.approved();
    const orphanReceipt = await approvedReceipt(r1.applicationId, DOWN);

    // الف: a posting of another amount than its receipt.
    const r2 = await steps.approved();
    const borrower2 = await borrowerOf(r2.applicationId);
    const wrongReceipt = await approvedReceipt(r2.applicationId, DOWN);
    const short = await strayJournal(borrower2, 2_000_000n);
    await posting({
      receiptId: wrongReceipt,
      applicationId: r2.applicationId,
      borrowerPersonId: borrower2,
      amount: 2_000_000n,
      journalEntryId: short.id,
    });

    // ب: a held balance unlike its postings (100,000 rials credited outside any receipt).
    const heldBorrower = await borrowerOf(heldApplication);
    await strayJournal(heldBorrower, 100_000n);
    const heldId = (await heldAccount(heldBorrower)).id;

    // ج: a posting said funded into a purse whose down payment is another.
    const r3 = await steps.approved();
    const borrower3 = await borrowerOf(r3.applicationId);
    const extraReceipt = await approvedReceipt(r3.applicationId, 1_000_000n);
    const extra = await strayJournal(borrower3, 1_000_000n);
    await strayJournal(borrower3, 1_000_000n, false); // moved out, as funding would
    await posting({
      receiptId: extraReceipt,
      applicationId: r3.applicationId,
      borrowerPersonId: borrower3,
      amount: 1_000_000n,
      journalEntryId: extra.id,
      fundedPurseId,
    });

    const before = await ledgerRows();
    const found = await reconcile();
    expect(found.clean).toBe(false);
    expect(kinds(found.issues)).toEqual(
      [
        'funded_amount_differs',
        'held_balance_differs',
        'posting_amount_differs',
        'receipt_without_posting',
      ].sort(),
    );
    expect(found.issues).toEqual(
      expect.arrayContaining([
        {
          kind: 'receipt_without_posting',
          receiptId: orphanReceipt,
          expectedRial: '2400000',
          actualRial: '0',
        },
        expect.objectContaining({
          kind: 'posting_amount_differs',
          receiptId: wrongReceipt,
          expectedRial: '2400000',
          actualRial: '2000000',
        }),
        {
          kind: 'held_balance_differs',
          accountId: heldId,
          expectedRial: '2400000',
          actualRial: '2500000',
        },
        {
          kind: 'funded_amount_differs',
          purseId: fundedPurseId,
          expectedRial: '3400000',
          actualRial: '2400000',
        },
      ]),
    );
    // One alert, counts only: no amount, name or id.
    expect(alerts).toHaveLength(1);
    expect(alerts[0]?.code).toBe(DOWN_PAYMENT_ALERT);
    expect(alerts[0]?.message).not.toMatch(/2400000|2500000|1000000|[0-9a-f]{8}-/);
    expect(alerts[0]?.message).toContain('receipt_without_posting 1');

    // Run again: the same findings, and still nothing written to the ledger.
    const again = await reconcile();
    expect(kinds(again.issues)).toEqual(kinds(found.issues));
    expect(await ledgerRows()).toEqual(before);
  });

  it('finds a held balance no posting points at (b8, the orphan), by the ledger total; writes nothing', async () => {
    // A borrower with no receipt and no posting at all: ب never looks at their account.
    const lone = await steps.approved();
    const loneBorrower = await borrowerOf(lone.applicationId);
    const ORPHAN = 300_000n;
    await strayJournal(loneBorrower, ORPHAN);
    const earlier = alerts.length;

    const before = await ledgerRows();
    const found = await reconcile();
    const total = found.issues.filter((i) => i.kind === 'held_total_differs');
    expect(total).toHaveLength(1);
    expect(total[0]).toMatchObject({ entityId: 'aramesh' });
    // What the ledger holds beyond what ب accounted for is the orphan, to the rial.
    expect(BigInt(total[0]?.actualRial ?? '0') - BigInt(total[0]?.expectedRial ?? '0')).toBe(
      ORPHAN,
    );
    // The account ب checks per borrower is not the orphan's: it is found by the total alone.
    const orphanAccount = (await heldAccount(loneBorrower)).id;
    expect(found.issues.some((i) => i.accountId === orphanAccount)).toBe(false);
    expect(alerts).toHaveLength(earlier + 1);
    expect(alerts.at(-1)?.message).toContain('held_total_differs 1');
    expect(alerts.at(-1)?.message).not.toMatch(/300000|[0-9a-f]{8}-/);
    expect(await ledgerRows()).toEqual(before);
  });
});

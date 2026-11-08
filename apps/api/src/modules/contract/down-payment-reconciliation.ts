import { Inject, Injectable, Logger } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { LEDGER, type LedgerPort } from '../../common/ledger/ledger.port';
import {
  SETTLEMENT_REFUNDS,
  type SettlementRefunds,
} from '../../common/settlement/settlement-refunds.port';
import { WALLET, type WalletPort } from '../../common/wallet/wallet.port';
import { DATABASE, type Database } from '../../db/database.module';
import { ALERT_SINK, type AlertSink } from '../../infra/ops/alerts';

export type DownPaymentIssueKind =
  | 'receipt_without_posting'
  | 'posting_amount_differs'
  | 'held_account_missing'
  | 'held_balance_differs'
  | 'held_total_differs'
  | 'funded_amount_differs'
  | 'refund_balance_differs';

/** One finding; ids only (rule 30), amounts as whole-rial text. */
export interface DownPaymentIssue {
  readonly kind: DownPaymentIssueKind;
  readonly receiptId?: string;
  readonly postingId?: string;
  readonly accountId?: string;
  readonly purseId?: string;
  readonly entityId?: string;
  readonly expectedRial: string;
  readonly actualRial: string;
}

export interface DownPaymentReconciliationResult {
  readonly clean: boolean;
  readonly receiptsChecked: number;
  readonly accountsChecked: number;
  readonly pursesChecked: number;
  readonly issues: readonly DownPaymentIssue[];
}

export const DOWN_PAYMENT_ALERT = 'down_payment_mismatch';

type Row = Record<string, unknown>;
const big = (v: unknown) => BigInt((v as string | null) ?? '0');

/**
 * The nightly reconciliation of down payments (task 4-6b [financial]; doc 02 §7; ADR-034
 * item 9; owner 1405/07/13). On the primary (owner, پ۴: no new grant for the reporting
 * role), through the existing LEDGER and WALLET ports and the contract module's own tables;
 * الف and ب in one REPEATABLE READ, READ ONLY snapshot, ج's purses read after it:
 *
 *   الف. every approved down-payment receipt has exactly one posting of its own amount;
 *   ب.  each borrower's `downpayment.held` (per legal entity) holds exactly their postings
 *       neither funded, reversed nor refunded: approved receipts − funded − reversed −
 *       refunded on a cancellation before funding (task 4-8);
 *   ج.  a funded posting's amount is the down payment its purse took in;
 *   د.  each borrower's refund account (`fee.refund_payable`, `downpayment.refund_payable`)
 *       holds what was put there less what was paid out (task 4-8; owner 1405/07/14): the
 *       refunds of a cancellation before funding, plus (down payment) the cancellations after
 *       funding net of their reversals, less the approved bank payments.
 *
 *     And per legal entity, the ledger's total over every `downpayment.held` account equals
 *     the balances ب read: a balance on an account no posting points at (an «orphan», b8)
 *     shows as the difference (owner 1405/07/23, plan 1).
 *
 * Writes nothing anywhere (owner, پ۳: no table): a finding is a count-only alert and a log
 * line.
 */
@Injectable()
export class DownPaymentReconciliation {
  private readonly logger = new Logger(DownPaymentReconciliation.name);

  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(LEDGER) private readonly ledger: LedgerPort,
    @Inject(WALLET) private readonly wallet: WalletPort,
    @Inject(SETTLEMENT_REFUNDS) private readonly settlement: SettlementRefunds,
    @Inject(ALERT_SINK) private readonly alerts: AlertSink,
  ) {}

  async run(): Promise<DownPaymentReconciliationResult> {
    const snapshot = await this.db.transaction(
      async (tx) => {
        const issues: DownPaymentIssue[] = [];

        // الف: each approved receipt, its one posting, the same amount.
        const receipts = await tx.execute(sql`
          SELECT r.id, r.amount_rial::text AS amount,
                 count(p.id)::int AS postings,
                 min(p.id::text) AS posting_id,
                 min(p.amount_rial)::text AS posted
          FROM completion_receipts r
          LEFT JOIN down_payment_postings p ON p.receipt_id = r.id
          WHERE r.kind = 'down_payment' AND r.status = 'approved'
          GROUP BY r.id, r.amount_rial
        `);
        for (const r of receipts.rows) {
          if (Number(r['postings']) === 0) {
            issues.push({
              kind: 'receipt_without_posting',
              receiptId: r['id'] as string,
              expectedRial: r['amount'] as string,
              actualRial: '0',
            });
          } else if (big(r['posted']) !== big(r['amount'])) {
            issues.push({
              kind: 'posting_amount_differs',
              receiptId: r['id'] as string,
              postingId: r['posting_id'] as string,
              expectedRial: r['amount'] as string,
              actualRial: r['posted'] as string,
            });
          }
        }

        // ب: per (entity, borrower) account, what is still held against its balance.
        const groups = await tx.execute(sql`
          SELECT p.entity_id, p.borrower_person_id,
                 coalesce(sum(p.amount_rial) FILTER (
                   WHERE p.funded_purse_id IS NULL AND p.reversal_journal_entry_id IS NULL
                     AND f.id IS NULL), 0)::text
                   AS held
          FROM down_payment_postings p
          LEFT JOIN completion_refunds f ON f.receipt_id = p.receipt_id
          GROUP BY p.entity_id, p.borrower_person_id
        `);
        // What ب saw, per entity: the balances of the accounts its postings point at.
        const seen = new Map<string, bigint>();
        for (const g of groups.rows as Row[]) {
          const expected = big(g['held']);
          const entityId = g['entity_id'] as string;
          const account = await this.ledger.findAccount(
            {
              entityId,
              code: 'downpayment.held',
              ownerType: 'borrower',
              ownerId: g['borrower_person_id'] as string,
            },
            tx,
          );
          if (!account) {
            issues.push({
              kind: 'held_account_missing',
              expectedRial: expected.toString(),
              actualRial: '0',
            });
            continue;
          }
          const balance = await this.ledger.balanceOf(account.id, undefined, tx);
          // A liability: what is held is credit minus debit.
          const actual = balance.creditRial - balance.debitRial;
          seen.set(entityId, (seen.get(entityId) ?? 0n) + actual);
          if (actual !== expected) {
            issues.push({
              kind: 'held_balance_differs',
              accountId: account.id,
              expectedRial: expected.toString(),
              actualRial: actual.toString(),
            });
          }
        }

        // ب, the whole: every held account of the entity, those no posting points at too.
        for (const t of await this.ledger.totalsOfCode('downpayment.held', tx)) {
          const total = t.creditRial - t.debitRial;
          const accounted = seen.get(t.entityId) ?? 0n;
          if (total !== accounted) {
            issues.push({
              kind: 'held_total_differs',
              entityId: t.entityId,
              expectedRial: accounted.toString(),
              actualRial: total.toString(),
            });
          }
        }

        // د: each refund account, what was put there less what was paid out.
        const expected = new Map<
          string,
          { entityId: string; borrower: string; code: string; rial: bigint }
        >();
        const add = (entityId: string, borrower: string, code: string, rial: bigint) => {
          const key = `${entityId}|${borrower}|${code}`;
          const at = expected.get(key) ?? { entityId, borrower, code, rial: 0n };
          expected.set(key, { ...at, rial: at.rial + rial });
        };
        const refunded = await tx.execute(sql`
          SELECT entity_id, borrower_person_id,
                 CASE kind WHEN 'down_payment' THEN 'downpayment.refund_payable'
                           ELSE 'fee.refund_payable' END AS code,
                 sum(amount_rial)::text AS rial
          FROM completion_refunds GROUP BY 1, 2, 3
        `);
        for (const r of refunded.rows as Row[]) {
          add(
            r['entity_id'] as string,
            r['borrower_person_id'] as string,
            r['code'] as string,
            big(r['rial']),
          );
        }
        for (const r of await this.wallet.downPaymentRefunds(tx)) {
          add(r.entityId, r.borrowerPersonId, 'downpayment.refund_payable', r.rial);
        }
        // Task 5-2b (owner 1405/07/15): a service taken back on a closed purse.
        for (const r of await this.settlement.downPaymentRefunds(tx)) {
          add(r.entityId, r.borrowerPersonId, 'downpayment.refund_payable', r.rial);
        }
        const paid = await tx.execute(sql`
          SELECT entity_id, borrower_person_id, account_code AS code, sum(amount_rial)::text AS rial
          FROM refund_payments WHERE status = 'approved' GROUP BY 1, 2, 3
        `);
        for (const r of paid.rows as Row[]) {
          add(
            r['entity_id'] as string,
            r['borrower_person_id'] as string,
            r['code'] as string,
            -big(r['rial']),
          );
        }
        for (const e of expected.values()) {
          const account = await this.ledger.findAccount(
            { entityId: e.entityId, code: e.code, ownerType: 'borrower', ownerId: e.borrower },
            tx,
          );
          const balance = account ? await this.ledger.balanceOf(account.id, undefined, tx) : null;
          const actual = balance ? balance.creditRial - balance.debitRial : 0n;
          if (actual !== e.rial) {
            issues.push({
              kind: 'refund_balance_differs',
              ...(account ? { accountId: account.id } : {}),
              expectedRial: e.rial.toString(),
              actualRial: actual.toString(),
            });
          }
        }

        // ج: what funding moved into each purse is the down payment posted for it.
        const funded = await tx.execute(sql`
          SELECT funded_purse_id, sum(amount_rial)::text AS amount
          FROM down_payment_postings
          WHERE funded_purse_id IS NOT NULL
          GROUP BY funded_purse_id
        `);
        return {
          issues,
          receiptsChecked: receipts.rows.length,
          accountsChecked: groups.rows.length,
          funded: funded.rows.map((f) => ({
            purseId: f['funded_purse_id'] as string,
            amount: big(f['amount']),
          })),
        };
      },
      { isolationLevel: 'repeatable read', accessMode: 'read only' },
    );

    // ج: the purse's down payment, through the wallet's summary. That is not a pure read
    // (phase 1: it opens the purse's accounts if missing), so it cannot run in the read-only
    // snapshot. A funded purse has its accounts, so it writes nothing; and both sides are
    // fixed once funded (a purse's down_payment_rial never changes, a posting is funded
    // once), so reading them apart finds nothing false.
    const issues = [...snapshot.issues];
    for (const f of snapshot.funded) {
      const purse = await this.wallet.summary(f.purseId);
      if (purse.downPaymentRial !== f.amount) {
        issues.push({
          kind: 'funded_amount_differs',
          purseId: f.purseId,
          expectedRial: f.amount.toString(),
          actualRial: purse.downPaymentRial.toString(),
        });
      }
    }
    const result: DownPaymentReconciliationResult = {
      clean: issues.length === 0,
      receiptsChecked: snapshot.receiptsChecked,
      accountsChecked: snapshot.accountsChecked,
      pursesChecked: snapshot.funded.length,
      issues,
    };

    const counts = countByKind(result.issues);
    this.logger.log(
      `down payments: ${String(result.receiptsChecked)} receipts, ${String(result.accountsChecked)} accounts, ` +
        `${String(result.pursesChecked)} purses checked; ` +
        (result.clean ? 'clean' : `issues ${JSON.stringify(counts)}`),
    );
    if (!result.clean) {
      // Counts only: no amount, name or id leaves through the alert (owner, پ۳; rule 30).
      await this.alerts.raise({
        code: DOWN_PAYMENT_ALERT,
        message: `down payment reconciliation: ${Object.entries(counts)
          .map(([kind, n]) => `${kind} ${String(n)}`)
          .join(', ')}`,
      });
    }
    return result;
  }
}

function countByKind(issues: readonly DownPaymentIssue[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const i of issues) counts[i.kind] = (counts[i.kind] ?? 0) + 1;
  return counts;
}

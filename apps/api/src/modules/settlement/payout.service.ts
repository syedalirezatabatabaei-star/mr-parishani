import { FINANCIAL_STEP_UP, type FinancialStepUp } from '../../common/auth/step-up.port';
import {
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type {
  PayoutExport,
  PayoutStatus,
  PayoutView,
  PermissionCode,
  StatementView,
} from '@sepehr/contracts';
import { sql } from 'drizzle-orm';
import type { EffectiveAccess } from '../../common/auth/access.port';
import { AUDIT_LOG, type Actor, type AuditLog } from '../../common/audit/audit.port';
import { CENTER_DIRECTORY, type CenterDirectory } from '../../common/catalog/center-directory.port';
import { OUTBOX, type OutboxPort } from '../../common/events/outbox.port';
import { LEDGER, type LedgerPort } from '../../common/ledger/ledger.port';
import { DATABASE, type Database } from '../../db/database.module';
import { lastFour } from '../../security/blind-index';
import type { FieldCrypto } from '../../security/field-crypto';
import { StatementService } from './statement.service';

type Tx = Parameters<Parameters<Database['transaction']>[0]>[0];

/** The settlement module's own field encryption (rule 27): the Sheba snapshot of an order. */
export const SETTLEMENT_CRYPTO = Symbol('SETTLEMENT_CRYPTO');

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const REVIEW: PermissionCode = 'settlement.review_statement';
const EXPORT: PermissionCode = 'settlement.export_payouts';
const conflict = (error: string, detail?: Record<string, unknown>) =>
  new ConflictException({ error, ...detail });
const notFound = (what: 'statement' | 'payout') =>
  new NotFoundException({ error: `${what}_not_found` });

/** The key of an order's payment document (rule 5). */
export const payoutKey = (payoutId: string) => `settlement:payout:${payoutId}:paid`;
/** The encryption context of an order's Sheba snapshot: bound to its row. */
export const ibanContext = (payoutId: string) => `payout_orders.iban:${payoutId}`;

interface Row {
  id: string;
  statement_id: string;
  center_id: string;
  entity_id: string;
  amount_rial: string;
  iban_enc: string;
  iban_last4: string;
  account_holder: string | null;
  status: PayoutStatus;
  issued_at: string;
  export_batch_id: string | null;
  bank_tracking_ref: string | null;
  paid_on: string | null;
  tracking_recorded_by: string | null;
  confirmed_at: string | null;
  journal_entry_id: string | null;
  fail_requested_by: string | null;
  failure_reason: string | null;
  failed_at: string | null;
  replaces_payout_id: string | null;
}

const iso = (c: string) =>
  `to_char(${c} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS ${c}`;
const COLUMNS = sql.raw(`id, statement_id, center_id, entity_id, amount_rial::text, iban_enc,
  iban_last4, account_holder, status, ${iso('issued_at')}, export_batch_id, bank_tracking_ref,
  paid_on::text, tracking_recorded_by, ${iso('confirmed_at')}, journal_entry_id,
  fail_requested_by, failure_reason, ${iso('failed_at')}, replaces_payout_id`);

/** Excel and the banks' portals read UTF-8 only with it. */
const BOM = String.fromCharCode(0xfeff);
const csvField = (v: string) => (/[",\n\r]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);

/**
 * Review, approval and payment of a statement (task 5-5 [financial]; doc 06 §5 steps 3–6,
 * §8 test 6; doc 14 ث; doc 02 §4; owner 1405/07/14). Every step that moves money is two
 * people:
 *
 * - review (one) and approval (another): `draft → reviewed → approved`; refused while an
 *   item of the statement is no longer in it (a dispute opened after the draft);
 * - approval issues one order per center, to the center's Sheba as it is then (snapshot,
 *   encrypted here); the orders' sum is exactly the statement's payable. A statement with
 *   nothing to pay is paid at once (owner, س3);
 * - the bank file (CSV, the Sheba in full only there) sends the issued orders;
 * - the bank's tracking number, recorded by one and confirmed by another, posts Dr
 *   doctor.payable (each node) / Cr bank.settlement (key `settlement:payout:{id}:paid`);
 *   the last order confirmed pays the statement and closes its items;
 * - a failed order (asked by one, done by another) posts nothing and is reissued.
 *
 * A center's status never stops any of this (doc 08 §3). Locks: the statement, then its
 * items (payables, then fees), then its orders.
 */
@Injectable()
export class PayoutService {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(AUDIT_LOG) private readonly audit: AuditLog,
    @Inject(OUTBOX) private readonly outbox: OutboxPort,
    @Inject(LEDGER) private readonly ledger: LedgerPort,
    @Inject(CENTER_DIRECTORY) private readonly centers: CenterDirectory,
    @Inject(SETTLEMENT_CRYPTO) private readonly crypto: FieldCrypto,
    private readonly statements: StatementService,
    @Inject(FINANCIAL_STEP_UP) private readonly stepUp: FinancialStepUp,
  ) {}

  // --- the statement --------------------------------------------------------------------

  async review(actor: Actor, access: EffectiveAccess, id: string): Promise<StatementView> {
    this.require(access, REVIEW);
    this.reach(access);
    await this.db.transaction(async (tx) => {
      const s = await this.lockStatement(tx, id);
      if (s.status === 'reviewed' && s.reviewed_by === actor.accountId) return;
      if (s.status !== 'draft') throw conflict('statement_not_draft', { status: s.status });
      await this.assertItemsUnchanged(tx, id);
      await tx.execute(sql`
        UPDATE settlement_statements
        SET status = 'reviewed', reviewed_by = ${actor.accountId}, reviewed_at = now()
        WHERE id = ${id}
      `);
      await this.audit.record(
        {
          actor,
          action: 'settlement.statement_reviewed',
          entityType: 'settlement_statement',
          entityId: id,
          before: { status: 'draft' },
          after: { status: 'reviewed' },
        },
        tx,
      );
    });
    return this.statements.viewOf(id, actor.accountId);
  }

  async approve(actor: Actor, access: EffectiveAccess, id: string): Promise<StatementView> {
    this.require(access, REVIEW);
    this.reach(access);
    await this.db.transaction(async (tx) => {
      const s = await this.lockStatement(tx, id);
      // Approving twice changes nothing (rule 5).
      if (s.status === 'approved' || s.status === 'paid') return;
      if (s.status !== 'reviewed') throw conflict('statement_not_reviewed', { status: s.status });
      // doc 06 §8 test 6: who reviewed never approves.
      if (s.reviewed_by === actor.accountId) throw conflict('same_person');
      // ADR-052: the approver's own SMS code for this statement and what it pays.
      await this.stepUp.assert(actor, {
        type: 'statement_approval',
        id,
        amountRial: BigInt(s.payable_rial),
        step: 'approve',
      });
      await this.assertItemsUnchanged(tx, id);
      const payable = BigInt(s.payable_rial);
      await tx.execute(sql`
        UPDATE settlement_statements
        SET status = 'approved', approved_by = ${actor.accountId}, approved_at = now()
        WHERE id = ${id}
      `);

      let orders = 0;
      if (payable > 0n) {
        // What each node is paid: its services less what the offset took from it.
        const nodes = (
          await tx.execute(sql`
            SELECT p.doctor_node_id, min(p.center_id::text) AS center_id,
                   count(DISTINCT p.center_id) AS centers,
                   count(*) FILTER (WHERE p.center_id IS NULL) AS without_center,
                   sum(p.amount_rial)::text AS gross,
                   coalesce((
                     SELECT sum(o.amount_rial) FROM settlement_statement_lines o
                     WHERE o.statement_id = ${id} AND o.line_type = 'offset_payable'
                       AND o.ref_id = p.doctor_node_id
                   ), 0)::text AS offset
            FROM settlement_statement_lines l
            JOIN doctor_payables p ON p.id = l.ref_id
            WHERE l.statement_id = ${id} AND l.line_type = 'credit_service'
            GROUP BY p.doctor_node_id ORDER BY p.doctor_node_id
          `)
        ).rows;
        const byCenter = new Map<string, { node: string; amount: bigint }[]>();
        for (const n of nodes) {
          const amount = BigInt(n['gross'] as string) - BigInt(n['offset'] as string);
          if (amount <= 0n) continue;
          if (Number(n['without_center']) > 0 || Number(n['centers']) !== 1) {
            throw conflict('payee_account_missing');
          }
          const center = n['center_id'] as string;
          byCenter.set(center, [
            ...(byCenter.get(center) ?? []),
            { node: n['doctor_node_id'] as string, amount },
          ]);
        }
        let total = 0n;
        for (const [centerId, parts] of byCenter) {
          const amount = parts.reduce((a, p) => a + p.amount, 0n);
          total += amount;
          await this.issue(tx, actor, id, s.entity_id, centerId, parts, null);
          orders += 1;
        }
        // The orders pay exactly what the statement says (doc 06 test 5).
        if (total !== payable) throw new Error('payout orders differ from the statement');
      } else {
        // Nothing to pay (owner, س3): paid at once; what is left was carried.
        await this.markPaid(tx, actor, id, s.doctor_id);
      }
      await this.audit.record(
        {
          actor,
          action: 'settlement.statement_approved',
          entityType: 'settlement_statement',
          entityId: id,
          before: { status: 'reviewed' },
          after: { status: payable > 0n ? 'approved' : 'paid', payouts: orders },
        },
        tx,
      );
      await this.outbox.publish(
        {
          type: 'settlement.statement_approved',
          aggregateType: 'settlement_statement',
          aggregateId: id,
          payload: { statementId: id, doctorId: s.doctor_id, payouts: orders },
        },
        tx,
      );
    });
    return this.statements.viewOf(id, actor.accountId);
  }

  // --- the orders -----------------------------------------------------------------------

  async list(
    actor: Actor,
    access: EffectiveAccess,
    query: { statementId?: string | undefined; status?: PayoutStatus | undefined },
  ): Promise<PayoutView[]> {
    this.requireAny(access);
    this.reach(access);
    const rows = await this.db.execute(sql`
      SELECT ${COLUMNS} FROM payout_orders
      WHERE (${query.statementId ?? null}::uuid IS NULL OR statement_id = ${query.statementId ?? null})
        AND (${query.status ?? null}::text IS NULL OR status = ${query.status ?? null})
      ORDER BY issued_at DESC LIMIT 500
    `);
    return (rows.rows as unknown as Row[]).map((r) => view(r, actor.accountId));
  }

  /** The issued orders into one bank file; they are then sent_to_bank. */
  async export(
    actor: Actor,
    access: EffectiveAccess,
    payoutIds: readonly string[] | undefined,
  ): Promise<PayoutExport> {
    this.require(access, EXPORT);
    this.reach(access);
    // ADR-052: the bank file is signed by who makes it, with their own SMS code.
    await this.stepUp.assert(actor, {
      type: 'payout_export',
      id: actor.accountId ?? '00000000-0000-0000-0000-000000000000',
      amountRial: null,
      step: 'request',
    });
    const batchId = await this.db.transaction(async (tx) => {
      const rows = (
        await tx.execute(sql`
          SELECT id FROM payout_orders
          WHERE status = 'issued'
            ${
              payoutIds
                ? sql`AND id IN (${sql.join(
                    payoutIds.map((i) => sql`${i}`),
                    sql`, `,
                  )})`
                : sql``
            }
          ORDER BY id FOR UPDATE
        `)
      ).rows;
      if (rows.length === 0) throw conflict('nothing_to_export');
      const batch = (await tx.execute(sql`SELECT uuidv7() AS id`)).rows[0]?.['id'] as string;
      await tx.execute(sql`
        UPDATE payout_orders
        SET status = 'sent_to_bank', export_batch_id = ${batch},
            exported_by = ${actor.accountId}, exported_at = now()
        WHERE id IN (${sql.join(
          rows.map((r) => sql`${r['id'] as string}`),
          sql`, `,
        )})
      `);
      // Counts only: never a Sheba or a name (rule 30).
      await this.audit.record(
        {
          actor,
          action: 'settlement.payouts_exported',
          entityType: 'payout_export',
          entityId: batch,
          after: { orders: rows.length },
        },
        tx,
      );
      return batch;
    });
    return this.file(batchId);
  }

  /** The same bank file again: the same orders, nothing new issued or moved. */
  async exported(actor: Actor, access: EffectiveAccess, batchId: string): Promise<PayoutExport> {
    this.require(access, EXPORT);
    this.reach(access);
    if (!UUID.test(batchId)) throw new NotFoundException({ error: 'export_not_found' });
    const done = await this.file(batchId);
    await this.audit.record({
      actor,
      action: 'settlement.payouts_export_fetched',
      entityType: 'payout_export',
      entityId: batchId,
      after: { orders: done.count },
    });
    return done;
  }

  /** The bank's tracking number, recorded by one person (confirmed by another). */
  async recordTracking(
    actor: Actor,
    access: EffectiveAccess,
    id: string,
    input: { bankTrackingRef: string; paidOn: string },
  ): Promise<PayoutView> {
    this.require(access, REVIEW);
    this.reach(access);
    // ADR-052: recording a payment asks the payment's confirmation; signed with an SMS code.
    await this.stepUp.assert(actor, {
      type: 'payout_confirmation',
      id,
      amountRial: BigInt((await this.find(id)).amount_rial),
      step: 'request',
    });
    await this.db
      .transaction(async (tx) => {
        const p = await this.lockPayout(tx, id);
        if (p.status !== 'sent_to_bank') throw conflict('payout_not_sent', { status: p.status });
        if (p.fail_requested_by) throw conflict('payout_failing');
        await tx.execute(sql`
          UPDATE payout_orders
          SET bank_tracking_ref = ${input.bankTrackingRef}, paid_on = ${input.paidOn},
              tracking_recorded_by = ${actor.accountId}, tracking_recorded_at = now()
          WHERE id = ${id}
        `);
        await this.audit.record(
          {
            actor,
            action: 'settlement.payout_tracking_recorded',
            entityType: 'payout_order',
            entityId: id,
            before: { bankTrackingRef: p.bank_tracking_ref },
            after: { bankTrackingRef: input.bankTrackingRef, paidOn: input.paidOn },
          },
          tx,
        );
      })
      .catch(uniqueTracking);
    return this.viewOf(id, actor.accountId);
  }

  /** Confirmed by another person: posted, and the statement paid when it was the last one. */
  async confirm(actor: Actor, access: EffectiveAccess, id: string): Promise<PayoutView> {
    this.require(access, REVIEW);
    this.reach(access);
    // ADR-052: the confirmer's own SMS code for this payment and its amount.
    await this.stepUp.assert(actor, {
      type: 'payout_confirmation',
      id,
      amountRial: BigInt((await this.find(id)).amount_rial),
      step: 'approve',
    });
    const statementId = (await this.find(id)).statement_id;
    await this.db.transaction(async (tx) => {
      const s = await this.lockStatement(tx, statementId);
      const p = await this.lockPayout(tx, id);
      if (p.status === 'confirmed') return;
      if (p.status !== 'sent_to_bank') throw conflict('payout_not_sent', { status: p.status });
      if (!p.bank_tracking_ref || !p.paid_on || !p.tracking_recorded_by) {
        throw conflict('tracking_missing');
      }
      if (p.fail_requested_by) throw conflict('payout_failing');
      // doc 06 §8 test 6: who recorded the tracking number never confirms it.
      if (p.tracking_recorded_by === actor.accountId) throw conflict('same_person');

      const parts = (
        await tx.execute(sql`
          SELECT doctor_node_id, amount_rial::text FROM payout_order_nodes
          WHERE payout_id = ${id} ORDER BY doctor_node_id
        `)
      ).rows;
      const lines = [];
      for (const part of parts) {
        const account = await this.ledger.openAccount(
          {
            entityId: p.entity_id,
            code: 'doctor.payable',
            name: 'بدهی به پزشک',
            kind: 'liability',
            ownerType: 'doctor',
            ownerId: part['doctor_node_id'] as string,
          },
          tx,
        );
        lines.push({
          accountId: account.id,
          direction: 'debit' as const,
          amountRial: BigInt(part['amount_rial'] as string),
        });
      }
      const bank = await this.ledger.openAccount(
        {
          entityId: p.entity_id,
          code: 'bank.settlement',
          name: 'حساب بانکی پرداخت',
          kind: 'asset',
          ownerType: 'company',
          ownerId: null,
        },
        tx,
      );
      lines.push({
        accountId: bank.id,
        direction: 'credit' as const,
        amountRial: BigInt(p.amount_rial),
      });
      const journal = await this.ledger.postJournal(
        actor,
        {
          entityId: p.entity_id,
          eventType: 'settlement.payout_paid',
          // The day it was paid, noon in Tehran.
          occurredAt: new Date(`${p.paid_on}T08:30:00Z`),
          idempotencyKey: payoutKey(id),
          lines,
        },
        tx,
      );
      await tx.execute(sql`
        UPDATE payout_orders
        SET status = 'confirmed', confirmed_by = ${actor.accountId}, confirmed_at = now(),
            journal_entry_id = ${journal.id}
        WHERE id = ${id}
      `);
      await this.audit.record(
        {
          actor,
          action: 'settlement.payout_confirmed',
          entityType: 'payout_order',
          entityId: id,
          before: { status: 'sent_to_bank' },
          after: { status: 'confirmed', journalEntryId: journal.id },
        },
        tx,
      );
      await this.outbox.publish(
        {
          type: 'settlement.payout_confirmed',
          aggregateType: 'payout_order',
          aggregateId: id,
          payload: { payoutId: id, statementId, amountRial: p.amount_rial },
        },
        tx,
      );
      // The last live order paid: the statement is paid and its items closed.
      const open = await tx.execute(sql`
        SELECT 1 FROM payout_orders
        WHERE statement_id = ${statementId} AND status NOT IN ('confirmed', 'failed')
      `);
      const failedOnly = await tx.execute(sql`
        SELECT 1 FROM payout_orders f
        WHERE f.statement_id = ${statementId} AND f.status = 'failed'
          AND NOT EXISTS (SELECT 1 FROM payout_orders r
                          WHERE r.statement_id = f.statement_id AND r.center_id = f.center_id
                            AND r.status <> 'failed')
      `);
      if (open.rows.length === 0 && failedOnly.rows.length === 0 && s.status === 'approved') {
        await this.markPaid(tx, actor, statementId, s.doctor_id);
      }
    });
    return this.viewOf(id, actor.accountId);
  }

  /** Returned by the bank, or a wrong Sheba: asked by one, done by another; posts nothing. */
  async fail(
    actor: Actor,
    access: EffectiveAccess,
    id: string,
    reason: string,
  ): Promise<PayoutView> {
    this.require(access, REVIEW);
    this.reach(access);
    await this.db.transaction(async (tx) => {
      const p = await this.lockPayout(tx, id);
      if (p.status === 'failed') return;
      if (p.status !== 'issued' && p.status !== 'sent_to_bank') {
        throw conflict('payout_not_failable', { status: p.status });
      }
      if (!p.fail_requested_by) {
        await tx.execute(sql`
          UPDATE payout_orders
          SET fail_requested_by = ${actor.accountId}, fail_requested_at = now(),
              failure_reason = ${reason}
          WHERE id = ${id}
        `);
        await this.audit.record(
          {
            actor,
            action: 'settlement.payout_fail_requested',
            entityType: 'payout_order',
            entityId: id,
            reason,
          },
          tx,
        );
        return;
      }
      if (p.fail_requested_by === actor.accountId) return;
      await tx.execute(sql`
        UPDATE payout_orders
        SET status = 'failed', failed_by = ${actor.accountId}, failed_at = now()
        WHERE id = ${id}
      `);
      await this.audit.record(
        {
          actor,
          action: 'settlement.payout_failed',
          entityType: 'payout_order',
          entityId: id,
          before: { status: p.status },
          after: { status: 'failed' },
          reason,
        },
        tx,
      );
    });
    return this.viewOf(id, actor.accountId);
  }

  /** A failed order issued again: the same amount, the center's Sheba as it is now. */
  async reissue(actor: Actor, access: EffectiveAccess, id: string): Promise<PayoutView> {
    this.require(access, REVIEW);
    this.reach(access);
    const statementId = (await this.find(id)).statement_id;
    const made = await this.db.transaction(async (tx) => {
      const s = await this.lockStatement(tx, statementId);
      const p = await this.lockPayout(tx, id);
      if (p.status !== 'failed') throw conflict('payout_not_failed', { status: p.status });
      const again = (
        await tx.execute(sql`
          SELECT id FROM payout_orders WHERE replaces_payout_id = ${id}
        `)
      ).rows[0]?.['id'] as string | undefined;
      if (again) return again;
      if (s.status !== 'approved') throw conflict('statement_not_approved', { status: s.status });
      const parts = (
        await tx.execute(sql`
          SELECT doctor_node_id, amount_rial::text FROM payout_order_nodes
          WHERE payout_id = ${id} ORDER BY doctor_node_id
        `)
      ).rows.map((r) => ({
        node: r['doctor_node_id'] as string,
        amount: BigInt(r['amount_rial'] as string),
      }));
      return this.issue(tx, actor, statementId, p.entity_id, p.center_id, parts, id);
    });
    return this.viewOf(made, actor.accountId);
  }

  // --- helpers -------------------------------------------------------------------------

  private async issue(
    tx: Tx,
    actor: Actor,
    statementId: string,
    entityId: string,
    centerId: string,
    parts: readonly { node: string; amount: bigint }[],
    replaces: string | null,
  ): Promise<string> {
    const account = await this.centers.payoutAccount(centerId, tx);
    if (!account) throw conflict('payee_account_missing', { centerId });
    const id = (await tx.execute(sql`SELECT uuidv7() AS id`)).rows[0]?.['id'] as string;
    const amount = parts.reduce((a, p) => a + p.amount, 0n);
    await tx.execute(sql`
      INSERT INTO payout_orders (
        id, statement_id, center_id, entity_id, amount_rial, iban_enc, iban_last4,
        account_holder, issued_by, replaces_payout_id
      ) VALUES (
        ${id}, ${statementId}, ${centerId}, ${entityId}, ${amount},
        ${this.crypto.encrypt(account.sheba, ibanContext(id))}, ${lastFour(account.sheba)},
        ${account.accountHolder}, ${actor.accountId}, ${replaces}
      )
    `);
    for (const part of parts) {
      await tx.execute(sql`
        INSERT INTO payout_order_nodes (payout_id, doctor_node_id, amount_rial)
        VALUES (${id}, ${part.node}, ${part.amount})
      `);
    }
    await this.audit.record(
      {
        actor,
        action: 'settlement.payout_issued',
        entityType: 'payout_order',
        entityId: id,
        after: { statementId, centerId, amountRial: amount.toString(), replaces },
      },
      tx,
    );
    return id;
  }

  /** approved → paid; its payables paid and its fees settled. */
  private async markPaid(tx: Tx, actor: Actor, statementId: string, doctorId: string) {
    await tx.execute(sql`
      SELECT id FROM doctor_payables WHERE statement_id = ${statementId} ORDER BY id FOR UPDATE
    `);
    await tx.execute(sql`
      SELECT id FROM service_fees WHERE statement_id = ${statementId} ORDER BY id FOR UPDATE
    `);
    await tx.execute(sql`
      UPDATE doctor_payables SET status = 'paid'
      WHERE statement_id = ${statementId} AND status = 'in_statement'
    `);
    await tx.execute(sql`
      UPDATE service_fees SET status = 'settled'
      WHERE statement_id = ${statementId} AND status = 'in_statement'
    `);
    await tx.execute(
      sql`UPDATE settlement_statements SET status = 'paid' WHERE id = ${statementId}`,
    );
    await this.audit.record(
      {
        actor,
        action: 'settlement.statement_paid',
        entityType: 'settlement_statement',
        entityId: statementId,
        before: { status: 'approved' },
        after: { status: 'paid' },
      },
      tx,
    );
    await this.outbox.publish(
      {
        type: 'settlement.statement_paid',
        aggregateType: 'settlement_statement',
        aggregateId: statementId,
        payload: { statementId, doctorId },
      },
      tx,
    );
  }

  /**
   * Every item of the statement is still in it (a dispute opened after the draft takes its
   * item out): else the draft is cancelled and made again (task 5-4).
   */
  private async assertItemsUnchanged(tx: Tx, statementId: string) {
    await tx.execute(sql`
      SELECT id FROM doctor_payables WHERE statement_id = ${statementId} ORDER BY id FOR UPDATE
    `);
    await tx.execute(sql`
      SELECT id FROM service_fees WHERE statement_id = ${statementId} ORDER BY id FOR UPDATE
    `);
    const changed = await tx.execute(sql`
      SELECT 1 FROM settlement_statement_lines l
      LEFT JOIN doctor_payables p ON l.ref_type = 'doctor_payable' AND p.id = l.ref_id
      LEFT JOIN service_fees f ON l.ref_type = 'service_fee' AND f.id = l.ref_id
      WHERE l.statement_id = ${statementId}
        AND l.ref_type IN ('doctor_payable', 'service_fee')
        AND (coalesce(p.statement_id, f.statement_id) IS DISTINCT FROM ${statementId}::uuid
             OR coalesce(p.status, f.status) IS DISTINCT FROM 'in_statement')
      LIMIT 1
    `);
    if (changed.rows.length > 0) throw conflict('statement_items_changed');
  }

  private async lockStatement(tx: Tx, id: string) {
    if (!UUID.test(id)) throw notFound('statement');
    const row = (
      await tx.execute(sql`
        SELECT id, doctor_id, entity_id, status, payable_rial::text, reviewed_by
        FROM settlement_statements WHERE id = ${id} FOR UPDATE
      `)
    ).rows[0];
    if (!row) throw notFound('statement');
    return {
      doctor_id: row['doctor_id'] as string,
      entity_id: row['entity_id'] as string,
      status: row['status'] as string,
      payable_rial: row['payable_rial'] as string,
      reviewed_by: row['reviewed_by'] as string | null,
    };
  }

  private async lockPayout(tx: Tx, id: string): Promise<Row> {
    if (!UUID.test(id)) throw notFound('payout');
    const row = (
      await tx.execute(sql`SELECT ${COLUMNS} FROM payout_orders WHERE id = ${id} FOR UPDATE`)
    ).rows[0] as unknown as Row | undefined;
    if (!row) throw notFound('payout');
    return row;
  }

  private async find(id: string): Promise<Row> {
    if (!UUID.test(id)) throw notFound('payout');
    const row = (await this.db.execute(sql`SELECT ${COLUMNS} FROM payout_orders WHERE id = ${id}`))
      .rows[0] as unknown as Row | undefined;
    if (!row) throw notFound('payout');
    return row;
  }

  private async viewOf(id: string, viewer: string | null): Promise<PayoutView> {
    return view(await this.find(id), viewer);
  }

  private async file(batchId: string): Promise<PayoutExport> {
    const rows = (
      await this.db.execute(sql`
        SELECT ${COLUMNS} FROM payout_orders WHERE export_batch_id = ${batchId} ORDER BY id
      `)
    ).rows as unknown as Row[];
    if (rows.length === 0) throw new NotFoundException({ error: 'export_not_found' });
    const lines = [
      ['شبا', 'مبلغ (ریال)', 'نام صاحب حساب', 'شناسه صورت‌وضعیت', 'شناسه دستور پرداخت'],
      ...rows.map((r) => [
        this.crypto.decrypt(r.iban_enc, ibanContext(r.id)),
        r.amount_rial,
        r.account_holder ?? '',
        r.statement_id,
        r.id,
      ]),
    ];
    return {
      batchId,
      count: rows.length,
      totalRial: rows.reduce((a, r) => a + BigInt(r.amount_rial), 0n).toString(),
      csv: `${BOM}${lines.map((l) => l.map(csvField).join(',')).join('\r\n')}\r\n`,
    };
  }

  /** Statements and orders span cities: global scope only (rule 11), like task 5-4. */
  private reach(access: EffectiveAccess) {
    if (!access.scopes.some((s) => s.kind === 'global')) throw notFound('statement');
  }

  private require(access: EffectiveAccess, permission: PermissionCode) {
    if (!access.permissions.has(permission)) {
      throw new ForbiddenException({ error: 'permission_required', permission });
    }
  }

  private requireAny(access: EffectiveAccess) {
    if (!access.permissions.has(REVIEW) && !access.permissions.has(EXPORT)) {
      throw new ForbiddenException({ error: 'permission_required' });
    }
  }
}

function view(r: Row, viewer: string | null): PayoutView {
  return {
    id: r.id,
    statementId: r.statement_id,
    centerId: r.center_id,
    amountRial: r.amount_rial,
    ibanLast4: r.iban_last4,
    accountHolder: r.account_holder,
    status: r.status,
    issuedAt: r.issued_at,
    exportBatchId: r.export_batch_id,
    bankTrackingRef: r.bank_tracking_ref,
    paidOn: r.paid_on,
    trackingRecordedByMe: viewer !== null && r.tracking_recorded_by === viewer,
    confirmedAt: r.confirmed_at,
    journalEntryId: r.journal_entry_id,
    failureReason: r.failure_reason,
    failRequestedByMe: viewer !== null && r.fail_requested_by === viewer,
    failedAt: r.failed_at,
    replacesPayoutId: r.replaces_payout_id,
  };
}

/** A tracking number already used by a live order. */
function uniqueTracking(error: unknown): never {
  const e = error as { code?: string; cause?: { code?: string } };
  if (e.code === '23505' || e.cause?.code === '23505') throw conflict('tracking_ref_used');
  throw error;
}

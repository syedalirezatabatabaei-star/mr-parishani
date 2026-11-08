import { FINANCIAL_STEP_UP, type FinancialStepUp } from '../../common/auth/step-up.port';
import {
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type {
  DisputeStatus,
  DisputeSubject,
  DisputeView,
  OpenDispute,
  PermissionCode,
  ResolveDispute,
} from '@sepehr/contracts';
import { sql } from 'drizzle-orm';
import type { EffectiveAccess } from '../../common/auth/access.port';
import {
  AUDIT_LOG,
  type Actor,
  type AuditLog,
  type SqlExecutor,
} from '../../common/audit/audit.port';
import {
  WORKPLACE_DIRECTORY,
  type WorkplaceDirectory,
} from '../../common/catalog/workplace-directory.port';
import { OUTBOX, type OutboxPort } from '../../common/events/outbox.port';
import { LEDGER, type LedgerPort } from '../../common/ledger/ledger.port';
import { REPAYMENT, type RepaymentPort } from '../../common/repayment/repayment.port';
import {
  SERVICE_REVERSALS,
  type ServiceReversals,
} from '../../common/service/service-reversals.port';
import { WALLET, type WalletPort } from '../../common/wallet/wallet.port';
import { DATABASE, type Database } from '../../db/database.module';

type Tx = Parameters<Parameters<Database['transaction']>[0]>[0];

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const notFound = () => new NotFoundException({ error: 'dispute_not_found' });
const conflict = (error: string, detail?: Record<string, unknown>) =>
  new ConflictException({ error, ...detail });

const OPEN: PermissionCode = 'settlement.open_dispute';
const RESOLVE: PermissionCode = 'settlement.resolve_dispute';
const HOLDABLE = ['accrued', 'due', 'in_statement'];

/** Two disputes opened at once on one item: the unique index lets one through (5-2). */
function uniqueToConflict(error: unknown): never {
  const e = error as { code?: string; cause?: { code?: string } };
  if (e.code === '23505' || e.cause?.code === '23505') throw conflict('dispute_open');
  throw error;
}

/** The key of an accepted fee's reversing document (rule 5). */
export const correctionKey = (disputeId: string) => `settlement:dispute:${disputeId}:correction`;

/** The keys of an accepted payable dispute's posting, one per step (task 5-2b; rule 5). */
export type PostingStep = 'unfinalize' | 'unregister' | 'unreserve' | 'fee' | 'schedule' | 'refund';
export const postingKey = (disputeId: string, step: PostingStep) =>
  `settlement:dispute:${disputeId}:${step}`;

interface Posted {
  step: PostingStep;
  op?: string;
  journal?: string | null;
  revision?: string;
  amount?: bigint;
  downPayment?: { rial: bigint; entityId: string; borrowerPersonId: string };
}

interface Item {
  type: DisputeSubject;
  id: string;
  status: string;
  dueAt: Date;
  workplaceId: string | null;
  journalEntryId: string | null;
}

/** What a dispute is held by: a payable (with its fee), or a cash fee alone. */
type Anchor = { kind: 'payable'; id: string } | { kind: 'cash_fee'; id: string };

interface Row {
  id: string;
  subject_type: DisputeSubject;
  subject_id: string;
  reason: string;
  status: DisputeStatus;
  opened_by: string;
  opened_at: string;
  resolved_at: string | null;
  resolution_note: string | null;
  correction_journal_entry_id: string | null;
}

const iso = (c: string) =>
  `to_char(${c} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS ${c}`;
const COLUMNS = sql.raw(`id, subject_type, subject_id, reason, status, opened_by,
  ${iso('opened_at')}, ${iso('resolved_at')}, resolution_note, correction_journal_entry_id`);

/**
 * Financial disputes (task 5-2 [financial]; doc 14 5-2; doc 06 §4, §8 test 4; doc 02 §8 test
 * 7; owner 1405/07/14). A dispute holds its item and the sibling of the same service (a
 * doctor's payable and its fee), so no statement or payment takes one without the other:
 *
 * - opened: each held item `on_hold`, what it was before kept (`financial_dispute_items`);
 *   one live dispute per item;
 * - rejected, by someone else: each item back where it was (one that was in a statement back
 *   to `due`, for the next statement); nothing posted;
 * - accepted on a fee, by someone else: the fee's document reversed whole (key
 *   `settlement:dispute:{id}:correction`), the fee `reversed`, its payable back;
 * - accepted on a doctor's payable: `accepted_pending_posting` only (owner, option ب): both
 *   stay held, out of every payment; nothing is posted and phase 1 is not touched (5-2b).
 *
 * Locks: the payable, then its fee (always this order), then the dispute.
 */
@Injectable()
export class DisputeService {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(AUDIT_LOG) private readonly audit: AuditLog,
    @Inject(OUTBOX) private readonly outbox: OutboxPort,
    @Inject(LEDGER) private readonly ledger: LedgerPort,
    @Inject(WORKPLACE_DIRECTORY) private readonly workplaces: WorkplaceDirectory,
    @Inject(WALLET) private readonly wallet: WalletPort,
    @Inject(REPAYMENT) private readonly repayment: RepaymentPort,
    @Inject(SERVICE_REVERSALS) private readonly services: ServiceReversals,
    @Inject(FINANCIAL_STEP_UP) private readonly stepUp: FinancialStepUp,
  ) {}

  async open(actor: Actor, access: EffectiveAccess, input: OpenDispute): Promise<DisputeView> {
    this.require(access, OPEN);
    const payableId = await this.payableOf(input.subjectType, input.subjectId);
    await this.reachable(access, payableId);
    const id = await this.db
      .transaction((tx) => this.openIn(tx, actor, input, payableId, null))
      .catch(uniqueToConflict);
    return this.view(await this.find(this.db, id), actor.accountId);
  }

  /**
   * Task 7-2 (owner ج۳): the same opening, in the caller's transaction, for a financial
   * complaint (its ticket recorded on the dispute). A refusal (not holdable, already held)
   * throws, so the caller's whole transaction, ticket included, is rolled back.
   */
  async openForTicket(
    tx: SqlExecutor,
    actor: Actor,
    access: EffectiveAccess,
    input: OpenDispute,
    ticketId: string,
  ): Promise<string> {
    this.require(access, OPEN);
    const payableId = await this.payableOf(input.subjectType, input.subjectId);
    await this.reachable(access, payableId);
    return this.openIn(tx as Tx, actor, input, payableId, ticketId).catch(uniqueToConflict);
  }

  /** Task 7-2: a dispute's state, or null; read only. */
  async statusOf(disputeId: string, tx?: SqlExecutor): Promise<DisputeStatus | null> {
    if (!UUID.test(disputeId)) return null;
    const row = (
      await (tx ?? this.db).execute(
        sql`SELECT status FROM financial_disputes WHERE id = ${disputeId}`,
      )
    ).rows[0];
    return (row?.['status'] as DisputeStatus | undefined) ?? null;
  }

  /**
   * Task 7-2: a label for a payable or a fee the caller may dispute (the same reach as
   * opening one), or null when it does not exist or is not theirs; read only.
   */
  async itemLabel(
    access: EffectiveAccess,
    type: DisputeSubject,
    id: string,
  ): Promise<string | null> {
    try {
      await this.reachable(access, await this.payableOf(type, id));
    } catch (error) {
      if (error instanceof NotFoundException) return null;
      throw error;
    }
    const table = sql.raw(type === 'doctor_payable' ? 'doctor_payables' : 'service_fees');
    const row = (await this.db.execute(sql`SELECT 1 FROM ${table} WHERE id = ${id}`)).rows[0];
    if (!row) return null;
    return type === 'doctor_payable' ? 'بدهی به پزشک' : 'کارمزد خدمت';
  }

  private async openIn(
    tx: Tx,
    actor: Actor,
    input: OpenDispute,
    payableId: Anchor,
    ticketId: string | null,
  ): Promise<string> {
    const items = await this.lockItems(tx, payableId);
    const subject = items.find((i) => i.type === input.subjectType);
    if (!subject) throw new NotFoundException({ error: 'item_not_found' });
    if (subject.status === 'on_hold') throw conflict('dispute_open');
    if (!HOLDABLE.includes(subject.status)) {
      throw conflict('not_holdable', { status: subject.status });
    }
    // Owner, task 5-5 س2: an item of an approved (or paid) statement is not held; what
    // is owed back is made good in a later statement (5-2b).
    for (const item of items) {
      const table = sql.raw(item.type === 'doctor_payable' ? 'doctor_payables' : 'service_fees');
      const approved = await tx.execute(sql`
        SELECT 1 FROM ${table} i JOIN settlement_statements s ON s.id = i.statement_id
        WHERE i.id = ${item.id} AND s.status IN ('approved', 'paid')
      `);
      if (approved.rows.length > 0) throw conflict('statement_approved');
    }
    const made = await tx.execute(sql`
      INSERT INTO financial_disputes (subject_type, subject_id, reason, opened_by, ticket_id)
      VALUES (${input.subjectType}, ${input.subjectId}, ${input.reason}, ${actor.accountId},
        ${ticketId})
      RETURNING id
    `);
    const disputeId = made.rows[0]?.['id'] as string;
    // The subject and its sibling, when it can be held: together out of every payment.
    for (const item of items.filter((i) => HOLDABLE.includes(i.status))) {
      await tx.execute(sql`
        INSERT INTO financial_dispute_items (dispute_id, item_type, item_id, held_from_status)
        VALUES (${disputeId}, ${item.type}, ${item.id}, ${item.status})
      `);
      await this.setStatus(tx, item, 'on_hold', disputeId);
    }
    await this.audit.record(
      {
        actor,
        action: 'settlement.dispute_opened',
        entityType: 'financial_dispute',
        entityId: disputeId,
        after: { subjectType: input.subjectType, subjectId: input.subjectId },
        reason: input.reason,
      },
      tx,
    );
    await this.outbox.publish(
      {
        type: 'settlement.dispute_opened',
        aggregateType: 'financial_dispute',
        aggregateId: disputeId,
        payload: {
          disputeId,
          subjectType: input.subjectType,
          subjectId: input.subjectId,
        },
      },
      tx,
    );
    return disputeId;
  }

  async resolve(
    actor: Actor,
    access: EffectiveAccess,
    id: string,
    input: ResolveDispute,
  ): Promise<DisputeView> {
    this.require(access, RESOLVE);
    const reached = await this.find(this.db, id);
    const payableId = await this.payableOf(reached.subject_type, reached.subject_id);
    // ADR-052: the decision on a disputed payable is signed with an SMS code.
    await this.stepUp.assert(actor, {
      type: 'dispute_resolution',
      id,
      amountRial: null,
      step: 'approve',
    });
    await this.reachable(access, payableId);
    await this.db.transaction(async (tx) => {
      const items = await this.lockItems(tx, payableId);
      const dispute = (
        await tx.execute(sql`SELECT ${COLUMNS} FROM financial_disputes WHERE id = ${id} FOR UPDATE`)
      ).rows[0] as unknown as Row;
      // Deciding the same way twice changes nothing (rule 5).
      const final = outcomeOf(dispute.subject_type, input.outcome);
      if (dispute.status === final) return;
      if (dispute.status !== 'open') throw conflict('dispute_decided', { status: dispute.status });
      // Who opens a dispute never decides it.
      if (dispute.opened_by === actor.accountId) throw conflict('same_person');
      const held = (
        await tx.execute(sql`
          SELECT item_type, item_id, held_from_status FROM financial_dispute_items
          WHERE dispute_id = ${id}
        `)
      ).rows;
      const before = (type: string, itemId: string) =>
        held.find((h) => h['item_type'] === type && h['item_id'] === itemId)?.[
          'held_from_status'
        ] as string | undefined;
      const release = async (item: Item) => {
        const was = before(item.type, item.id);
        if (!was || item.status !== 'on_hold') return;
        // Out of the statement it was in: due again, for the next one (doc 06 §8 test 4).
        const back =
          was === 'in_statement' || (was === 'accrued' && item.dueAt <= new Date()) ? 'due' : was;
        await this.setStatus(tx, item, back, null);
      };

      let correction: string | null = null;
      if (input.outcome === 'rejected') {
        for (const item of items) await release(item);
      } else if (dispute.subject_type === 'service_fee') {
        const fee = items.find((i) => i.type === 'service_fee');
        if (!fee) throw new NotFoundException({ error: 'item_not_found' });
        // The fee's document reversed whole (rule 3); a fee of 0 has none to reverse.
        if (fee.journalEntryId) {
          correction = (
            await this.ledger.reverseJournal(
              actor,
              fee.journalEntryId,
              { idempotencyKey: correctionKey(id), reason: input.note },
              tx,
            )
          ).id;
        }
        await this.setStatus(tx, fee, 'reversed', id);
        for (const item of items.filter((i) => i.type === 'doctor_payable')) await release(item);
      }
      // Accepted on a payable: accepted_pending_posting; both stay held (owner, option ب).

      await tx.execute(sql`
        UPDATE financial_disputes
        SET status = ${final}, resolved_by = ${actor.accountId}, resolved_at = now(),
            resolution_note = ${input.note}, correction_journal_entry_id = ${correction}
        WHERE id = ${id}
      `);
      await this.audit.record(
        {
          actor,
          action: 'settlement.dispute_resolved',
          entityType: 'financial_dispute',
          entityId: id,
          before: { status: 'open' },
          after: { status: final, correctionJournalEntryId: correction },
          reason: input.note,
        },
        tx,
      );
      await this.outbox.publish(
        {
          type: 'settlement.dispute_resolved',
          aggregateType: 'financial_dispute',
          aggregateId: id,
          payload: {
            disputeId: id,
            subjectType: dispute.subject_type,
            subjectId: dispute.subject_id,
            status: final,
          },
        },
        tx,
      );
    });
    return this.view(await this.find(this.db, id), actor.accountId);
  }

  async list(
    actor: Actor,
    access: EffectiveAccess,
    query: { status?: DisputeStatus | undefined },
  ): Promise<DisputeView[]> {
    if (!access.permissions.has(OPEN) && !access.permissions.has(RESOLVE)) {
      throw new ForbiddenException({ error: 'permission_required' });
    }
    const rows = await this.db.execute(sql`
      SELECT ${COLUMNS} FROM financial_disputes
      WHERE (${query.status ?? null}::text IS NULL OR status = ${query.status ?? null})
      ORDER BY opened_at DESC LIMIT 500
    `);
    const out: DisputeView[] = [];
    for (const r of rows.rows as unknown as Row[]) {
      const payableId = await this.payableOf(r.subject_type, r.subject_id).catch(() => null);
      const ok =
        payableId !== null &&
        (await this.reachable(access, payableId).then(
          () => true,
          () => false,
        ));
      if (ok) out.push(await this.view(r, actor.accountId));
    }
    return out;
  }

  /**
   * An accepted payable dispute posted (task 5-2b [financial]; ADR-038; owner 1405/07/15):
   * the service taken back, in one transaction, by someone other than its opener.
   *
   *   1. finalize reversed: Dr doctor.payable / Cr purse.consumed_pending;
   *   2. the registration reversed: Dr purse.consumed_pending / Cr purse.reserved;
   *   3. the reservation cancelled for exactly that amount (never another one's);
   *   4. the service's fee reversed whole, unless 0 or reversed already;
   *   5. a closed purse only (the rule of 4-8): the loan's part off the schedule from the
   *      last untouched installment (none negative, none paid touched; refused whole if more
   *      than they hold), then all of it off the purse to the debt and the refund.
   *
   * Locks as 5-2 and 4-8: the payable, its fee, the dispute; the authorization; the purse
   * (each wallet operation); the schedule. Posted again: nothing new (rule 5).
   */
  async post(actor: Actor, access: EffectiveAccess, id: string): Promise<DisputeView> {
    this.require(access, RESOLVE);
    const reached = await this.find(this.db, id);
    if (reached.subject_type !== 'doctor_payable') throw conflict('not_a_payable_dispute');
    const anchor: Anchor = { kind: 'payable', id: reached.subject_id };
    await this.reachable(access, anchor);
    await this.db.transaction(async (tx) => {
      const items = await this.lockItems(tx, anchor);
      const dispute = (
        await tx.execute(sql`SELECT ${COLUMNS} FROM financial_disputes WHERE id = ${id} FOR UPDATE`)
      ).rows[0] as unknown as Row;
      if (dispute.status === 'resolved_accepted') return;
      if (dispute.status !== 'accepted_pending_posting') {
        throw conflict('dispute_not_pending', { status: dispute.status });
      }
      if (dispute.opened_by === actor.accountId) throw conflict('same_person');

      const payable = items.find((i) => i.type === 'doctor_payable');
      const fee = items.find((i) => i.type === 'service_fee');
      if (payable?.status !== 'on_hold') throw conflict('payable_not_held');
      const p = (
        await tx.execute(sql`
          SELECT amount_rial::text AS amount, wallet_operation_id, purse_id, service_delivery_id
          FROM doctor_payables WHERE id = ${payable.id}
        `)
      ).rows[0] as Record<string, string>;
      const amount = BigInt(p['amount'] ?? '0');
      const purseId = p['purse_id'] ?? '';
      // A statement it is still a line of must be cancelled first (5-4); an approved or paid
      // one cannot hold a disputed item (5-5, owner 2).
      const live = await tx.execute(sql`
        SELECT s.id FROM settlement_statement_lines l
        JOIN settlement_statements s ON s.id = l.statement_id
        WHERE l.ref_type = 'doctor_payable' AND l.ref_id = ${payable.id}
          AND s.status <> 'cancelled'
      `);
      if (live.rows.length > 0) {
        throw conflict('statement_must_be_cancelled', {
          statementId: live.rows[0]?.['id'] as string,
        });
      }
      const service = await this.services.lockForReversal(p['service_delivery_id'] ?? '', tx);
      if (service?.status !== 'finalized') throw conflict('service_not_final');
      if (service.amountRial !== amount || service.purseId !== purseId) {
        throw new Error('the payable and its service differ');
      }

      const reason = `اختلاف پذیرفته‌شده ${id}`;
      const posted: Posted[] = [];
      // 1–3: the purse's chain back; the reservation only by this service's amount.
      const unfinalize = await this.wallet.reverseOperation(
        actor,
        purseId,
        p['wallet_operation_id'] ?? '',
        { idempotencyKey: postingKey(id, 'unfinalize'), reason },
        tx,
      );
      posted.push({
        step: 'unfinalize',
        op: unfinalize.operationId,
        journal: unfinalize.journalEntryId,
        amount,
      });
      const unregister = await this.wallet.reverseOperation(
        actor,
        purseId,
        service.registerOperationId,
        { idempotencyKey: postingKey(id, 'unregister'), reason },
        tx,
      );
      posted.push({
        step: 'unregister',
        op: unregister.operationId,
        journal: unregister.journalEntryId,
        amount,
      });
      const unreserve = await this.wallet.cancelReservation(
        actor,
        purseId,
        {
          idempotencyKey: postingKey(id, 'unreserve'),
          authorizationId: service.authorizationId,
          amountRial: amount,
        },
        tx,
      );
      posted.push({
        step: 'unreserve',
        op: unreserve.operationId,
        journal: unreserve.journalEntryId,
        amount,
      });

      // 4: the fee, unless 0 or already reversed (an accepted fee dispute).
      if (fee && fee.status !== 'reversed') {
        if (fee.journalEntryId) {
          const reversal = await this.ledger.reverseJournal(
            actor,
            fee.journalEntryId,
            { idempotencyKey: postingKey(id, 'fee'), reason },
            tx,
          );
          posted.push({ step: 'fee', journal: reversal.id });
        }
        await this.setStatus(tx, fee, 'reversed', id);
      }

      // 5: a closed purse never reopens: what came back goes to the debt (the rule of 4-8).
      const purse = await this.wallet.summary(purseId, tx);
      const closed = purse.status === 'closed';
      if (closed) {
        const split = await this.wallet.unusedOf(purseId, tx);
        if (split.loanRial + split.downPaymentRial !== amount) {
          throw new Error('what came back to the closed purse differs from the service');
        }
        if (split.loanRial > 0n) {
          const scheduleId = await this.wallet.scheduleOfPurse(purseId, tx);
          if (!scheduleId) throw new Error('a funded purse without its schedule');
          const revision = await this.repayment.reduceFromLast(
            actor,
            {
              scheduleId,
              amountRial: split.loanRial,
              idempotencyKey: postingKey(id, 'schedule'),
              reason,
            },
            tx,
          );
          posted.push({ step: 'schedule', revision: revision.revisionId, amount: split.loanRial });
        }
        const refund = await this.wallet.returnAfterClose(
          actor,
          purseId,
          { idempotencyKey: postingKey(id, 'refund'), reason, amountRial: amount },
          tx,
        );
        posted.push({
          step: 'refund',
          op: refund.operationId,
          journal: refund.journalEntryId,
          amount,
          downPayment: {
            rial: split.downPaymentRial,
            entityId: purse.entityId,
            borrowerPersonId: purse.borrowerPersonId,
          },
        });
      }

      await this.services.markReversed(actor, service.authorizationId, reason, tx);
      await this.setStatus(tx, payable, 'reversed', id);
      for (const x of posted) {
        await tx.execute(sql`
          INSERT INTO settlement_dispute_postings
            (dispute_id, step, purse_operation_id, journal_entry_id, revision_id, amount_rial,
             down_payment_rial, entity_id, borrower_person_id, created_by)
          VALUES (${id}, ${x.step}, ${x.op ?? null}, ${x.journal ?? null},
                  ${x.revision ?? null}, ${x.amount ?? null}, ${x.downPayment?.rial ?? null},
                  ${x.downPayment?.entityId ?? null}, ${x.downPayment?.borrowerPersonId ?? null},
                  ${actor.accountId})
        `);
      }
      await tx.execute(
        sql`UPDATE financial_disputes SET status = 'resolved_accepted' WHERE id = ${id}`,
      );
      await this.audit.record(
        {
          actor,
          action: 'settlement.dispute_posted',
          entityType: 'financial_dispute',
          entityId: id,
          before: { status: 'accepted_pending_posting' },
          after: {
            status: 'resolved_accepted',
            amountRial: amount.toString(),
            purseClosed: closed,
            steps: posted.map((x) => x.step),
          },
        },
        tx,
      );
      await this.outbox.publish(
        {
          type: 'settlement.dispute_posted',
          aggregateType: 'financial_dispute',
          aggregateId: id,
          payload: {
            disputeId: id,
            payableId: payable.id,
            amountRial: amount.toString(),
            purseClosed: closed,
          },
        },
        tx,
      );
    });
    return this.view(await this.find(this.db, id), actor.accountId);
  }

  // --- helpers -------------------------------------------------------------------------

  /**
   * What a subject is held with: a credit fee with its own payable (and a payable with its
   * fee); a cash fee alone (task 5-3: no payable goes with it).
   */
  private async payableOf(type: DisputeSubject, id: string): Promise<Anchor> {
    if (!UUID.test(id)) throw new NotFoundException({ error: 'item_not_found' });
    if (type === 'doctor_payable') return { kind: 'payable', id };
    const rows = await this.db.execute(
      sql`SELECT doctor_payable_id, cash_service_id FROM service_fees WHERE id = ${id}`,
    );
    const row = rows.rows[0];
    if (!row) throw new NotFoundException({ error: 'item_not_found' });
    const payableId = row['doctor_payable_id'] as string | null;
    return payableId ? { kind: 'payable', id: payableId } : { kind: 'cash_fee', id };
  }

  /** The payable, then its fee, locked FOR UPDATE in this order; a cash fee alone. */
  private async lockItems(tx: Tx, anchor: Anchor): Promise<Item[]> {
    if (anchor.kind === 'cash_fee') {
      const fee = (
        await tx.execute(sql`
          SELECT id, status, due_at, journal_entry_id
          FROM service_fees WHERE id = ${anchor.id} FOR UPDATE
        `)
      ).rows[0];
      if (!fee) throw new NotFoundException({ error: 'item_not_found' });
      return [
        {
          type: 'service_fee',
          id: fee['id'] as string,
          status: fee['status'] as string,
          dueAt: new Date(fee['due_at'] as string),
          workplaceId: null,
          journalEntryId: (fee['journal_entry_id'] as string | null) ?? null,
        },
      ];
    }
    const payableId = anchor.id;
    const payable = (
      await tx.execute(sql`
        SELECT id, status, due_at, workplace_id, journal_entry_id
        FROM doctor_payables WHERE id = ${payableId} FOR UPDATE
      `)
    ).rows[0];
    if (!payable) throw new NotFoundException({ error: 'item_not_found' });
    const fee = (
      await tx.execute(sql`
        SELECT id, status, due_at, journal_entry_id
        FROM service_fees WHERE doctor_payable_id = ${payableId} FOR UPDATE
      `)
    ).rows[0];
    const items: Item[] = [
      {
        type: 'doctor_payable',
        id: payable['id'] as string,
        status: payable['status'] as string,
        dueAt: new Date(payable['due_at'] as string),
        workplaceId: payable['workplace_id'] as string,
        journalEntryId: payable['journal_entry_id'] as string,
      },
    ];
    if (fee) {
      items.push({
        type: 'service_fee',
        id: fee['id'] as string,
        status: fee['status'] as string,
        dueAt: new Date(fee['due_at'] as string),
        workplaceId: null,
        journalEntryId: (fee['journal_entry_id'] as string | null) ?? null,
      });
    }
    return items;
  }

  private async setStatus(tx: Tx, item: Item, status: string, disputeId: string | null) {
    const table = sql.raw(item.type === 'doctor_payable' ? 'doctor_payables' : 'service_fees');
    // A held item was taken out of any statement it was in.
    await tx.execute(sql`
      UPDATE ${table}
      SET status = ${status}, dispute_id = coalesce(${disputeId}::uuid, dispute_id),
          statement_id = CASE WHEN ${status} IN ('on_hold', 'due') THEN NULL ELSE statement_id END
      WHERE id = ${item.id}
    `);
    item.status = status;
  }

  private async find(ex: Database | Tx, id: string): Promise<Row> {
    if (!UUID.test(id)) throw notFound();
    const row = (await ex.execute(sql`SELECT ${COLUMNS} FROM financial_disputes WHERE id = ${id}`))
      .rows[0] as unknown as Row | undefined;
    if (!row) throw notFound();
    return row;
  }

  /**
   * Staff reach an item of their city (its workplace's), or any with a global scope; a doctor
   * or center their own items, by node scope (task 5-6).
   */
  private async reachable(access: EffectiveAccess, anchor: Anchor): Promise<void> {
    if (access.scopes.some((s) => s.kind === 'global')) return;
    const rows = await this.db.execute(
      anchor.kind === 'payable'
        ? sql`SELECT workplace_id FROM doctor_payables WHERE id = ${anchor.id}`
        : sql`SELECT c.workplace_id FROM service_fees f
               JOIN cash_services c ON c.id = f.cash_service_id WHERE f.id = ${anchor.id}`,
    );
    const workplaceId = rows.rows[0]?.['workplace_id'] as string | undefined;
    const workplace = workplaceId ? await this.workplaces.workplace(workplaceId) : null;
    // Staff of its city; a doctor (task 5-6) or their center, by the node scope that covers it.
    const covers =
      workplace !== null &&
      access.scopes.some((s) => {
        if (s.kind === 'city') return s.code === workplace.cityCode;
        if (s.kind === 'center' || s.kind === 'branch' || s.kind === 'doctor') {
          return workplace.nodePath === s.path || workplace.nodePath.startsWith(`${s.path}.`);
        }
        return false;
      });
    if (!covers) throw new NotFoundException({ error: 'item_not_found' });
  }

  private async view(r: Row, viewer: string | null): Promise<DisputeView> {
    const items = await this.db.execute(sql`
      SELECT item_type, item_id, held_from_status FROM financial_dispute_items
      WHERE dispute_id = ${r.id} ORDER BY item_type
    `);
    return {
      id: r.id,
      subjectType: r.subject_type,
      subjectId: r.subject_id,
      reason: r.reason,
      status: r.status,
      openedAt: r.opened_at,
      openedByMe: viewer !== null && r.opened_by === viewer,
      resolvedAt: r.resolved_at,
      resolutionNote: r.resolution_note,
      correctionJournalEntryId: r.correction_journal_entry_id,
      items: items.rows.map((i) => ({
        itemType: i['item_type'] as DisputeSubject,
        itemId: i['item_id'] as string,
        heldFromStatus: i['held_from_status'] as 'accrued' | 'due' | 'in_statement',
      })),
    };
  }

  private require(access: EffectiveAccess, permission: PermissionCode) {
    if (!access.permissions.has(permission)) {
      throw new ForbiddenException({ error: 'permission_required', permission });
    }
  }
}

/** The dispute's state once decided: a payable accepted waits for its posting (5-2b). */
function outcomeOf(subject: DisputeSubject, outcome: 'accepted' | 'rejected'): DisputeStatus {
  if (outcome === 'rejected') return 'resolved_rejected';
  return subject === 'doctor_payable' ? 'accepted_pending_posting' : 'resolved_accepted';
}

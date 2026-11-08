import { FINANCIAL_STEP_UP, type FinancialStepUp } from '../../common/auth/step-up.port';
import { createHash } from 'node:crypto';
import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  buildInstallmentSchedule,
  gregorianDay,
  MAX_CONSECUTIVE_DAYS_OFF,
  nextWorkingDay,
  feeToWaive,
  formatJalaliDate,
  formatToman,
  gregorianToJalali,
  REMINDER_CATCH_UP_DAYS,
  reminderKey,
  reminderStep,
  type ReminderStep,
  normalizeBankRef,
  type PaymentQueueRow,
  type SuspenseRow,
  installmentState,
  reduceFromLast,
  ReductionError,
  ScheduleError,
  toJalali,
  toPersianDigits,
  type ScheduleInput,
} from '@sepehr/contracts';
import { ModuleRef } from '@nestjs/core';
import { sql, type SQL } from 'drizzle-orm';
import {
  AUDIT_LOG,
  type Actor,
  type AuditLog,
  type SqlExecutor,
} from '../../common/audit/audit.port';
import { CONFIG, type ConfigPort } from '../../common/config/config.port';
import {
  HOLIDAY_CALENDAR,
  type HolidayCalendarPort,
} from '../../common/config/holiday-calendar.port';
import { OUTBOX, type OutboxPort } from '../../common/events/outbox.port';
import { LEAD_CASES, type LeadCases } from '../../common/lead/lead-cases.port';
import { LEDGER, type LedgerPort } from '../../common/ledger/ledger.port';
import {
  NOTIFICATIONS,
  type NotificationsPort,
} from '../../common/notification/notifications.port';
import {
  BORROWER_SMS_HOLD,
  type BorrowerSmsHold,
} from '../../common/repayment/borrower-sms-hold.port';
import type {
  CasePayment,
  InstallmentView,
  OverdueCase,
  PaymentDecision,
  RepaymentPort,
  ScheduleView,
} from '../../common/repayment/repayment.port';
import { WALLET, type WalletPort } from '../../common/wallet/wallet.port';
import { DATABASE, type Database } from '../../db/database.module';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface ScheduleRow extends Record<string, unknown> {
  id: string;
  entity_id: string;
  purse_id: string;
  case_id: string;
  principal_rial: string;
  plan_fee_rial: string;
  total_rial: string;
  funded_at: string;
  rounding_unit_rial: string;
  rounding_config_version_id: string;
  due_dates_shifted: boolean;
}

interface InstallmentRow extends Record<string, unknown> {
  id: string;
  index: number;
  due_on: string;
  amount_rial: string;
  paid_rial: string;
}

interface PaymentRow extends Record<string, unknown> {
  id: string;
  schedule_id: string;
  amount_rial: string;
  status: 'pending_approval' | 'approved' | 'rejected';
  receipt_journal_entry_id: string;
  suspected_duplicate_of: string | null;
}

const bad = (error: string, detail?: Record<string, unknown>) =>
  new BadRequestException({ error, ...detail });
const conflict = (error: string, detail?: Record<string, unknown>) =>
  new ConflictException({ error, ...detail });

function checkKey(key: unknown): string {
  if (typeof key !== 'string' || key.length < 8 || key.length > 180) {
    throw bad('idempotency_key_required');
  }
  return key;
}

function checkAmount(amount: unknown): bigint {
  // Rule 1: a JS number (or anything else) is never an amount.
  if (typeof amount !== 'bigint') throw bad('amount_must_be_bigint_rial');
  if (amount <= 0n) throw bad('amount_must_be_positive');
  return amount;
}

const hashOf = (value: unknown) =>
  createHash('sha256')
    .update(
      JSON.stringify(value, (_k, v: unknown) =>
        typeof v === 'bigint' ? v.toString() : v instanceof Date ? v.toISOString() : v,
      ),
      'utf8',
    )
    .digest('hex');

/** Today in Tehran, as the Gregorian YYYY-MM-DD that due_on is stored in. */
export const tehranToday = (now: Date) => gregorianDay(toJalali(now));

/**
 * Doc glossary states, derived: nothing about an installment is ever updated. Task 6-1:
 * contracts' installmentState, phase 1's rule with the schedule's grace days (0: the same).
 */
function stateOf(dueOn: string, amount: bigint, paid: bigint, today: string, graceDays: number) {
  return installmentState(dueOn, amount, paid, today, graceDays);
}

/**
 * Installment schedules and payment allocation (task 1-3, doc 02 §4–5, ADR-019).
 *
 * No late penalty and no early-settlement discount (doc 02 §5): an installment's amount
 * never changes with time; there is simply no code that would change it. Allocation is
 * serialized per case by a lock on the schedule row.
 */
@Injectable()
export class RepaymentService implements RepaymentPort {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(LEDGER) private readonly ledger: LedgerPort,
    @Inject(WALLET) private readonly wallet: WalletPort,
    @Inject(CONFIG) private readonly config: ConfigPort,
    @Inject(OUTBOX) private readonly outbox: OutboxPort,
    @Inject(AUDIT_LOG) private readonly audit: AuditLog,
    @Inject(HOLIDAY_CALENDAR) private readonly holidays: HolidayCalendarPort,
    // Task 6-2: lead's port, resolved when first used: lead's intake needs this module's
    // REPAYMENT, so asking for it here would be a cycle at construction.
    private readonly moduleRef: ModuleRef,
    @Inject(FINANCIAL_STEP_UP) private readonly stepUp: FinancialStepUp,
  ) {}

  private get leads(): LeadCases {
    return this.moduleRef.get<LeadCases>(LEAD_CASES, { strict: false });
  }

  /**
   * Whether a borrower's automatic SMS are held (deceased or disabled): the collection
   * module's (task 6-7), resolved when first used; missing, it fails rather than send.
   */
  private get hold(): BorrowerSmsHold {
    return this.moduleRef.get<BorrowerSmsHold>(BORROWER_SMS_HOLD, { strict: false });
  }

  /** The notification module's port, wherever it is provided (the API's module, the worker). */
  private get notifications(): NotificationsPort {
    return this.moduleRef.get<NotificationsPort>(NOTIFICATIONS, { strict: false });
  }

  private inTransaction<T>(tx: SqlExecutor | undefined, fn: (ex: SqlExecutor) => Promise<T>) {
    return tx ? fn(tx) : this.db.transaction((own) => fn(own));
  }

  // --- the schedule -------------------------------------------------------------------

  async createSchedule(
    actor: Actor,
    input: Parameters<RepaymentPort['createSchedule']>[1],
    tx?: SqlExecutor,
  ): Promise<{ scheduleId: string; replayed: boolean }> {
    const key = checkKey(input.idempotencyKey);
    if (!UUID.test(input.purseId)) throw new NotFoundException({ error: 'purse_not_found' });
    if (typeof input.planFeeRial !== 'bigint' || input.planFeeRial < 0n) {
      throw bad('plan_fee_must_be_bigint_rial');
    }
    // ADR-039: the case's own rounding version, never the one in force at funding.
    const roundingVersionId = input.roundingConfigVersionId as unknown;
    if (typeof roundingVersionId !== 'string' || !UUID.test(roundingVersionId)) {
      throw bad('rounding_version_required');
    }
    // ADR-041: the case's own due-day shift and grace days, never those in force at funding.
    const shiftVersionId = input.shiftConfigVersionId as unknown;
    if (typeof shiftVersionId !== 'string' || !UUID.test(shiftVersionId)) {
      throw bad('shift_version_required');
    }
    const graceVersionId = input.graceConfigVersionId as unknown;
    if (typeof graceVersionId !== 'string' || !UUID.test(graceVersionId)) {
      throw bad('grace_version_required');
    }
    const hash = hashOf({ op: 'schedule', ...input });

    return this.inTransaction(tx, async (ex) => {
      const earlier = await ex.execute(sql`
        SELECT id, request_hash FROM installment_schedules WHERE idempotency_key = ${key}
      `);
      const replay = earlier.rows[0];
      if (replay) {
        if (replay['request_hash'] !== hash) throw conflict('idempotency_key_reused');
        return { scheduleId: replay['id'] as string, replayed: true };
      }

      const purse = await this.wallet.summary(input.purseId, ex);
      if (purse.status !== 'funded' || !purse.fundedAt) {
        throw conflict('purse_not_funded', { status: purse.status });
      }
      const fundedAt = purse.fundedAt;

      // The rounding unit (ADR-039), the due-day shift and the grace days (ADR-041) of the
      // versions the case locked at creation, as its contract was; only the holidays are
      // those known at funding (T2). Each is locked to the schedule (rule 16): a later change
      // never touches this case.
      const shift = await this.config.getVersion(
        'repayment.shift_due_to_next_working_day',
        shiftVersionId,
      );
      const unit = await this.config.getVersion('repayment.rounding_unit_rial', roundingVersionId);
      // Task 6-1: the grace days, locked on the schedule's terms.
      const grace = await this.config.getVersion('repayment.grace_days', graceVersionId);
      const roundingUnitRial = BigInt(unit.value);

      const principal = purse.approvedAmountRial;
      const total = principal + input.planFeeRial;
      const scheduleInput: ScheduleInput = {
        totalRial: total,
        count: input.installmentCount,
        fundedAt,
        roundingUnitRial,
      };
      let installments;
      let weeklyDaysOffVersionId: string | null = null;
      try {
        installments = buildInstallmentSchedule(scheduleInput);
        if (shift.value) {
          // A due day on a weekly day off or a national holiday moves to the next working
          // day (task 2-1); city holidays affect booking only (task 2-1 decision). Only
          // dates move, never amounts. The holidays known now decide, and the stored due
          // days never change afterwards.
          const first = installments[0]?.dueOn ?? '';
          const last = installments.at(-1)?.dueOn ?? first;
          const loaded = await this.holidays.calendarFor(
            {
              from: first,
              to: new Date(Date.parse(last) + (MAX_CONSECUTIVE_DAYS_OFF + 1) * 86_400_000)
                .toISOString()
                .slice(0, 10),
              cityCode: null,
              at: fundedAt,
            },
            ex,
          );
          weeklyDaysOffVersionId = loaded.weeklyDaysOffVersionId;
          installments = buildInstallmentSchedule({
            ...scheduleInput,
            dueDay: (nominal) => nextWorkingDay(nominal, null, loaded.calendar),
          });
        }
      } catch (error) {
        if (error instanceof ScheduleError) throw bad(error.code);
        if (error instanceof RangeError) throw conflict('no_working_day_for_due_date');
        throw error;
      }

      const exists = await ex.execute(sql`
        -- One schedule per purse, so per credit application (migration 0035, owner's decision 5).
        SELECT id FROM installment_schedules WHERE purse_id = ${purse.id}
      `);
      if (exists.rows.length > 0) throw conflict('schedule_exists_for_case');

      // The plan fee, recognized at once (task 1-3 decision; doc 02 §4).
      // TODO(decision): spreading it over the installments instead.
      let feeJournalId: string | null = null;
      if (input.planFeeRial > 0n) {
        const debt = await this.purseAccount(ex, purse.entityId, purse.id, 'borrower.debt');
        const income = await this.companyAccount(ex, purse.entityId, 'company.fee_income');
        const journal = await this.ledger.postJournal(
          actor,
          {
            entityId: purse.entityId,
            eventType: 'repayment.plan_fee',
            occurredAt: new Date(),
            idempotencyKey: `repayment:plan-fee:${key}`,
            caseId: purse.caseId,
            // Members of a treatment group share a case: the fee is told apart by its
            // application (task 4-5; owner 1405/07/11). A reference only; the lines are as before.
            creditApplicationId: purse.creditApplicationId,
            lines: [
              { accountId: debt, direction: 'debit', amountRial: input.planFeeRial },
              { accountId: income, direction: 'credit', amountRial: input.planFeeRial },
            ],
          },
          ex,
        );
        feeJournalId = journal.id;
      }

      const created = await ex.execute(sql`
        INSERT INTO installment_schedules (
          entity_id, purse_id, case_id, principal_rial, plan_fee_rial, total_rial,
          installment_count, funded_at, rounding_unit_rial, rounding_config_version_id,
          due_dates_shifted, shift_config_version_id, weekly_days_off_config_version_id,
          plan_fee_journal_entry_id, idempotency_key, request_hash, created_by
        ) VALUES (
          ${purse.entityId}, ${purse.id}, ${purse.caseId}, ${principal.toString()}::bigint,
          ${input.planFeeRial.toString()}::bigint, ${total.toString()}::bigint,
          ${input.installmentCount}, ${fundedAt}, ${roundingUnitRial.toString()}::bigint,
          ${unit.versionId}, ${shift.value}, ${shift.versionId}, ${weeklyDaysOffVersionId},
          ${feeJournalId}, ${key}, ${hash}, ${actor.accountId}
        )
        RETURNING id
      `);
      const scheduleId = created.rows[0]?.['id'] as string;
      const values: SQL[] = installments.map(
        (i) =>
          sql`(${scheduleId}, ${i.index}, ${i.dueOn}::date, ${i.amountRial.toString()}::bigint)`,
      );
      await ex.execute(sql`
        INSERT INTO installments (schedule_id, index, due_on, amount_rial)
        VALUES ${sql.join(values, sql`, `)}
      `);
      await ex.execute(sql`
        INSERT INTO installment_schedule_terms (schedule_id, grace_days, grace_config_version_id)
        VALUES (${scheduleId}, ${grace.value}, ${grace.versionId})
      `);
      await this.publish(ex, scheduleId, purse.caseId, 'schedule_created', null, total);
      return { scheduleId, replayed: false };
    });
  }

  // --- payments -----------------------------------------------------------------------

  async registerReceipt(
    actor: Actor,
    input: Parameters<RepaymentPort['registerReceipt']>[1],
    tx?: SqlExecutor,
  ): Promise<{ paymentId: string; replayed: boolean }> {
    const key = checkKey(input.idempotencyKey);
    const amount = checkAmount(input.amountRial);
    if (!(input.receivedAt instanceof Date) || Number.isNaN(input.receivedAt.getTime())) {
      throw bad('invalid_received_at');
    }
    const hash = hashOf({ op: 'receipt', ...input });
    return this.inTransaction(tx, async (ex) => {
      const schedule = await this.lockSchedule(ex, input.scheduleId);
      const earlier = await ex.execute(sql`
        SELECT id, request_hash FROM payments WHERE idempotency_key = ${key}
      `);
      const replay = earlier.rows[0];
      if (replay) {
        if (replay['request_hash'] !== hash) throw conflict('idempotency_key_reused');
        return { paymentId: replay['id'] as string, replayed: true };
      }
      const bank = await this.companyAccount(ex, schedule.entity_id, 'bank.collection');
      const suspense = await this.purseAccount(
        ex,
        schedule.entity_id,
        schedule.purse_id,
        'suspense.unallocated',
      );
      const journal = await this.ledger.postJournal(
        actor,
        {
          entityId: schedule.entity_id,
          eventType: 'repayment.receipt_pending',
          occurredAt: input.receivedAt,
          idempotencyKey: `repayment:receipt:${key}`,
          caseId: schedule.case_id,
          lines: [
            { accountId: bank, direction: 'debit', amountRial: amount },
            { accountId: suspense, direction: 'credit', amountRial: amount },
          ],
        },
        ex,
      );
      // Task 6-2 (owner, Q2): a slip like one already received (bank ref, amount, day) is
      // flagged, never refused here, and posts nothing more than any other.
      const refNorm = input.reference ? normalizeBankRef(input.reference) : null;
      const paidOn = input.paidOn ?? null;
      const twin =
        refNorm && paidOn
          ? ((
              await ex.execute(sql`
                SELECT id FROM payments
                WHERE bank_ref_norm = ${refNorm} AND amount_rial = ${amount.toString()}::bigint
                  AND paid_on = ${paidOn}::date AND status <> 'rejected'
                ORDER BY created_at LIMIT 1
              `)
            ).rows[0]?.['id'] as string | undefined)
          : undefined;
      const inserted = await ex.execute(sql`
        INSERT INTO payments (
          schedule_id, amount_rial, received_at, reference, receipt_journal_entry_id,
          idempotency_key, request_hash, created_by, channel, paid_on, bank_ref_norm,
          payer_name, submitted_by_account_id, image_key, image_mime, image_sha256,
          suspected_duplicate_of
        ) VALUES (
          ${schedule.id}, ${amount.toString()}::bigint, ${input.receivedAt},
          ${input.reference ?? null}, ${journal.id}, ${key}, ${hash}, ${actor.accountId},
          ${input.channel ?? 'staff'}, ${paidOn}, ${refNorm}, ${input.payerName ?? null},
          ${input.submittedByAccountId ?? null}, ${input.image?.key ?? null},
          ${input.image?.mime ?? null}, ${input.image?.sha256 ?? null}, ${twin ?? null}
        )
        RETURNING id
      `);
      const paymentId = inserted.rows[0]?.['id'] as string;
      await this.publish(
        ex,
        schedule.id,
        schedule.case_id,
        'receipt_registered',
        paymentId,
        amount,
      );
      return { paymentId, replayed: false };
    });
  }

  /**
   * Financial approval of a received payment (doc 02 §4–5): allocated to the oldest
   * outstanding installment first, then the next ones in due order (paying ahead is
   * allowed, with no discount). One document moves the allocated amount from
   * suspense.unallocated to borrower.debt; anything beyond the remaining obligation stays
   * in suspense.unallocated until someone decides. Approving twice changes nothing.
   */
  async approvePayment(
    actor: Actor,
    paymentId: string,
    tx?: SqlExecutor,
    options: { notDuplicate?: boolean; reason?: string } = {},
  ): Promise<PaymentDecision> {
    return this.inTransaction(tx, async (ex) => {
      const { payment, schedule } = await this.lockPayment(ex, paymentId);
      if (payment.status === 'approved') return this.decisionOf(ex, payment, true);
      if (payment.status === 'rejected') throw conflict('payment_rejected');
      // Owner (Q2): the flag only warns; approving takes an explicit decision and a reason.
      const cleared = options.reason?.trim() ?? '';
      if (payment.suspected_duplicate_of && (!options.notDuplicate || cleared.length < 3)) {
        throw conflict('suspected_duplicate', { of: payment.suspected_duplicate_of });
      }
      // ADR-052: one person, with their own SMS code for this slip and its amount.
      await this.stepUp.assert(actor, {
        type: 'installment_payment',
        id: paymentId,
        amountRial: BigInt(payment.amount_rial),
        step: 'approve',
      });

      const amount = BigInt(payment.amount_rial);
      const installments = await this.installmentRows(ex, schedule.id);
      const allocations: { installmentId: string; amountRial: bigint }[] = [];
      let left = amount;
      for (const i of installments) {
        if (left === 0n) break;
        const outstanding = BigInt(i.amount_rial) - BigInt(i.paid_rial);
        if (outstanding <= 0n) continue;
        const take = outstanding < left ? outstanding : left;
        allocations.push({ installmentId: i.id, amountRial: take });
        left -= take;
      }
      const allocated = amount - left;

      let journalId: string | null = null;
      if (allocated > 0n) {
        const suspense = await this.purseAccount(
          ex,
          schedule.entity_id,
          schedule.purse_id,
          'suspense.unallocated',
        );
        const debt = await this.purseAccount(
          ex,
          schedule.entity_id,
          schedule.purse_id,
          'borrower.debt',
        );
        const journal = await this.ledger.postJournal(
          actor,
          {
            entityId: schedule.entity_id,
            eventType: 'repayment.payment_allocated',
            occurredAt: new Date(),
            idempotencyKey: `repayment:allocate:${payment.id}`,
            caseId: schedule.case_id,
            lines: [
              { accountId: suspense, direction: 'debit', amountRial: allocated },
              { accountId: debt, direction: 'credit', amountRial: allocated },
            ],
          },
          ex,
        );
        journalId = journal.id;
        const values: SQL[] = allocations.map(
          (a) => sql`(${payment.id}, ${a.installmentId}, ${a.amountRial.toString()}::bigint)`,
        );
        await ex.execute(sql`
          INSERT INTO payment_allocations (payment_id, installment_id, amount_rial)
          VALUES ${sql.join(values, sql`, `)}
        `);
      }
      await ex.execute(sql`
        UPDATE payments
        SET status = 'approved', allocation_journal_entry_id = ${journalId},
            decided_by = ${actor.accountId}, decided_at = now(),
            duplicate_cleared_reason = ${payment.suspected_duplicate_of ? cleared : null}
        WHERE id = ${payment.id}
      `);
      await this.audit.record(
        {
          actor,
          action: 'repayment.payment_approved',
          entityType: 'payment',
          entityId: payment.id,
          after: {
            amountRial: amount.toString(),
            allocatedRial: allocated.toString(),
            surplusRial: left.toString(),
            allocations: allocations.map((a) => ({
              installmentId: a.installmentId,
              amountRial: a.amountRial.toString(),
            })),
          },
        },
        ex,
      );
      await this.publish(ex, schedule.id, schedule.case_id, 'payment_approved', payment.id, amount);
      if (allocated > 0n) await this.settleIfPaid(ex, actor, schedule, payment.id);
      // Task 6-6 (owner: only messages change): an installment now paid in full has its
      // reminders still waiting cancelled; the payer told. No posting, no allocation.
      for (const a of allocations) {
        const i = installments.find((row) => row.id === a.installmentId);
        if (i && BigInt(i.amount_rial) - BigInt(i.paid_rial) === a.amountRial) {
          await this.notifications.cancelScheduled(`repayment:reminder:${i.id}:`, ex);
        }
      }
      await this.notifyApproved(ex, schedule, payment);
      return {
        paymentId: payment.id,
        status: 'approved',
        allocatedRial: allocated,
        surplusRial: left,
        allocations,
        replayed: false,
      };
    });
  }

  /**
   * A received payment that is not accepted. Its amount stays in suspense.unallocated.
   * TODO(decision): what happens to it then (refund, re-allocation); doc 02 is silent.
   */
  async rejectPayment(
    actor: Actor,
    paymentId: string,
    reason: string,
    tx?: SqlExecutor,
    kind: 'not_received' | 'received_unaccepted' = 'received_unaccepted',
  ): Promise<PaymentDecision> {
    if (reason.trim().length < 3) throw bad('reason_required');
    return this.inTransaction(tx, async (ex) => {
      const { payment, schedule } = await this.lockPayment(ex, paymentId);
      if (payment.status === 'rejected') return this.decisionOf(ex, payment, true);
      if (payment.status === 'approved') throw conflict('payment_already_approved');
      // Owner (Q1): money that never came is reversed exactly; money that came stays in
      // suspense until accounting decides (by two people, a later task).
      const reversal =
        kind === 'not_received'
          ? (
              await this.ledger.reverseJournal(
                actor,
                payment.receipt_journal_entry_id,
                { idempotencyKey: `repayment:receipt:${payment.id}:reject`, reason: reason.trim() },
                ex,
              )
            ).id
          : null;
      await ex.execute(sql`
        UPDATE payments
        SET status = 'rejected', decided_by = ${actor.accountId}, decided_at = now(),
            decision_reason = ${reason.trim()}, reject_kind = ${kind},
            reject_journal_entry_id = ${reversal}
        WHERE id = ${payment.id}
      `);
      await this.notifyRejected(ex, schedule, payment);
      await this.audit.record(
        {
          actor,
          action: 'repayment.payment_rejected',
          entityType: 'payment',
          entityId: payment.id,
          after: { amountRial: payment.amount_rial, kind, reversalJournalEntryId: reversal },
          reason: reason.trim(),
        },
        ex,
      );
      const amount = BigInt(payment.amount_rial);
      await this.publish(ex, schedule.id, schedule.case_id, 'payment_rejected', payment.id, amount);
      return {
        paymentId: payment.id,
        status: 'rejected',
        allocatedRial: 0n,
        surplusRial: amount,
        allocations: [],
        replayed: false,
      };
    });
  }

  // --- reading ------------------------------------------------------------------------

  async schedule(scheduleId: string, now = new Date(), tx?: SqlExecutor): Promise<ScheduleView> {
    return this.inTransaction(tx, async (ex) => {
      const s = await this.scheduleRow(ex, scheduleId);
      const today = tehranToday(now);
      const graceDays = await this.graceOf(ex, s.id);
      const installments: InstallmentView[] = (await this.installmentRows(ex, s.id)).map((i) => {
        const amount = BigInt(i.amount_rial);
        const paid = BigInt(i.paid_rial);
        const state = stateOf(i.due_on, amount, paid, today, graceDays);
        return {
          id: i.id,
          index: i.index,
          dueOn: i.due_on,
          amountRial: amount,
          paidRial: paid,
          outstandingRial: amount - paid,
          status: state.status,
          daysPastDue: state.daysPastDue,
        };
      });
      const suspense = await this.purseAccount(ex, s.entity_id, s.purse_id, 'suspense.unallocated');
      const balance = await this.ledger.balanceOf(suspense, undefined, ex);
      const paid = installments.reduce((sum, i) => sum + i.paidRial, 0n);
      // The schedule's total with its revisions (task 4-8).
      const total = BigInt(s.total_rial) + (await this.revisedBy(ex, s.id));
      return {
        id: s.id,
        caseId: s.case_id,
        purseId: s.purse_id,
        principalRial: BigInt(s.principal_rial),
        planFeeRial: BigInt(s.plan_fee_rial),
        totalRial: total,
        fundedAt: new Date(s.funded_at),
        roundingUnitRial: BigInt(s.rounding_unit_rial),
        roundingConfigVersionId: s.rounding_config_version_id,
        dueDatesShifted: s.due_dates_shifted,
        graceDays,
        installments,
        maxDaysPastDue: installments.reduce((m, i) => Math.max(m, i.daysPastDue), 0),
        paidRial: paid,
        outstandingRial: total - paid,
        // suspense.unallocated carries a credit balance.
        unallocatedRial: -balance.netDebitRial,
      };
    });
  }

  // --- slips: settlement, the rejection SMS, the queue and suspense (task 6-2) --------

  /**
   * A schedule paid in full: settled once, `loan.settled` published; the case completed in
   * this same transaction when all of its schedules are (owner, Q3).
   */
  private async settleIfPaid(
    ex: SqlExecutor,
    actor: Actor,
    schedule: ScheduleRow,
    paymentId: string,
  ): Promise<void> {
    const owed = (await this.installmentRows(ex, schedule.id)).reduce(
      (s, i) => s + (BigInt(i.amount_rial) - BigInt(i.paid_rial)),
      0n,
    );
    if (owed > 0n) return;
    const made = await ex.execute(sql`
      INSERT INTO loan_settlements (schedule_id, case_id, payment_id)
      VALUES (${schedule.id}, ${schedule.case_id}, ${paymentId})
      ON CONFLICT (schedule_id) DO NOTHING
      RETURNING schedule_id
    `);
    if (made.rows.length === 0) return;
    const open = await ex.execute(sql`
      SELECT 1 FROM installment_schedules s
      WHERE s.case_id = ${schedule.case_id}
        AND NOT EXISTS (SELECT 1 FROM loan_settlements l WHERE l.schedule_id = s.id)
    `);
    const caseCompleted =
      open.rows.length === 0 && (await this.leads.completeCase(ex, actor, schedule.case_id));
    await this.audit.record(
      {
        actor,
        action: 'repayment.loan_settled',
        entityType: 'installment_schedule',
        entityId: schedule.id,
        after: { caseId: schedule.case_id, paymentId, caseCompleted },
      },
      ex,
    );
    await this.outbox.publish(
      {
        type: 'loan.settled',
        aggregateType: 'installment_schedule',
        aggregateId: schedule.id,
        payload: {
          scheduleId: schedule.id,
          caseId: schedule.case_id,
          purseId: schedule.purse_id,
          caseCompleted,
        },
      },
      ex,
    );
  }

  /**
   * Task 6-6: the slip approved, told to the borrower whose purse it is (doc 15 §4's payer:
   * a third party's slip carries a name, no mobile; TODO(decision), default the borrower).
   */
  private async notifyApproved(ex: SqlExecutor, schedule: ScheduleRow, payment: PaymentRow) {
    const purse = await this.wallet.summary(schedule.purse_id, ex);
    if (await this.hold.isHeld(purse.borrowerPersonId, ex)) return;
    const mobile = await this.leads.mobileOf(purse.borrowerPersonId, ex);
    if (!mobile) return;
    await this.notifications.send(
      {
        templateCode: 'repayment.receipt_approved',
        audience: 'borrower',
        mobile,
        personId: purse.borrowerPersonId,
        values: { amount: formatToman(BigInt(payment.amount_rial)) },
        idempotencyKey: `repayment:receipt:${payment.id}:approved-sms`,
      },
      ex,
    );
  }

  /** The borrower told by SMS (task 6-4's module): the first version of the template is seeded. */
  private async notifyRejected(ex: SqlExecutor, schedule: ScheduleRow, payment: PaymentRow) {
    const purse = await this.wallet.summary(schedule.purse_id, ex);
    const mobile = await this.leads.mobileOf(purse.borrowerPersonId, ex);
    if (!mobile) return;
    await this.notifications.send(
      {
        templateCode: 'repayment.receipt_rejected',
        audience: 'borrower',
        mobile,
        personId: purse.borrowerPersonId,
        values: { amount: formatToman(BigInt(payment.amount_rial)) },
        idempotencyKey: `repayment:receipt:${payment.id}:rejected-sms`,
      },
      ex,
    );
  }

  /** The approval queue: newest first, a duplicate flag shown, never the image itself. */
  async payments(
    status?: 'pending_approval' | 'approved' | 'rejected',
  ): Promise<PaymentQueueRow[]> {
    const rows = await this.db.execute(sql`
      SELECT p.id, p.schedule_id, s.case_id, p.amount_rial::text AS amount,
             to_char(p.received_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS received_at,
             p.paid_on::text AS paid_on, p.reference, p.payer_name, p.channel, p.status,
             p.reject_kind, p.suspected_duplicate_of, p.image_key IS NOT NULL AS has_image
      FROM payments p JOIN installment_schedules s ON s.id = p.schedule_id
      WHERE (${status ?? null}::text IS NULL OR p.status = ${status ?? null})
      ORDER BY p.created_at DESC LIMIT 500
    `);
    return rows.rows.map((r) => ({
      id: r['id'] as string,
      scheduleId: r['schedule_id'] as string,
      caseId: r['case_id'] as string,
      amountRial: r['amount'] as string,
      receivedAt: r['received_at'] as string,
      paidOn: (r['paid_on'] as string | null) ?? null,
      bankRef: (r['reference'] as string | null) ?? null,
      payerName: (r['payer_name'] as string | null) ?? null,
      channel: r['channel'] as PaymentQueueRow['channel'],
      status: r['status'] as PaymentQueueRow['status'],
      rejectKind: (r['reject_kind'] as PaymentQueueRow['rejectKind']) ?? null,
      suspectedDuplicateOf: (r['suspected_duplicate_of'] as string | null) ?? null,
      hasImage: r['has_image'] as boolean,
    }));
  }

  /**
   * What each schedule holds in suspense.unallocated, and why (owner: reported, not moved;
   * leaving it is accounting's two-person decision, a later task; back to the purse only
   * after an ADR).
   */
  async suspense(): Promise<SuspenseRow[]> {
    const rows = await this.db.execute(sql`
      SELECT s.id, s.case_id, s.entity_id, s.purse_id,
             coalesce(sum(p.amount_rial) FILTER (WHERE p.status = 'pending_approval'), 0)::text AS pending,
             coalesce(sum(p.amount_rial) FILTER (WHERE p.status = 'rejected'
                        AND coalesce(p.reject_kind, 'received_unaccepted') = 'received_unaccepted'), 0)::text AS rejected,
             coalesce(sum(p.amount_rial - coalesce((SELECT sum(a.amount_rial) FROM payment_allocations a
                                                   WHERE a.payment_id = p.id), 0))
                      FILTER (WHERE p.status = 'approved'), 0)::text AS surplus
      FROM installment_schedules s JOIN payments p ON p.schedule_id = s.id
      GROUP BY s.id
    `);
    const out: SuspenseRow[] = [];
    for (const r of rows.rows) {
      const account = await this.purseAccount(
        this.db,
        r['entity_id'] as string,
        r['purse_id'] as string,
        'suspense.unallocated',
      );
      const balance = await this.ledger.balanceOf(account);
      const unallocated = -balance.netDebitRial;
      if (unallocated === 0n) continue;
      out.push({
        scheduleId: r['id'] as string,
        caseId: r['case_id'] as string,
        unallocatedRial: unallocated.toString(),
        surplusRial: r['surplus'] as string,
        rejectedReceivedRial: r['rejected'] as string,
        pendingRial: r['pending'] as string,
      });
    }
    return out;
  }

  // --- the installment cycle (task 6-1 [financial]; doc 15 §3) ------------------------

  /**
   * The nightly job, idempotent, Tehran: the states view refreshed for reports and queues;
   * each installment due today, and each overdue one, announced once (`installment.due`,
   * `installment.overdue`). Nothing about an installment, amount or document changes.
   * A missed night is caught up: an overdue installment not yet announced is, once.
   */
  async runCycle(now = new Date()): Promise<{ due: number; overdue: number }> {
    const today = tehranToday(now);
    await this.db.execute(sql`REFRESH MATERIALIZED VIEW CONCURRENTLY installment_states`);
    const rows = await this.db.execute(sql`
      SELECT i.id, i.schedule_id, s.case_id, i.due_on::text AS due_on,
             coalesce((
               SELECT r.amount_rial FROM installment_revision_amounts r
               JOIN installment_schedule_revisions v ON v.id = r.revision_id
               WHERE r.installment_id = i.id
               ORDER BY v.revision_no DESC LIMIT 1
             ), i.amount_rial)::text AS amount_rial,
             coalesce((SELECT sum(a.amount_rial) FROM payment_allocations a
                       WHERE a.installment_id = i.id), 0)::text AS paid_rial,
             coalesce(t.grace_days, 0) AS grace_days,
             EXISTS (SELECT 1 FROM installment_cycle_events e
                     WHERE e.installment_id = i.id AND e.kind = 'due') AS due_sent
      FROM installments i
      JOIN installment_schedules s ON s.id = i.schedule_id
      LEFT JOIN installment_schedule_terms t ON t.schedule_id = i.schedule_id
      WHERE i.due_on <= ${today}::date
        AND NOT EXISTS (SELECT 1 FROM installment_cycle_events e
                        WHERE e.installment_id = i.id AND e.kind = 'overdue')
      ORDER BY i.due_on, i.id
    `);
    let due = 0;
    let overdue = 0;
    for (const r of rows.rows) {
      const amount = BigInt(r['amount_rial'] as string);
      const paid = BigInt(r['paid_rial'] as string);
      const dueOn = r['due_on'] as string;
      const state = stateOf(dueOn, amount, paid, today, Number(r['grace_days']));
      const outstanding = amount - paid;
      const base = {
        installmentId: r['id'] as string,
        scheduleId: r['schedule_id'] as string,
        caseId: r['case_id'] as string,
        dueOn,
        outstandingRial: outstanding.toString(),
      };
      if (dueOn === today && outstanding > 0n && !r['due_sent']) {
        if (await this.announce(base, 'due', today, {})) due += 1;
      }
      if (state.status === 'overdue') {
        if (await this.announce(base, 'overdue', today, { daysPastDue: state.daysPastDue })) {
          overdue += 1;
        }
      }
    }
    return { due, overdue };
  }

  /** One event of one installment, once (the unique row decides). */
  private async announce(
    base: {
      installmentId: string;
      scheduleId: string;
      caseId: string;
      dueOn: string;
      outstandingRial: string;
    },
    kind: 'due' | 'overdue',
    today: string,
    extra: Record<string, unknown>,
  ): Promise<boolean> {
    return this.db.transaction(async (tx) => {
      const made = await tx.execute(sql`
        INSERT INTO installment_cycle_events (installment_id, kind, as_of)
        VALUES (${base.installmentId}, ${kind}, ${today}::date)
        ON CONFLICT (installment_id, kind) DO NOTHING
        RETURNING id
      `);
      if (made.rows.length === 0) return false;
      await this.outbox.publish(
        {
          type: `installment.${kind}`,
          aggregateType: 'installment',
          aggregateId: base.installmentId,
          payload: { ...base, ...extra },
        },
        tx,
      );
      return true;
    });
  }

  // --- reminders and overdue notices (task 6-6; doc 15 §4) ---------------------------------

  /**
   * The daily job, idempotent, Tehran: each installment still owed gets the step of the day
   * (contracts' reminderStep: 3 and 0 days before, 1, 7 and 15 after, by configuration),
   * once, through the SMS module (allowed hours, editable templates). A paid installment
   * gets nothing; a held borrower (deceased or disabled, task 6-7) gets nothing. The amount
   * still owed is read now, not from the nightly view. Nothing about money changes.
   */
  async runReminders(now = new Date()): Promise<{ sent: number; held: number }> {
    const today = tehranToday(now);
    const [before, after] = await Promise.all([
      this.config.resolve('repayment.reminder_days_before', {}, now),
      this.config.resolve('repayment.overdue_notice_days', {}, now),
    ]);
    const daysBefore = before.value as readonly number[];
    const overdueDays = after.value as readonly number[];
    const ahead = Math.max(0, ...daysBefore);
    const behind = Math.max(0, ...overdueDays) + REMINDER_CATCH_UP_DAYS;
    // Grace days push an overdue notice later; the widest grace bounds the window.
    const rows = await this.db.execute(sql`
      SELECT i.id, i.index, i.schedule_id, s.purse_id, i.due_on::text AS due_on,
             coalesce((
               SELECT r.amount_rial FROM installment_revision_amounts r
               JOIN installment_schedule_revisions v ON v.id = r.revision_id
               WHERE r.installment_id = i.id
               ORDER BY v.revision_no DESC LIMIT 1
             ), i.amount_rial)::text AS amount_rial,
             coalesce((SELECT sum(a.amount_rial) FROM payment_allocations a
                       WHERE a.installment_id = i.id), 0)::text AS paid_rial,
             coalesce(t.grace_days, 0) AS grace_days,
             coalesce((SELECT array_agg(m.kind || ':' || m.offset_days)
                       FROM installment_reminders m WHERE m.installment_id = i.id),
                      '{}') AS sent
      FROM installments i
      JOIN installment_schedules s ON s.id = i.schedule_id
      LEFT JOIN installment_schedule_terms t ON t.schedule_id = i.schedule_id
      WHERE i.due_on <= (${today}::date + ${ahead}::int)
        AND i.due_on >= (${today}::date - ${behind}::int - coalesce(t.grace_days, 0))
      ORDER BY i.due_on, i.id
    `);
    let sent = 0;
    let held = 0;
    for (const r of rows.rows) {
      const amount = BigInt(r['amount_rial'] as string);
      const paid = BigInt(r['paid_rial'] as string);
      const dueOn = r['due_on'] as string;
      const state = stateOf(dueOn, amount, paid, today, Number(r['grace_days']));
      const step = reminderStep({
        dueOn,
        today,
        state: state.status,
        daysPastDue: state.daysPastDue,
        daysBefore,
        overdueDays,
        sent: new Set(r['sent'] as string[]),
      });
      if (!step) continue;
      const outcome = await this.remind(
        {
          installmentId: r['id'] as string,
          index: Number(r['index']),
          purseId: r['purse_id'] as string,
          dueOn,
          outstanding: amount - paid,
          daysPastDue: state.daysPastDue,
        },
        step,
      );
      if (outcome === 'sent') sent += 1;
      if (outcome === 'held') held += 1;
    }
    return { sent, held };
  }

  /** One step of one installment: the SMS and its row, together, once. */
  private async remind(
    i: {
      installmentId: string;
      index: number;
      purseId: string;
      dueOn: string;
      outstanding: bigint;
      daysPastDue: number;
    },
    step: ReminderStep,
  ): Promise<'sent' | 'held' | 'skipped'> {
    return this.db.transaction(async (tx) => {
      const purse = await this.wallet.summary(i.purseId, tx);
      const person = purse.borrowerPersonId;
      // Doc 15 §5: a deceased or disabled borrower gets no automatic SMS; nothing recorded,
      // so the next step goes out if the status is lifted.
      if (await this.hold.isHeld(person, tx)) return 'held';
      const mobile = await this.leads.mobileOf(person, tx);
      if (!mobile) return 'skipped';
      // A person with no name yet is addressed as a customer.
      const name = (await this.leads.displayNameOf(person, tx)) ?? 'مشتری';
      const [y, m, d] = i.dueOn.split('-').map(Number);
      const dueDate = formatJalaliDate(
        gregorianToJalali({ year: y ?? 0, month: m ?? 0, day: d ?? 0 }),
      );
      const template =
        step.kind === 'overdue'
          ? 'repayment.overdue_notice'
          : step.offsetDays === 0
            ? 'repayment.reminder_due_today'
            : 'repayment.reminder_before_due';
      const key = `repayment:reminder:${i.installmentId}:${reminderKey(step)}`;
      const sms = await this.notifications.send(
        {
          templateCode: template,
          audience: 'borrower',
          mobile,
          personId: person,
          values: {
            name,
            amount: formatToman(i.outstanding),
            due_date: dueDate,
            installment_number: toPersianDigits(i.index),
            days_overdue: toPersianDigits(i.daysPastDue),
          },
          idempotencyKey: key,
        },
        tx,
      );
      const made = await tx.execute(sql`
        INSERT INTO installment_reminders (installment_id, kind, offset_days, dispatch_id)
        VALUES (${i.installmentId}, ${step.kind}, ${step.offsetDays}, ${sms.dispatchId})
        ON CONFLICT (installment_id, kind, offset_days) DO NOTHING
        RETURNING id
      `);
      return made.rows.length > 0 ? 'sent' : 'skipped';
    });
  }

  // --- what the collection module reads (task 6-7) ----------------------------------------

  async overdueCases(now = new Date(), tx?: SqlExecutor): Promise<OverdueCase[]> {
    const today = tehranToday(now);
    const rows = await (tx ?? this.db).execute(sql`
      SELECT s.case_id, s.purse_id, i.due_on::text AS due_on,
             coalesce((
               SELECT r.amount_rial FROM installment_revision_amounts r
               JOIN installment_schedule_revisions v ON v.id = r.revision_id
               WHERE r.installment_id = i.id
               ORDER BY v.revision_no DESC LIMIT 1
             ), i.amount_rial)::text AS amount_rial,
             coalesce((SELECT sum(a.amount_rial) FROM payment_allocations a
                       WHERE a.installment_id = i.id), 0)::text AS paid_rial,
             coalesce(t.grace_days, 0) AS grace_days
      FROM installments i
      JOIN installment_schedules s ON s.id = i.schedule_id
      LEFT JOIN installment_schedule_terms t ON t.schedule_id = i.schedule_id
      WHERE i.due_on < ${today}::date
      ORDER BY s.case_id, i.due_on
    `);
    const byCase = new Map<
      string,
      { max: number; count: number; rial: bigint; purses: Set<string> }
    >();
    for (const r of rows.rows) {
      const amount = BigInt(r['amount_rial'] as string);
      const paid = BigInt(r['paid_rial'] as string);
      const state = stateOf(r['due_on'] as string, amount, paid, today, Number(r['grace_days']));
      if (state.status !== 'overdue') continue;
      const caseId = r['case_id'] as string;
      const c = byCase.get(caseId) ?? { max: 0, count: 0, rial: 0n, purses: new Set<string>() };
      c.max = Math.max(c.max, state.daysPastDue);
      c.count += 1;
      c.rial += amount - paid;
      c.purses.add(r['purse_id'] as string);
      byCase.set(caseId, c);
    }
    return [...byCase].map(([caseId, c]) => ({
      caseId,
      maxDaysPastDue: c.max,
      overdueInstallments: c.count,
      overdueRial: c.rial,
      purseIds: [...c.purses],
    }));
  }

  async activeCases(tx?: SqlExecutor): Promise<{ caseId: string; purseIds: string[] }[]> {
    const rows = await (tx ?? this.db).execute(sql`
      SELECT s.case_id, s.purse_id,
             coalesce((
               SELECT r.amount_rial FROM installment_revision_amounts r
               JOIN installment_schedule_revisions v ON v.id = r.revision_id
               WHERE r.installment_id = i.id
               ORDER BY v.revision_no DESC LIMIT 1
             ), i.amount_rial)::text AS amount_rial,
             coalesce((SELECT sum(a.amount_rial) FROM payment_allocations a
                       WHERE a.installment_id = i.id), 0)::text AS paid_rial
      FROM installments i
      JOIN installment_schedules s ON s.id = i.schedule_id
      ORDER BY s.case_id, i.due_on
    `);
    const byCase = new Map<string, Set<string>>();
    for (const r of rows.rows) {
      if (BigInt(r['amount_rial'] as string) <= BigInt(r['paid_rial'] as string)) continue;
      const caseId = r['case_id'] as string;
      const purses = byCase.get(caseId) ?? new Set<string>();
      purses.add(r['purse_id'] as string);
      byCase.set(caseId, purses);
    }
    return [...byCase].map(([caseId, purses]) => ({ caseId, purseIds: [...purses] }));
  }

  async schedulesOf(caseId: string, tx?: SqlExecutor): Promise<string[]> {
    if (!UUID.test(caseId)) return [];
    const rows = await (tx ?? this.db).execute(sql`
      SELECT id FROM installment_schedules WHERE case_id = ${caseId} ORDER BY created_at, id
    `);
    return rows.rows.map((r) => r['id'] as string);
  }

  async paymentsOf(caseId: string, tx?: SqlExecutor): Promise<CasePayment[]> {
    if (!UUID.test(caseId)) return [];
    const rows = await (tx ?? this.db).execute(sql`
      SELECT p.id, p.schedule_id, p.amount_rial::text AS amount_rial, p.status, p.received_at
      FROM payments p JOIN installment_schedules s ON s.id = p.schedule_id
      WHERE s.case_id = ${caseId}
      ORDER BY p.received_at DESC, p.id DESC
    `);
    return rows.rows.map((r) => ({
      paymentId: r['id'] as string,
      scheduleId: r['schedule_id'] as string,
      amountRial: BigInt(r['amount_rial'] as string),
      status: r['status'] as CasePayment['status'],
      receivedAt: new Date(r['received_at'] as string),
    }));
  }

  async allocatedSince(caseId: string, since: Date, tx?: SqlExecutor): Promise<bigint> {
    const row = (
      await (tx ?? this.db).execute(sql`
        SELECT coalesce(sum(a.amount_rial), 0)::text AS rial
        FROM payment_allocations a
        JOIN installments i ON i.id = a.installment_id
        JOIN installment_schedules s ON s.id = i.schedule_id
        WHERE s.case_id = ${caseId} AND a.created_at >= ${since}
      `)
    ).rows[0];
    return BigInt((row?.['rial'] as string | undefined) ?? '0');
  }

  /** The grace days locked on a schedule (0 for one made before task 6-1's backfill). */
  private async graceOf(ex: SqlExecutor, scheduleId: string): Promise<number> {
    const row = (
      await ex.execute(sql`
        SELECT grace_days FROM installment_schedule_terms WHERE schedule_id = ${scheduleId}
      `)
    ).rows[0];
    return Number(row?.['grace_days'] ?? 0);
  }

  async casesWithOutstanding(caseIds: readonly string[], tx?: SqlExecutor): Promise<string[]> {
    const ids = caseIds.filter((id) => UUID.test(id));
    if (ids.length === 0) return [];
    return this.inTransaction(tx, async (ex) => {
      const rows = await ex.execute(sql`
        SELECT s.case_id
        FROM installment_schedules s
        WHERE s.case_id IN (${sql.join(
          ids.map((id) => sql`${id}::uuid`),
          sql`, `,
        )})
          AND s.total_rial + (
            SELECT coalesce(sum(v.change_rial), 0) FROM installment_schedule_revisions v
            WHERE v.schedule_id = s.id) > (
            SELECT coalesce(sum(a.amount_rial), 0)
            FROM installments i JOIN payment_allocations a ON a.installment_id = i.id
            WHERE i.schedule_id = s.id)
      `);
      return rows.rows.map((r) => r['case_id'] as string);
    });
  }

  // --- revisions (task 4-8 [financial]; owner ج: a new revision, never an update) -------

  /**
   * Takes `amountRial` (a cancelled part of the loan) off the schedule, from its last
   * untouched installment back (owner, doc 13 open item 3; ب, پ۶, پ۷): a new revision.
   * Locked FOR UPDATE with the payment decisions; keyed; refused whole when more than the
   * untouched installments hold.
   */
  async reduceFromLast(
    actor: Actor,
    input: { scheduleId: string; amountRial: bigint; idempotencyKey: string; reason: string },
    tx?: SqlExecutor,
  ): Promise<{ revisionId: string; replayed: boolean }> {
    const key = checkKey(input.idempotencyKey);
    if (typeof input.amountRial !== 'bigint' || input.amountRial <= 0n) {
      throw bad('amount_must_be_positive');
    }
    if (input.reason.trim().length < 3) throw bad('reason_required');
    const hash = hashOf({ op: 'reduce', ...input });
    return this.inTransaction(tx, async (ex) => {
      const schedule = await this.lockSchedule(ex, input.scheduleId);
      const earlier = await this.revisionByKey(ex, key, hash);
      if (earlier) return { revisionId: earlier, replayed: true };
      const rows = await this.installmentRows(ex, schedule.id);
      let changes;
      try {
        changes = reduceFromLast(
          rows.map((r) => ({
            id: r.id,
            index: r.index,
            dueOn: r.due_on,
            amountRial: BigInt(r.amount_rial),
            paidRial: BigInt(r.paid_rial),
          })),
          input.amountRial,
        );
      } catch (error) {
        if (error instanceof ReductionError) {
          throw conflict(error.code, { reducibleRial: error.reducibleRial.toString() });
        }
        throw error;
      }
      const revisionId = await this.insertRevision(ex, actor, {
        scheduleId: schedule.id,
        reason: input.reason.trim(),
        changeRial: -input.amountRial,
        revertsRevisionId: null,
        key,
        hash,
        amounts: changes.map((c) => ({
          installmentId: c.id,
          fromRial: c.fromRial,
          toRial: c.toRial,
        })),
      });
      await this.publish(
        ex,
        schedule.id,
        schedule.case_id,
        'schedule_revised',
        null,
        input.amountRial,
      );
      return { revisionId, replayed: false };
    });
  }

  async waivePlanFee(
    actor: Actor,
    input: { scheduleId: string; today: string; idempotencyKey: string; reason: string },
    tx?: SqlExecutor,
  ): Promise<{ waivedRial: bigint; revisionId: string | null; journalEntryId: string | null }> {
    const key = checkKey(input.idempotencyKey);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(input.today)) throw bad('invalid_day');
    if (input.reason.trim().length < 3) throw bad('reason_required');
    return this.inTransaction(tx, async (ex) => {
      const schedule = await this.lockSchedule(ex, input.scheduleId);
      // Already waived under this key: the same answer (rule 5).
      const earlier = await ex.execute(sql`
        SELECT id, (-change_rial)::text AS waived FROM installment_schedule_revisions
        WHERE idempotency_key = ${`${key}:schedule`}
      `);
      const done = earlier.rows[0];
      if (done) {
        return {
          waivedRial: BigInt(String(done['waived'])),
          revisionId: done['id'] as string,
          // The document is the ledger's; its id is not kept here (a replay needs none).
          journalEntryId: null,
        };
      }
      const rows = await this.installmentRows(ex, schedule.id);
      const owed = feeToWaive({
        feeRial: BigInt(schedule.plan_fee_rial),
        count: rows.length,
        installments: rows.map((r) => ({
          index: r.index,
          dueOn: r.due_on,
          paidRial: BigInt(r.paid_rial),
        })),
        today: input.today,
      });
      // Never more than the untouched installments hold (none below zero).
      const reducible = rows
        .filter((r) => BigInt(r.paid_rial) === 0n)
        .reduce((sum, r) => sum + BigInt(r.amount_rial), 0n);
      const waived = owed < reducible ? owed : reducible;
      if (waived === 0n) return { waivedRial: 0n, revisionId: null, journalEntryId: null };
      const debt = await this.purseAccount(
        ex,
        schedule.entity_id,
        schedule.purse_id,
        'borrower.debt',
      );
      const income = await this.companyAccount(ex, schedule.entity_id, 'company.fee_income');
      // A new document; the plan fee's own stays as it is (rule 3).
      const journal = await this.ledger.postJournal(
        actor,
        {
          entityId: schedule.entity_id,
          eventType: 'repayment.plan_fee_waived',
          occurredAt: new Date(),
          idempotencyKey: `${key}:journal`,
          caseId: schedule.case_id,
          lines: [
            { accountId: income, direction: 'debit', amountRial: waived },
            { accountId: debt, direction: 'credit', amountRial: waived },
          ],
        },
        ex,
      );
      const { revisionId } = await this.reduceFromLast(
        actor,
        {
          scheduleId: schedule.id,
          amountRial: waived,
          idempotencyKey: `${key}:schedule`,
          reason: input.reason,
        },
        ex,
      );
      return { waivedRial: waived, revisionId, journalEntryId: journal.id };
    });
  }

  async addCharge(
    actor: Actor,
    input: {
      scheduleId: string;
      kind: 'cancellation_penalty';
      amountRial: bigint;
      baseRial: bigint;
      rateBps: number;
      dueOn: string;
      idempotencyKey: string;
      reason: string;
    },
    tx?: SqlExecutor,
  ): Promise<{ chargeId: string; journalEntryId: string; replayed: boolean }> {
    const key = checkKey(input.idempotencyKey);
    if (typeof input.amountRial !== 'bigint' || input.amountRial <= 0n) {
      throw bad('amount_must_be_positive');
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(input.dueOn)) throw bad('invalid_day');
    if (input.reason.trim().length < 3) throw bad('reason_required');
    return this.inTransaction(tx, async (ex) => {
      const schedule = await this.lockSchedule(ex, input.scheduleId);
      const earlier = await ex.execute(sql`
        SELECT id, journal_entry_id, amount_rial::text AS amount FROM repayment_charges
        WHERE idempotency_key = ${key}
      `);
      const found = earlier.rows[0];
      if (found) {
        if (BigInt(String(found['amount'])) !== input.amountRial) {
          throw conflict('idempotency_key_reused');
        }
        return {
          chargeId: found['id'] as string,
          journalEntryId: found['journal_entry_id'] as string,
          replayed: true,
        };
      }
      // The penalty is never posted twice (owner): one per schedule.
      const twice = await ex.execute(sql`
        SELECT 1 FROM repayment_charges WHERE schedule_id = ${schedule.id} AND kind = ${input.kind}
      `);
      if (twice.rows.length > 0) throw conflict('charge_exists');
      const debt = await this.purseAccount(
        ex,
        schedule.entity_id,
        schedule.purse_id,
        'borrower.debt',
      );
      const income = await this.companyAccount(ex, schedule.entity_id, 'company.fee_income');
      const journal = await this.ledger.postJournal(
        actor,
        {
          entityId: schedule.entity_id,
          eventType: 'repayment.cancellation_penalty',
          occurredAt: new Date(),
          idempotencyKey: `${key}:journal`,
          caseId: schedule.case_id,
          lines: [
            { accountId: debt, direction: 'debit', amountRial: input.amountRial },
            { accountId: income, direction: 'credit', amountRial: input.amountRial },
          ],
        },
        ex,
      );
      const made = await ex.execute(sql`
        INSERT INTO repayment_charges (
          schedule_id, purse_id, kind, amount_rial, due_on, rate_bps, base_rial,
          journal_entry_id, idempotency_key, reason, created_by
        ) VALUES (
          ${schedule.id}, ${schedule.purse_id}, ${input.kind}, ${input.amountRial},
          ${input.dueOn}::date, ${input.rateBps}, ${input.baseRial}, ${journal.id}, ${key},
          ${input.reason.trim()}, ${actor.accountId}
        )
        RETURNING id
      `);
      return {
        chargeId: made.rows[0]?.['id'] as string,
        journalEntryId: journal.id,
        replayed: false,
      };
    });
  }

  /**
   * Undoes a revision (a reversed cancellation, task 4-8): a new revision putting back each
   * amount it changed, once, and only while none of them changed since.
   */
  async revertRevision(
    actor: Actor,
    input: { revisionId: string; idempotencyKey: string; reason: string },
    tx?: SqlExecutor,
  ): Promise<{ revisionId: string; replayed: boolean }> {
    const key = checkKey(input.idempotencyKey);
    if (!UUID.test(input.revisionId)) throw new NotFoundException({ error: 'revision_not_found' });
    if (input.reason.trim().length < 3) throw bad('reason_required');
    const hash = hashOf({ op: 'revert', ...input });
    return this.inTransaction(tx, async (ex) => {
      const found = await ex.execute(sql`
        SELECT schedule_id, change_rial::text AS change FROM installment_schedule_revisions
        WHERE id = ${input.revisionId}
      `);
      const target = found.rows[0];
      if (!target) throw new NotFoundException({ error: 'revision_not_found' });
      const schedule = await this.lockSchedule(ex, target['schedule_id'] as string);
      const earlier = await this.revisionByKey(ex, key, hash);
      if (earlier) return { revisionId: earlier, replayed: true };
      const reverted = await ex.execute(sql`
        SELECT id FROM installment_schedule_revisions WHERE reverts_revision_id = ${input.revisionId}
      `);
      if (reverted.rows.length > 0) throw conflict('revision_already_reverted');
      const amounts = await ex.execute(sql`
        SELECT installment_id, from_rial::text AS from_rial, amount_rial::text AS amount_rial
        FROM installment_revision_amounts WHERE revision_id = ${input.revisionId}
      `);
      const now = new Map((await this.installmentRows(ex, schedule.id)).map((r) => [r.id, r]));
      for (const a of amounts.rows) {
        if (now.get(a['installment_id'] as string)?.amount_rial !== a['amount_rial']) {
          throw conflict('revision_superseded');
        }
      }
      const change = -BigInt(target['change'] as string);
      const revisionId = await this.insertRevision(ex, actor, {
        scheduleId: schedule.id,
        reason: input.reason.trim(),
        changeRial: change,
        revertsRevisionId: input.revisionId,
        key,
        hash,
        amounts: amounts.rows.map((a) => ({
          installmentId: a['installment_id'] as string,
          fromRial: BigInt(a['amount_rial'] as string),
          toRial: BigInt(a['from_rial'] as string),
        })),
      });
      await this.publish(
        ex,
        schedule.id,
        schedule.case_id,
        'schedule_revised',
        null,
        change < 0n ? -change : change,
      );
      return { revisionId, replayed: false };
    });
  }

  private async revisionByKey(ex: SqlExecutor, key: string, hash: string): Promise<string | null> {
    const rows = await ex.execute(sql`
      SELECT id, request_hash FROM installment_schedule_revisions WHERE idempotency_key = ${key}
    `);
    const row = rows.rows[0];
    if (!row) return null;
    if (row['request_hash'] !== hash) throw conflict('idempotency_key_reused');
    return row['id'] as string;
  }

  private async insertRevision(
    ex: SqlExecutor,
    actor: Actor,
    r: {
      scheduleId: string;
      reason: string;
      changeRial: bigint;
      revertsRevisionId: string | null;
      key: string;
      hash: string;
      amounts: readonly { installmentId: string; fromRial: bigint; toRial: bigint }[];
    },
  ): Promise<string> {
    const made = await ex.execute(sql`
      INSERT INTO installment_schedule_revisions (
        schedule_id, revision_no, reason, change_rial, reverts_revision_id, idempotency_key,
        request_hash, created_by
      ) VALUES (
        ${r.scheduleId},
        (SELECT coalesce(max(revision_no), 0) + 1 FROM installment_schedule_revisions
          WHERE schedule_id = ${r.scheduleId}),
        ${r.reason}, ${r.changeRial.toString()}::bigint, ${r.revertsRevisionId}, ${r.key},
        ${r.hash}, ${actor.accountId}
      )
      RETURNING id
    `);
    const revisionId = made.rows[0]?.['id'] as string;
    const values: SQL[] = r.amounts.map(
      (a) =>
        sql`(${revisionId}, ${a.installmentId}, ${a.fromRial.toString()}::bigint, ${a.toRial.toString()}::bigint)`,
    );
    await ex.execute(sql`
      INSERT INTO installment_revision_amounts (revision_id, installment_id, from_rial, amount_rial)
      VALUES ${sql.join(values, sql`, `)}
    `);
    return revisionId;
  }

  /** What the schedule's revisions changed its total by (task 4-8). */
  private async revisedBy(ex: SqlExecutor, scheduleId: string): Promise<bigint> {
    const rows = await ex.execute(sql`
      SELECT coalesce(sum(change_rial), 0)::text AS change FROM installment_schedule_revisions
      WHERE schedule_id = ${scheduleId}
    `);
    return BigInt(rows.rows[0]?.['change'] as string);
  }

  // --- helpers ------------------------------------------------------------------------

  private async scheduleRow(ex: SqlExecutor, id: string, forUpdate = false): Promise<ScheduleRow> {
    if (!UUID.test(id)) throw new NotFoundException({ error: 'schedule_not_found' });
    const rows = await ex.execute(sql`
      SELECT id, entity_id, purse_id, case_id, principal_rial::text, plan_fee_rial::text,
             total_rial::text, rounding_unit_rial::text, rounding_config_version_id,
             due_dates_shifted,
             to_char(funded_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS funded_at
      FROM installment_schedules WHERE id = ${id}
      ${forUpdate ? sql`FOR UPDATE` : sql``}
    `);
    const row = rows.rows[0] as ScheduleRow | undefined;
    if (!row) throw new NotFoundException({ error: 'schedule_not_found' });
    return row;
  }

  /** Every payment decision of a case waits for the one before it. */
  private lockSchedule(ex: SqlExecutor, id: string) {
    return this.scheduleRow(ex, id, true);
  }

  private async lockPayment(ex: SqlExecutor, paymentId: string) {
    if (!UUID.test(paymentId)) throw new NotFoundException({ error: 'payment_not_found' });
    const found = await ex.execute(sql`SELECT schedule_id FROM payments WHERE id = ${paymentId}`);
    const scheduleId = found.rows[0]?.['schedule_id'] as string | undefined;
    if (!scheduleId) throw new NotFoundException({ error: 'payment_not_found' });
    const schedule = await this.lockSchedule(ex, scheduleId);
    const rows = await ex.execute(sql`
      SELECT id, schedule_id, amount_rial::text, status, receipt_journal_entry_id,
             suspected_duplicate_of
      FROM payments WHERE id = ${paymentId} FOR UPDATE
    `);
    return { payment: rows.rows[0] as PaymentRow, schedule };
  }

  /** Installments in allocation order: oldest due first. */
  private async installmentRows(ex: SqlExecutor, scheduleId: string): Promise<InstallmentRow[]> {
    const rows = await ex.execute(sql`
      SELECT i.id, i.index, i.due_on::text AS due_on,
             -- Task 4-8 (owner ج): the newest revision's amount, else its own; never updated.
             coalesce((
               SELECT r.amount_rial FROM installment_revision_amounts r
               JOIN installment_schedule_revisions v ON v.id = r.revision_id
               WHERE r.installment_id = i.id
               ORDER BY v.revision_no DESC LIMIT 1
             ), i.amount_rial)::text AS amount_rial,
             coalesce(sum(a.amount_rial), 0)::text AS paid_rial
      FROM installments i
      LEFT JOIN payment_allocations a ON a.installment_id = i.id
      WHERE i.schedule_id = ${scheduleId}
      GROUP BY i.id
      ORDER BY i.due_on, i.index
    `);
    return rows.rows as InstallmentRow[];
  }

  private async decisionOf(
    ex: SqlExecutor,
    payment: PaymentRow,
    replayed: boolean,
  ): Promise<PaymentDecision> {
    const rows = await ex.execute(sql`
      SELECT installment_id, amount_rial::text FROM payment_allocations
      WHERE payment_id = ${payment.id} ORDER BY created_at, id
    `);
    const allocations = rows.rows.map((r) => ({
      installmentId: r['installment_id'] as string,
      amountRial: BigInt(r['amount_rial'] as string),
    }));
    const allocated = allocations.reduce((s, a) => s + a.amountRial, 0n);
    const amount = BigInt(payment.amount_rial);
    return {
      paymentId: payment.id,
      status: payment.status === 'rejected' ? 'rejected' : 'approved',
      allocatedRial: allocated,
      surplusRial: amount - allocated,
      allocations,
      replayed,
    };
  }

  private async purseAccount(
    ex: SqlExecutor,
    entityId: string,
    purseId: string,
    code: 'borrower.debt' | 'suspense.unallocated',
  ): Promise<string> {
    const kind = code === 'borrower.debt' ? 'asset' : 'memo';
    const name = code === 'borrower.debt' ? 'طلب از وام‌گیرنده' : 'پرداخت در انتظار تخصیص';
    return (
      await this.ledger.openAccount(
        { entityId, code, name, kind, ownerType: 'purse', ownerId: purseId },
        ex,
      )
    ).id;
  }

  private async companyAccount(
    ex: SqlExecutor,
    entityId: string,
    code: 'bank.collection' | 'company.fee_income',
  ): Promise<string> {
    const kind = code === 'bank.collection' ? 'asset' : 'income';
    const name = code === 'bank.collection' ? 'حساب دریافت اقساط' : 'درآمد کارمزد';
    return (
      await this.ledger.openAccount(
        { entityId, code, name, kind, ownerType: 'company', ownerId: null },
        ex,
      )
    ).id;
  }

  private publish(
    ex: SqlExecutor,
    scheduleId: string,
    caseId: string,
    kind:
      | 'schedule_created'
      | 'receipt_registered'
      | 'payment_approved'
      | 'payment_rejected'
      | 'schedule_revised',
    paymentId: string | null,
    amount: bigint,
  ) {
    return this.outbox.publish(
      {
        type: 'repayment.recorded',
        aggregateType: 'installment_schedule',
        aggregateId: scheduleId,
        payload: { scheduleId, caseId, kind, paymentId, amountRial: amount.toString() },
      },
      ex,
    );
  }
}

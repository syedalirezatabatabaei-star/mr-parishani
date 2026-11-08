import { FINANCIAL_STEP_UP, type FinancialStepUp } from '../../common/auth/step-up.port';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import {
  allocate,
  buildStatement,
  lastClosedPeriod,
  statementPeriod,
  type PermissionCode,
  type StatementLineType,
  type StatementStatus,
  type StatementView,
} from '@sepehr/contracts';
import { sql } from 'drizzle-orm';
import type { EffectiveAccess } from '../../common/auth/access.port';
import {
  AUDIT_LOG,
  type Actor,
  type AuditLog,
  type SqlExecutor,
} from '../../common/audit/audit.port';
import { OUTBOX, type OutboxPort } from '../../common/events/outbox.port';
import { assertIncomeEntity } from '../../common/ledger/income-entities';
import { LEDGER, type LedgerPort } from '../../common/ledger/ledger.port';
import { DATABASE, type Database } from '../../db/database.module';
import { SettlementService } from './settlement.service';

type Tx = Parameters<Parameters<Database['transaction']>[0]>[0];

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const READ: PermissionCode = 'settlement.read_statements';
const CANCEL: PermissionCode = 'settlement.cancel_statement';
const notFound = () => new NotFoundException({ error: 'statement_not_found' });
const conflict = (error: string, detail?: Record<string, unknown>) =>
  new ConflictException({ error, ...detail });

/** The keys of a statement's documents (rule 5). */
export const statementKey = (statementId: string, step: 'offset' | 'cancel') =>
  `settlement:statement:${statementId}:${step}`;

const pad = (n: number) => String(n).padStart(2, '0');

export interface Generated {
  readonly statementId: string;
  readonly created: boolean;
}

interface Line {
  lineType: StatementLineType;
  refType: 'doctor_payable' | 'service_fee' | 'doctor_node';
  refId: string;
  amountRial: bigint;
}

interface Row {
  id: string;
  doctor_id: string;
  period_year: number;
  period_month: number;
  status: StatementStatus;
  gross_credit_services_rial: string;
  credit_fees_rial: string;
  cash_fees_rial: string;
  carried_in_rial: string;
  other_deductions_rial: string;
  payable_rial: string;
  carried_out_rial: string;
  offset_rial: string;
  generated_at: string;
  cancel_requested_by: string | null;
  cancel_requested_at: string | null;
  reviewed_by: string | null;
  reviewed_at: string | null;
  approved_at: string | null;
}

const iso = (c: string) =>
  `to_char(${c} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS ${c}`;
const COLUMNS = sql.raw(`id, doctor_id, period_year, period_month, status,
  gross_credit_services_rial::text, credit_fees_rial::text, cash_fees_rial::text,
  carried_in_rial::text, other_deductions_rial::text, payable_rial::text,
  carried_out_rial::text, offset_rial::text, ${iso('generated_at')}, cancel_requested_by,
  ${iso('cancel_requested_at')}, reviewed_by, ${iso('reviewed_at')}, ${iso('approved_at')}`);

/** Sums by key, keeping the order keys were first seen in. */
function byNode(entries: readonly { node: string; amount: bigint }[]): Map<string, bigint> {
  const out = new Map<string, bigint>();
  for (const e of entries) out.set(e.node, (out.get(e.node) ?? 0n) + e.amount);
  return out;
}

/**
 * A doctor's monthly statement (task 5-4 [financial]; doc 06 §2, §8; doc 14 ب, پ; doc 02 §4).
 *
 * The draft of a Jalali month is made on the 1st of the next, per doctor, each in its own
 * transaction under an advisory lock of (doctor, month):
 *
 *   1. the doctor's items `due` before the month's end, not in a statement, locked FOR
 *      UPDATE (payables and credit fees, then cash fees); one held by a dispute is on_hold
 *      and never among them;
 *   2. carried in: the previous live statement's carried out, per doctor node;
 *   3. the totals by `buildStatement` (doc 06 §2);
 *   4. the offset, Dr doctor.payable / Cr doctor.fee_receivable, one pair of sides per doctor
 *      node: the payables' side in their order, the fees' side oldest debt first (what was
 *      carried in, then the fees in order); what it leaves of the fees stays in
 *      doctor.fee_receivable and is the node's carried out (key `...:offset`);
 *   5. the statement, its lines, its items `in_statement`; audit and an event.
 *
 * Running it again makes nothing (one live statement per doctor and month). A draft (or a
 * reviewed one) is cancelled by two people: the offset reversed whole (key `...:cancel`) and
 * its items due again, for the month to be made again.
 */
@Injectable()
export class StatementService {
  private readonly logger = new Logger(StatementService.name);

  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(AUDIT_LOG) private readonly audit: AuditLog,
    @Inject(OUTBOX) private readonly outbox: OutboxPort,
    @Inject(LEDGER) private readonly ledger: LedgerPort,
    private readonly settlement: SettlementService,
    @Inject(FINANCIAL_STEP_UP) private readonly stepUp: FinancialStepUp,
  ) {}

  /** The daily job: the month that has just closed, for whoever has none yet. */
  generateDue(actor: Actor, now = new Date()) {
    const { year, month } = lastClosedPeriod(now);
    return this.generateMonth(actor, year, month, now);
  }

  /** Every doctor with something in the month; counts only (rule 30). */
  async generateMonth(
    actor: Actor,
    year: number,
    month: number,
    now = new Date(),
  ): Promise<{ made: number; existing: number; skipped: number; failed: number }> {
    const { end } = statementPeriod(year, month);
    if (end > now) throw new BadRequestException({ error: 'period_not_over' });
    // Whatever fell due before now is due, even if the hourly job has not run yet.
    await this.settlement.markDue(now);
    const doctors = await this.db.execute(sql`
      SELECT doctor_id FROM doctor_payables WHERE status = 'due' AND due_at < ${end}
      UNION
      SELECT doctor_id FROM service_fees WHERE status = 'due' AND due_at < ${end}
      UNION
      SELECT DISTINCT ON (doctor_id) doctor_id FROM (
        SELECT doctor_id, carried_out_rial FROM settlement_statements
        WHERE status <> 'cancelled' AND (period_year, period_month) < (${year}, ${month})
        ORDER BY doctor_id, period_year DESC, period_month DESC
      ) last WHERE carried_out_rial > 0
    `);
    let made = 0;
    let existing = 0;
    let skipped = 0;
    let failed = 0;
    for (const r of doctors.rows) {
      try {
        const done = await this.generateFor(actor, r['doctor_id'] as string, year, month);
        if (!done) skipped += 1;
        else if (done.created) made += 1;
        else existing += 1;
      } catch (error) {
        if (error instanceof ConflictException) {
          skipped += 1;
        } else {
          failed += 1;
          this.logger.error(`statement not made: ${(error as Error).message}`);
        }
      }
    }
    this.logger.log(
      `statements ${String(year)}-${pad(month)}: ${String(made)} made, ${String(existing)} existing, ${String(skipped)} skipped, ${String(failed)} failed`,
    );
    return { made, existing, skipped, failed };
  }

  /** One doctor's statement of one month; null when there is nothing to put in it. */
  async generateFor(
    actor: Actor,
    doctorId: string,
    year: number,
    month: number,
  ): Promise<Generated | null> {
    const { end } = statementPeriod(year, month);
    return this.db.transaction(async (tx) => {
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(hashtext(${`statement:${doctorId}:${String(year)}-${pad(month)}`}))`,
      );
      const live = await tx.execute(sql`
        SELECT id FROM settlement_statements
        WHERE doctor_id = ${doctorId} AND period_year = ${year} AND period_month = ${month}
          AND status <> 'cancelled'
      `);
      const done = live.rows[0]?.['id'] as string | undefined;
      if (done) return { statementId: done, created: false };
      // A month is never made under a later one: what that one carried in would be wrong.
      const later = await tx.execute(sql`
        SELECT 1 FROM settlement_statements
        WHERE doctor_id = ${doctorId} AND status <> 'cancelled'
          AND (period_year, period_month) > (${year}, ${month})
      `);
      if (later.rows.length > 0) throw conflict('later_statement_exists');

      // 1. The items, locked: the payables and credit fees by id, then the cash fees.
      const payables = (
        await tx.execute(sql`
          SELECT id, doctor_node_id, entity_id, amount_rial::text FROM doctor_payables
          WHERE doctor_id = ${doctorId} AND status = 'due' AND due_at < ${end}
          ORDER BY id FOR UPDATE
        `)
      ).rows.map((r) => ({
        id: r['id'] as string,
        node: r['doctor_node_id'] as string,
        entity: r['entity_id'] as string,
        amount: BigInt(r['amount_rial'] as string),
      }));
      const fees = (
        await tx.execute(sql`
          SELECT id, kind, doctor_node_id, entity_id, amount_rial::text FROM service_fees
          WHERE doctor_id = ${doctorId} AND status = 'due' AND due_at < ${end}
          ORDER BY kind = 'cash', id FOR UPDATE
        `)
      ).rows.map((r) => ({
        id: r['id'] as string,
        kind: r['kind'] as 'credit' | 'cash',
        node: r['doctor_node_id'] as string,
        entity: r['entity_id'] as string,
        amount: BigInt(r['amount_rial'] as string),
      }));

      // 2. Carried in: the previous live statement's carried out, per node.
      const previous = (
        await tx.execute(sql`
          SELECT id, entity_id FROM settlement_statements
          WHERE doctor_id = ${doctorId} AND status <> 'cancelled'
            AND (period_year, period_month) < (${year}, ${month})
          ORDER BY period_year DESC, period_month DESC LIMIT 1
        `)
      ).rows[0];
      const carried = previous
        ? (
            await tx.execute(sql`
              SELECT ref_id, amount_rial::text FROM settlement_statement_lines
              WHERE statement_id = ${previous['id'] as string} AND line_type = 'carried_out'
              ORDER BY ref_id
            `)
          ).rows.map((r) => ({
            node: r['ref_id'] as string,
            amount: BigInt(r['amount_rial'] as string),
          }))
        : [];
      if (payables.length === 0 && fees.length === 0 && carried.length === 0) return null;

      const entities = new Set([
        ...payables.map((p) => p.entity),
        ...fees.map((f) => f.entity),
        ...(carried.length > 0 && previous ? [previous['entity_id'] as string] : []),
      ]);
      if (entities.size !== 1) throw new Error('a statement belongs to one entity');
      const [entityId] = [...entities] as [string];
      assertIncomeEntity(entityId);

      // 3. The totals (doc 06 §2).
      const totals = buildStatement({
        payables: payables.map((p) => p.amount),
        creditFees: fees.filter((f) => f.kind === 'credit').map((f) => f.amount),
        cashFees: fees.filter((f) => f.kind === 'cash').map((f) => f.amount),
        carriedIn: carried.reduce((s, c) => s + c.amount, 0n),
        otherDeductions: 0n,
      });

      // 4. The offset per node: services in order; debts oldest first (carried, then fees).
      const grossByNode = byNode(payables.map((p) => ({ node: p.node, amount: p.amount })));
      const debts = [...carried, ...fees.map((f) => ({ node: f.node, amount: f.amount }))];
      const debitTaken = allocate(totals.offsetRial, [...grossByNode.values()]);
      const creditTaken = allocate(
        totals.offsetRial,
        debts.map((d) => d.amount),
      );
      const offsetPayable = new Map(
        [...grossByNode.keys()].map((n, i) => [n, debitTaken[i] ?? 0n]),
      );
      const offsetFee = byNode(
        debts.map((d, i) => ({ node: d.node, amount: creditTaken[i] ?? 0n })),
      );
      const carriedOut = byNode(
        debts.map((d, i) => ({ node: d.node, amount: d.amount - (creditTaken[i] ?? 0n) })),
      );

      const statementId = (await tx.execute(sql`SELECT uuidv7() AS id`)).rows[0]?.['id'] as string;
      let offsetJournal: string | null = null;
      if (totals.offsetRial > 0n) {
        const lines = [];
        for (const [node, amount] of offsetPayable) {
          if (amount === 0n) continue;
          const account = await this.ledger.openAccount(
            {
              entityId,
              code: 'doctor.payable',
              name: 'بدهی به پزشک',
              kind: 'liability',
              ownerType: 'doctor',
              ownerId: node,
            },
            tx,
          );
          lines.push({ accountId: account.id, direction: 'debit' as const, amountRial: amount });
        }
        for (const [node, amount] of offsetFee) {
          if (amount === 0n) continue;
          const account = await this.ledger.openAccount(
            {
              entityId,
              code: 'doctor.fee_receivable',
              name: 'کارمزد قابل دریافت از پزشک',
              kind: 'asset',
              ownerType: 'doctor',
              ownerId: node,
            },
            tx,
          );
          lines.push({ accountId: account.id, direction: 'credit' as const, amountRial: amount });
        }
        offsetJournal = (
          await this.ledger.postJournal(
            actor,
            {
              entityId,
              eventType: 'settlement.statement_offset',
              occurredAt: new Date(),
              idempotencyKey: statementKey(statementId, 'offset'),
              lines,
            },
            tx,
          )
        ).id;
      }

      // 5. The statement, its lines and its items.
      await tx.execute(sql`
        INSERT INTO settlement_statements (
          id, doctor_id, entity_id, period_year, period_month, gross_credit_services_rial,
          credit_fees_rial, cash_fees_rial, carried_in_rial, other_deductions_rial,
          payable_rial, carried_out_rial, offset_rial, offset_journal_entry_id,
          previous_statement_id
        ) VALUES (
          ${statementId}, ${doctorId}, ${entityId}, ${year}, ${month}, ${totals.grossRial},
          ${totals.creditFeesRial}, ${totals.cashFeesRial}, ${totals.carriedInRial},
          ${totals.otherDeductionsRial}, ${totals.payableRial}, ${totals.carriedOutRial},
          ${totals.offsetRial}, ${offsetJournal}, ${(previous?.['id'] as string | undefined) ?? null}
        )
      `);
      const nodeLines = (type: StatementLineType, m: Map<string, bigint>): Line[] =>
        [...m]
          .filter(([, a]) => a > 0n)
          .map(([node, a]) => ({
            lineType: type,
            refType: 'doctor_node',
            refId: node,
            amountRial: a,
          }));
      const lines: Line[] = [
        ...payables.map((p) => ({
          lineType: 'credit_service' as const,
          refType: 'doctor_payable' as const,
          refId: p.id,
          amountRial: p.amount,
        })),
        ...fees.map((f) => ({
          lineType: f.kind === 'credit' ? ('credit_fee' as const) : ('cash_fee' as const),
          refType: 'service_fee' as const,
          refId: f.id,
          amountRial: f.amount,
        })),
        ...nodeLines('carried_in', byNode(carried)),
        ...nodeLines('offset_payable', offsetPayable),
        ...nodeLines('offset_fee', offsetFee),
        ...nodeLines('carried_out', carriedOut),
      ];
      for (const l of lines) {
        await tx.execute(sql`
          INSERT INTO settlement_statement_lines (statement_id, line_type, ref_type, ref_id, amount_rial)
          VALUES (${statementId}, ${l.lineType}, ${l.refType}, ${l.refId}, ${l.amountRial})
        `);
      }
      const payableIds = payables.map((p) => p.id);
      const feeIds = fees.map((f) => f.id);
      if (payableIds.length > 0) {
        await tx.execute(sql`
          UPDATE doctor_payables SET status = 'in_statement', statement_id = ${statementId}
          WHERE id IN (${sql.join(
            payableIds.map((i) => sql`${i}`),
            sql`, `,
          )})
        `);
      }
      if (feeIds.length > 0) {
        await tx.execute(sql`
          UPDATE service_fees SET status = 'in_statement', statement_id = ${statementId}
          WHERE id IN (${sql.join(
            feeIds.map((i) => sql`${i}`),
            sql`, `,
          )})
        `);
      }
      await this.audit.record(
        {
          actor,
          action: 'settlement.statement_generated',
          entityType: 'settlement_statement',
          entityId: statementId,
          after: {
            doctorId,
            period: `${String(year)}-${pad(month)}`,
            grossRial: totals.grossRial.toString(),
            payableRial: totals.payableRial.toString(),
            carriedOutRial: totals.carriedOutRial.toString(),
            offsetRial: totals.offsetRial.toString(),
            items: payableIds.length + feeIds.length,
          },
        },
        tx,
      );
      await this.outbox.publish(
        {
          type: 'settlement.statement_generated',
          aggregateType: 'settlement_statement',
          aggregateId: statementId,
          payload: {
            statementId,
            doctorId,
            periodYear: year,
            periodMonth: month,
            payableRial: totals.payableRial.toString(),
          },
        },
        tx,
      );
      return { statementId, created: true };
    });
  }

  /**
   * A draft (or reviewed) statement cancelled: asked by one, done by another. The offset is
   * reversed whole; its items are due again, for the month to be made again.
   */
  async cancel(
    actor: Actor,
    access: EffectiveAccess,
    id: string,
    reason: string,
  ): Promise<StatementView> {
    this.require(access, CANCEL);
    this.reach(access);
    await this.find(this.db, id);
    await this.db.transaction(async (tx) => {
      const s = (
        await tx.execute(sql`
          SELECT id, doctor_id, period_year, period_month, status, offset_journal_entry_id,
                 cancel_requested_by
          FROM settlement_statements WHERE id = ${id} FOR UPDATE
        `)
      ).rows[0];
      if (!s) throw notFound();
      const status = s['status'] as StatementStatus;
      if (status === 'cancelled') return;
      if (status !== 'draft' && status !== 'reviewed') {
        throw conflict('statement_not_cancellable', { status });
      }
      // ADR-052: each of the two who cancel signs with their own SMS code.
      await this.stepUp.assert(actor, {
        type: 'statement_cancellation',
        id,
        amountRial: null,
        step: s['cancel_requested_by'] ? 'approve' : 'request',
      });
      const later = await tx.execute(sql`
        SELECT 1 FROM settlement_statements
        WHERE doctor_id = ${s['doctor_id'] as string} AND status <> 'cancelled'
          AND (period_year, period_month) > (${s['period_year'] as number}, ${s['period_month'] as number})
      `);
      if (later.rows.length > 0) throw conflict('later_statement_exists');

      const requestedBy = s['cancel_requested_by'] as string | null;
      if (!requestedBy) {
        await tx.execute(sql`
          UPDATE settlement_statements
          SET cancel_requested_by = ${actor.accountId}, cancel_requested_at = now(),
              cancel_reason = ${reason}
          WHERE id = ${id}
        `);
        await this.audit.record(
          {
            actor,
            action: 'settlement.statement_cancel_requested',
            entityType: 'settlement_statement',
            entityId: id,
            reason,
          },
          tx,
        );
        return;
      }
      // Asked again by the same person: nothing more; another person must do it.
      if (requestedBy === actor.accountId) return;

      const offset = s['offset_journal_entry_id'] as string | null;
      const reversal = offset
        ? (
            await this.ledger.reverseJournal(
              actor,
              offset,
              { idempotencyKey: statementKey(id, 'cancel'), reason },
              tx,
            )
          ).id
        : null;
      // The payables, then the fees (the order everywhere): due again, out of the statement.
      await tx.execute(sql`
        SELECT id FROM doctor_payables WHERE statement_id = ${id} ORDER BY id FOR UPDATE
      `);
      await tx.execute(sql`
        SELECT id FROM service_fees WHERE statement_id = ${id} ORDER BY id FOR UPDATE
      `);
      await tx.execute(sql`
        UPDATE doctor_payables SET status = 'due', statement_id = NULL
        WHERE statement_id = ${id} AND status = 'in_statement'
      `);
      await tx.execute(sql`
        UPDATE service_fees SET status = 'due', statement_id = NULL
        WHERE statement_id = ${id} AND status = 'in_statement'
      `);
      await tx.execute(sql`
        UPDATE settlement_statements
        SET status = 'cancelled', cancelled_by = ${actor.accountId}, cancelled_at = now(),
            cancel_journal_entry_id = ${reversal}
        WHERE id = ${id}
      `);
      await this.audit.record(
        {
          actor,
          action: 'settlement.statement_cancelled',
          entityType: 'settlement_statement',
          entityId: id,
          before: { status },
          after: { status: 'cancelled', cancelJournalEntryId: reversal },
          reason,
        },
        tx,
      );
      await this.outbox.publish(
        {
          type: 'settlement.statement_cancelled',
          aggregateType: 'settlement_statement',
          aggregateId: id,
          payload: { statementId: id, doctorId: s['doctor_id'] as string },
        },
        tx,
      );
    });
    return this.view(await this.find(this.db, id), actor.accountId);
  }

  async get(actor: Actor, access: EffectiveAccess, id: string): Promise<StatementView> {
    this.require(access, READ);
    this.reach(access);
    return this.view(await this.find(this.db, id), actor.accountId);
  }

  async list(
    actor: Actor,
    access: EffectiveAccess,
    query: {
      doctorId?: string | undefined;
      year?: number | undefined;
      month?: number | undefined;
      status?: StatementStatus | undefined;
    },
  ): Promise<StatementView[]> {
    this.require(access, READ);
    this.reach(access);
    const rows = await this.db.execute(sql`
      SELECT ${COLUMNS} FROM settlement_statements
      WHERE (${query.doctorId ?? null}::uuid IS NULL OR doctor_id = ${query.doctorId ?? null})
        AND (${query.year ?? null}::int IS NULL OR period_year = ${query.year ?? null})
        AND (${query.month ?? null}::int IS NULL OR period_month = ${query.month ?? null})
        AND (${query.status ?? null}::text IS NULL OR status = ${query.status ?? null})
      ORDER BY period_year DESC, period_month DESC, generated_at DESC LIMIT 500
    `);
    const out: StatementView[] = [];
    for (const r of rows.rows as unknown as Row[]) out.push(await this.view(r, actor.accountId));
    return out;
  }

  /** The view of one statement, for task 5-5's steps (which check access themselves). */
  async viewOf(id: string, viewer: string | null): Promise<StatementView> {
    return this.view(await this.find(this.db, id), viewer);
  }

  // --- helpers -------------------------------------------------------------------------

  private async find(ex: Database | Tx | SqlExecutor, id: string): Promise<Row> {
    if (!UUID.test(id)) throw notFound();
    const row = (
      await ex.execute(sql`SELECT ${COLUMNS} FROM settlement_statements WHERE id = ${id}`)
    ).rows[0] as unknown as Row | undefined;
    if (!row) throw notFound();
    return row;
  }

  private async view(r: Row, viewer: string | null): Promise<StatementView> {
    const lines = await this.db.execute(sql`
      SELECT line_type, ref_type, ref_id, amount_rial::text FROM settlement_statement_lines
      WHERE statement_id = ${r.id} ORDER BY line_type, ref_id
    `);
    return {
      id: r.id,
      doctorId: r.doctor_id,
      periodYear: r.period_year,
      periodMonth: r.period_month,
      status: r.status,
      grossCreditServicesRial: r.gross_credit_services_rial,
      creditFeesRial: r.credit_fees_rial,
      cashFeesRial: r.cash_fees_rial,
      carriedInRial: r.carried_in_rial,
      otherDeductionsRial: r.other_deductions_rial,
      payableRial: r.payable_rial,
      carriedOutRial: r.carried_out_rial,
      offsetRial: r.offset_rial,
      generatedAt: r.generated_at,
      cancelRequestedAt: r.cancel_requested_at,
      cancelRequestedByMe: viewer !== null && r.cancel_requested_by === viewer,
      reviewedAt: r.reviewed_at,
      reviewedByMe: viewer !== null && r.reviewed_by === viewer,
      approvedAt: r.approved_at,
      lines: lines.rows.map((l) => ({
        lineType: l['line_type'] as StatementLineType,
        refType: l['ref_type'] as string,
        refId: l['ref_id'] as string,
        amountRial: l['amount_rial'] as string,
      })),
    };
  }

  /**
   * A doctor's statement spans their workplaces and cities: only staff with a global scope
   * reach it (accounting); a city scope does not (deny by default, rule 11).
   */
  private reach(access: EffectiveAccess) {
    if (!access.scopes.some((s) => s.kind === 'global')) throw notFound();
  }

  private require(access: EffectiveAccess, permission: PermissionCode) {
    if (!access.permissions.has(permission)) {
      throw new ForbiddenException({ error: 'permission_required', permission });
    }
  }
}

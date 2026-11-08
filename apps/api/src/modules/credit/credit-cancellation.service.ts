import { FINANCIAL_STEP_UP, type FinancialStepUp } from '../../common/auth/step-up.port';
import {
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type {
  CreditCancellationStatus,
  CreditCancellationView,
  CreditRefundLine,
  PermissionCode,
} from '@sepehr/contracts';
import { eq, sql } from 'drizzle-orm';
import type { EffectiveAccess } from '../../common/auth/access.port';
import {
  AUDIT_LOG,
  type Actor,
  type AuditLog,
  type SqlExecutor,
} from '../../common/audit/audit.port';
import {
  COMPLETION_REFUNDS,
  type CompletionRefundsPort,
} from '../../common/contract/completion-refunds.port';
import { OUTBOX, type OutboxPort } from '../../common/events/outbox.port';
import { LEAD_CASES, type LeadCases } from '../../common/lead/lead-cases.port';
import {
  PROFORMA_DIRECTORY,
  type ProformaDirectory,
} from '../../common/proforma/proforma-directory.port';
import { WALLET, type WalletPort } from '../../common/wallet/wallet.port';
import { DATABASE, type Database } from '../../db/database.module';
import { creditApplications } from './credit.schema';

type Tx = Parameters<Parameters<Database['transaction']>[0]>[0];
type ApplicationRow = typeof creditApplications.$inferSelect;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const notFound = () => new NotFoundException({ error: 'cancellation_not_found' });
const conflict = (error: string, detail?: Record<string, unknown>) =>
  new ConflictException({ error, ...detail });

const ASK: PermissionCode = 'credit.request_cancellation';
const DECIDE: PermissionCode = 'credit.approve_cancellation';
/** An application past these is not cancelled here: rejected or expired, it is over already. */
const ENDED = ['rejected', 'expired'];
/** Doc 05 §5's base list: the case closes as «انصراف از درمان». */
const CASE_REASON = 'treatment_cancelled';

interface Row {
  id: string;
  credit_application_id: string;
  reason: string;
  status: CreditCancellationStatus;
  requested_by: string;
  requested_at: string;
  decided_at: string | null;
  decision_reason: string | null;
  result: { refunds: CreditRefundLine[] } | null;
}

const iso = (c: string) =>
  `to_char(${c} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS ${c}`;
const COLUMNS = sql.raw(`id, credit_application_id, reason, status, requested_by,
  ${iso('requested_at')}, ${iso('decided_at')}, decision_reason, result`);

/**
 * Cancelling a credit application before funding (task 4-8 [financial], part 3; doc 12 §7;
 * owner 1405/07/14). Asked by case completion or accounting, decided by another person in
 * accounting (a CHECK, and here). Approving it, in one transaction locking the request, then
 * the application (FOR UPDATE: funding holds it FOR SHARE, so one waits for the other):
 *
 * - refuses if the application was funded (a purse exists): that is a cancellation after
 *   funding, a special operation of the purse;
 * - refunds every approved receipt without penalty (COMPLETION_REFUNDS: the fees to
 *   `fee.refund_payable`, the down payment to `downpayment.refund_payable`);
 * - closes the case («انصراف از درمان»).
 *
 * The application row keeps its status; this module reports it `cancelled` to the contract
 * and wallet modules (CREDIT_CONTRACT_FACTS, CREDIT_FUNDING_FACTS), so no contract,
 * completion, receipt approval or funding follows. Paying the refunds out is a later step.
 */
@Injectable()
export class CreditCancellationService {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(AUDIT_LOG) private readonly audit: AuditLog,
    @Inject(OUTBOX) private readonly outbox: OutboxPort,
    @Inject(COMPLETION_REFUNDS) private readonly refunds: CompletionRefundsPort,
    @Inject(LEAD_CASES) private readonly leads: LeadCases,
    @Inject(PROFORMA_DIRECTORY) private readonly proformas: ProformaDirectory,
    @Inject(WALLET) private readonly wallet: WalletPort,
    @Inject(FINANCIAL_STEP_UP) private readonly stepUp: FinancialStepUp,
  ) {}

  async request(
    actor: Actor,
    access: EffectiveAccess,
    input: { creditApplicationId: string; reason: string },
  ): Promise<CreditCancellationView> {
    this.require(access, ASK);
    const app = await this.reachable(access, input.creditApplicationId);
    if (ENDED.includes(app.status)) throw conflict('application_ended', { status: app.status });
    if (await this.cancelled(this.db, app.id)) throw conflict('already_cancelled');
    if (await this.wallet.purseOfApplication(app.id)) throw conflict('already_funded');
    // ADR-052: the asker's own SMS code for cancelling this application.
    await this.stepUp.assert(actor, {
      type: 'credit_cancellation',
      id: app.id,
      amountRial: null,
      step: 'request',
    });
    const row = await this.db
      .transaction(async (tx) => {
        const made = await tx.execute(sql`
          INSERT INTO credit_application_cancellations (credit_application_id, reason, requested_by)
          VALUES (${app.id}, ${input.reason}, ${actor.accountId})
          RETURNING ${COLUMNS}
        `);
        const created = made.rows[0] as unknown as Row;
        await this.audit.record(
          {
            actor,
            action: 'credit.cancellation_requested',
            entityType: 'credit_application',
            entityId: app.id,
            after: { cancellationId: created.id },
            reason: input.reason,
          },
          tx,
        );
        await this.publish(tx, 'credit.cancellation_requested', app, created.id);
        return created;
      })
      .catch((error: unknown) => {
        if (isUniqueViolation(error)) throw conflict('request_open');
        throw error;
      });
    return view(row, actor.accountId);
  }

  async list(
    actor: Actor,
    access: EffectiveAccess,
    query: {
      creditApplicationId?: string | undefined;
      status?: CreditCancellationStatus | undefined;
    },
  ): Promise<CreditCancellationView[]> {
    if (!access.permissions.has(ASK) && !access.permissions.has(DECIDE)) {
      throw new ForbiddenException({ error: 'permission_required' });
    }
    const rows = await this.db.execute(sql`
      SELECT ${COLUMNS} FROM credit_application_cancellations
      WHERE (${query.creditApplicationId ?? null}::uuid IS NULL
             OR credit_application_id = ${query.creditApplicationId ?? null})
        AND (${query.status ?? null}::text IS NULL OR status = ${query.status ?? null})
      ORDER BY requested_at DESC LIMIT 500
    `);
    const out: CreditCancellationView[] = [];
    for (const r of rows.rows as unknown as Row[]) {
      const ok = await this.reachable(access, r.credit_application_id).then(
        () => true,
        () => false,
      );
      if (ok) out.push(view(r, actor.accountId));
    }
    return out;
  }

  async approve(
    actor: Actor,
    access: EffectiveAccess,
    id: string,
    reason: string,
  ): Promise<CreditCancellationView> {
    this.require(access, DECIDE);
    const reached = await this.find(this.db, id);
    await this.reachable(access, reached.credit_application_id);
    // ADR-052: the approver's own SMS code for this cancellation.
    await this.stepUp.assert(actor, {
      type: 'credit_cancellation',
      id,
      amountRial: null,
      step: 'approve',
    });
    const row = await this.db.transaction(async (tx) => {
      const request = await this.lock(tx, id);
      // Approving twice changes nothing (rule 5).
      if (request.status === 'approved') return request;
      if (request.status !== 'requested') throw conflict('request_decided');
      // Doc 12 §7: two people for anything that moves money.
      if (request.requested_by === actor.accountId) throw conflict('same_person');
      const [app] = await tx
        .select()
        .from(creditApplications)
        .where(eq(creditApplications.id, request.credit_application_id))
        .for('update');
      if (!app) throw new NotFoundException({ error: 'credit_application_not_found' });
      if (ENDED.includes(app.status)) throw conflict('application_ended', { status: app.status });
      // Funded meanwhile: the purse is there; that is a cancellation after funding.
      if (await this.wallet.purseOfApplication(app.id, tx)) throw conflict('already_funded');
      const refunds = await this.refunds.refundAll(actor, app.id, id, tx);
      await this.leads.closeCase(tx, actor, app.caseId, CASE_REASON, null);
      const done = await tx.execute(sql`
        UPDATE credit_application_cancellations
        SET status = 'approved', decided_by = ${actor.accountId}, decided_at = now(),
            decision_reason = ${reason}, result = ${JSON.stringify({ refunds })}::jsonb
        WHERE id = ${id}
        RETURNING ${COLUMNS}
      `);
      const approved = done.rows[0] as unknown as Row;
      await this.audit.record(
        {
          actor,
          action: 'credit.application_cancelled',
          entityType: 'credit_application',
          entityId: app.id,
          before: { cancelled: false },
          after: { cancelled: true, cancellationId: id, refunds },
          reason,
        },
        tx,
      );
      await this.publish(tx, 'credit.application_cancelled', app, id);
      return approved;
    });
    return view(row, actor.accountId);
  }

  async reject(
    actor: Actor,
    access: EffectiveAccess,
    id: string,
    reason: string,
  ): Promise<CreditCancellationView> {
    this.require(access, DECIDE);
    const reached = await this.find(this.db, id);
    const app = await this.reachable(access, reached.credit_application_id);
    const row = await this.db.transaction(async (tx) => {
      const request = await this.lock(tx, id);
      if (request.status !== 'requested') throw conflict('request_decided');
      if (request.requested_by === actor.accountId) throw conflict('same_person');
      const done = await tx.execute(sql`
        UPDATE credit_application_cancellations
        SET status = 'rejected', decided_by = ${actor.accountId}, decided_at = now(),
            decision_reason = ${reason}
        WHERE id = ${id}
        RETURNING ${COLUMNS}
      `);
      const rejected = done.rows[0] as unknown as Row;
      await this.audit.record(
        {
          actor,
          action: 'credit.cancellation_rejected',
          entityType: 'credit_application',
          entityId: app.id,
          before: { status: 'requested' },
          after: { status: 'rejected', cancellationId: id },
          reason,
        },
        tx,
      );
      await this.publish(tx, 'credit.cancellation_rejected', app, id);
      return rejected;
    });
    return view(row, actor.accountId);
  }

  /** Whether the application was cancelled (the facts adapters report it `cancelled`). */
  async cancelled(ex: SqlExecutor, creditApplicationId: string): Promise<boolean> {
    const found = await ex.execute(sql`
      SELECT 1 FROM credit_application_cancellations
      WHERE credit_application_id = ${creditApplicationId} AND status = 'approved'
    `);
    return found.rows.length > 0;
  }

  // --- helpers -------------------------------------------------------------------------

  private async find(ex: SqlExecutor, id: string): Promise<Row> {
    if (!UUID.test(id)) throw notFound();
    const rows = await ex.execute(
      sql`SELECT ${COLUMNS} FROM credit_application_cancellations WHERE id = ${id}`,
    );
    const row = rows.rows[0] as unknown as Row | undefined;
    if (!row) throw notFound();
    return row;
  }

  private async lock(tx: Tx, id: string): Promise<Row> {
    const rows = await tx.execute(
      sql`SELECT ${COLUMNS} FROM credit_application_cancellations WHERE id = ${id} FOR UPDATE`,
    );
    const row = rows.rows[0] as unknown as Row | undefined;
    if (!row) throw notFound();
    return row;
  }

  /** Staff reach an application of their city (its proforma's), or any with a global scope. */
  private async reachable(access: EffectiveAccess, creditApplicationId: string) {
    const missing = () => new NotFoundException({ error: 'credit_application_not_found' });
    if (!UUID.test(creditApplicationId)) throw missing();
    const [app] = await this.db
      .select()
      .from(creditApplications)
      .where(eq(creditApplications.id, creditApplicationId));
    if (!app || app.deletedAt) throw missing();
    if (access.scopes.some((s) => s.kind === 'global')) return app;
    const proforma = await this.proformas.proforma(app.proformaId);
    const cities = access.scopes.flatMap((s) => (s.kind === 'city' ? [s.code] : []));
    if (!proforma || !cities.includes(proforma.cityCode)) throw missing();
    return app;
  }

  private async publish(tx: Tx, type: string, app: ApplicationRow, cancellationId: string) {
    await this.outbox.publish(
      {
        type,
        aggregateType: 'credit_application',
        aggregateId: app.id,
        payload: {
          creditApplicationId: app.id,
          caseId: app.caseId,
          proformaId: app.proformaId,
          cancellationId,
        },
      },
      tx,
    );
  }

  private require(access: EffectiveAccess, permission: PermissionCode) {
    if (!access.permissions.has(permission)) {
      throw new ForbiddenException({ error: 'permission_required', permission });
    }
  }
}

function view(r: Row, viewer: string | null): CreditCancellationView {
  return {
    id: r.id,
    creditApplicationId: r.credit_application_id,
    status: r.status,
    reason: r.reason,
    requestedAt: r.requested_at,
    requestedByMe: viewer !== null && r.requested_by === viewer,
    decidedAt: r.decided_at,
    decisionReason: r.decision_reason,
    refunds: r.result?.refunds ?? null,
  };
}

function isUniqueViolation(error: unknown): boolean {
  const e = error as { code?: string; cause?: { code?: string } };
  return e.code === '23505' || e.cause?.code === '23505';
}

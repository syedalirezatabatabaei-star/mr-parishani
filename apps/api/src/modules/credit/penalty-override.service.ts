import { FINANCIAL_STEP_UP, type FinancialStepUp } from '../../common/auth/step-up.port';
import {
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { PenaltyOverrideStatus, PenaltyOverrideView, PermissionCode } from '@sepehr/contracts';
import { eq, sql } from 'drizzle-orm';
import type { EffectiveAccess } from '../../common/auth/access.port';
import { AUDIT_LOG, type Actor, type AuditLog } from '../../common/audit/audit.port';
import { CONTRACT_TERMS, type ContractTermsPort } from '../../common/contract/contract-terms.port';
import { OUTBOX, type OutboxPort } from '../../common/events/outbox.port';
import {
  PROFORMA_DIRECTORY,
  type ProformaDirectory,
} from '../../common/proforma/proforma-directory.port';
import { DATABASE, type Database } from '../../db/database.module';
import { creditApplications } from './credit.schema';

type Tx = Parameters<Parameters<Database['transaction']>[0]>[0];

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const notFound = () => new NotFoundException({ error: 'penalty_override_not_found' });
const conflict = (error: string, detail?: Record<string, unknown>) =>
  new ConflictException({ error, ...detail });

const ASK: PermissionCode = 'credit.request_penalty_override';
const DECIDE: PermissionCode = 'credit.approve_penalty_override';
/** Owner پ۱۳: 0 to 18%; higher only with a new ADR (and a new migration's CHECK). */
const MAX_BPS = 1_800;

interface Row {
  id: string;
  credit_application_id: string;
  penalty_bps: number;
  reason: string;
  status: PenaltyOverrideStatus;
  requested_by: string;
  requested_at: string;
  decided_at: string | null;
  decision_reason: string | null;
}

const iso = (c: string) =>
  `to_char(${c} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS ${c}`;
const COLUMNS = sql.raw(`id, credit_application_id, penalty_bps, reason, status, requested_by,
  ${iso('requested_at')}, ${iso('decided_at')}, decision_reason`);

/**
 * A case's own cancellation-penalty rate (task 4-8 [financial], part 7; doc 02 §6 item 4;
 * owner پ۱۳, س۴): asked by one person, approved by another, each with a reason, audited;
 * 0 to 18%. It counts only for a contract made after it, which locks it; once the case has a
 * live contract, no override is asked (409 `contract_exists`).
 */
@Injectable()
export class PenaltyOverrideService {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(AUDIT_LOG) private readonly audit: AuditLog,
    @Inject(OUTBOX) private readonly outbox: OutboxPort,
    @Inject(CONTRACT_TERMS) private readonly terms: ContractTermsPort,
    @Inject(PROFORMA_DIRECTORY) private readonly proformas: ProformaDirectory,
    @Inject(FINANCIAL_STEP_UP) private readonly stepUp: FinancialStepUp,
  ) {}

  async request(
    actor: Actor,
    access: EffectiveAccess,
    creditApplicationId: string,
    input: { penaltyBps: number; reason: string },
  ): Promise<PenaltyOverrideView> {
    this.require(access, ASK);
    const app = await this.reachable(access, creditApplicationId);
    if (!Number.isInteger(input.penaltyBps) || input.penaltyBps < 0 || input.penaltyBps > MAX_BPS) {
      throw conflict('penalty_out_of_range', { maxBps: MAX_BPS });
    }
    if (await this.terms.penaltyOf(app.id)) throw conflict('contract_exists');
    // ADR-052: the asker's own SMS code for this case's penalty rate.
    await this.stepUp.assert(actor, {
      type: 'penalty_override',
      id: app.id,
      amountRial: null,
      step: 'request',
    });
    const row = await this.db
      .transaction(async (tx) => {
        const made = await tx.execute(sql`
          INSERT INTO credit_penalty_overrides (credit_application_id, penalty_bps, reason, requested_by)
          VALUES (${app.id}, ${input.penaltyBps}, ${input.reason}, ${actor.accountId})
          RETURNING ${COLUMNS}
        `);
        const created = made.rows[0] as unknown as Row;
        await this.audit.record(
          {
            actor,
            action: 'credit.penalty_override_requested',
            entityType: 'credit_application',
            entityId: app.id,
            after: { overrideId: created.id, penaltyBps: input.penaltyBps },
            reason: input.reason,
          },
          tx,
        );
        await this.publish(tx, 'credit.penalty_override_requested', app, created.id);
        return created;
      })
      .catch((error: unknown) => {
        const e = error as { code?: string; cause?: { code?: string } };
        if (e.code === '23505' || e.cause?.code === '23505') throw conflict('request_open');
        throw error;
      });
    return view(row, actor.accountId);
  }

  async list(
    actor: Actor,
    access: EffectiveAccess,
    creditApplicationId: string,
  ): Promise<PenaltyOverrideView[]> {
    if (!access.permissions.has(ASK) && !access.permissions.has(DECIDE)) {
      throw new ForbiddenException({ error: 'permission_required' });
    }
    const app = await this.reachable(access, creditApplicationId);
    const rows = await this.db.execute(sql`
      SELECT ${COLUMNS} FROM credit_penalty_overrides
      WHERE credit_application_id = ${app.id} ORDER BY requested_at DESC
    `);
    return (rows.rows as unknown as Row[]).map((r) => view(r, actor.accountId));
  }

  /**
   * The requests waiting for a second person (ADR-044): what the approver, who may not open
   * the credit file, decides from. Only the cases this access reaches, newest first.
   */
  async pending(actor: Actor, access: EffectiveAccess): Promise<PenaltyOverrideView[]> {
    if (!access.permissions.has(ASK) && !access.permissions.has(DECIDE)) {
      throw new ForbiddenException({ error: 'permission_required' });
    }
    const rows = await this.db.execute(sql`
      SELECT ${COLUMNS} FROM credit_penalty_overrides
      WHERE status = 'requested' ORDER BY requested_at DESC LIMIT 200
    `);
    const reached: Row[] = [];
    for (const r of rows.rows as unknown as Row[]) {
      try {
        await this.reachable(access, r.credit_application_id);
        reached.push(r);
      } catch (error) {
        if (!(error instanceof NotFoundException)) throw error;
      }
    }
    return reached.map((r) => view(r, actor.accountId));
  }

  async decide(
    actor: Actor,
    access: EffectiveAccess,
    id: string,
    approve: boolean,
    reason: string,
  ): Promise<PenaltyOverrideView> {
    this.require(access, DECIDE);
    if (!UUID.test(id)) throw notFound();
    const found = await this.db.execute(
      sql`SELECT ${COLUMNS} FROM credit_penalty_overrides WHERE id = ${id}`,
    );
    const reached = found.rows[0] as unknown as Row | undefined;
    if (!reached) throw notFound();
    const app = await this.reachable(access, reached.credit_application_id);
    // A contract made meanwhile has its rate locked: the override would count for nothing.
    if (approve && (await this.terms.penaltyOf(app.id))) throw conflict('contract_exists');
    // ADR-052: approving the rate is signed with the approver's own SMS code.
    if (approve) {
      await this.stepUp.assert(actor, {
        type: 'penalty_override',
        id,
        amountRial: null,
        step: 'approve',
      });
    }
    const row = await this.db.transaction(async (tx) => {
      const locked = (
        await tx.execute(
          sql`SELECT ${COLUMNS} FROM credit_penalty_overrides WHERE id = ${id} FOR UPDATE`,
        )
      ).rows[0] as unknown as Row;
      if (locked.status === 'approved' && approve) return locked;
      if (locked.status !== 'requested') throw conflict('request_decided');
      // Owner پ۱۳: two people.
      if (locked.requested_by === actor.accountId) throw conflict('same_person');
      const done = await tx.execute(sql`
        UPDATE credit_penalty_overrides
        SET status = ${approve ? 'approved' : 'rejected'}, decided_by = ${actor.accountId},
            decided_at = now(), decision_reason = ${reason}
        WHERE id = ${id}
        RETURNING ${COLUMNS}
      `);
      const decided = done.rows[0] as unknown as Row;
      await this.audit.record(
        {
          actor,
          action: approve ? 'credit.penalty_override_approved' : 'credit.penalty_override_rejected',
          entityType: 'credit_application',
          entityId: app.id,
          before: { status: 'requested' },
          after: { overrideId: id, status: decided.status, penaltyBps: decided.penalty_bps },
          reason,
        },
        tx,
      );
      await this.outbox.publish(
        {
          type: 'credit.penalty_override_decided',
          aggregateType: 'credit_application',
          aggregateId: app.id,
          payload: {
            creditApplicationId: app.id,
            caseId: app.caseId,
            proformaId: app.proformaId,
            overrideId: id,
            approved: approve,
          },
        },
        tx,
      );
      return decided;
    });
    return view(row, actor.accountId);
  }

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

  private async publish(
    tx: Tx,
    type: string,
    app: typeof creditApplications.$inferSelect,
    overrideId: string,
  ) {
    await this.outbox.publish(
      {
        type,
        aggregateType: 'credit_application',
        aggregateId: app.id,
        payload: {
          creditApplicationId: app.id,
          caseId: app.caseId,
          proformaId: app.proformaId,
          overrideId,
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

function view(r: Row, viewer: string | null): PenaltyOverrideView {
  return {
    id: r.id,
    creditApplicationId: r.credit_application_id,
    penaltyBps: r.penalty_bps,
    reason: r.reason,
    status: r.status,
    requestedAt: r.requested_at,
    requestedByMe: viewer !== null && r.requested_by === viewer,
    decidedAt: r.decided_at,
    decisionReason: r.decision_reason,
  };
}

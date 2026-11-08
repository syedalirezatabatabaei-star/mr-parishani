import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  CASE_FUNNEL_TARGETS,
  CASE_STATUSES,
  CLOSED_CASE_STATUSES,
  SETTLEABLE_CASE_STATUSES,
  type CaseStatus,
} from '@sepehr/contracts';
import { and, asc, desc, eq, isNull, notInArray, or, type SQL } from 'drizzle-orm';
import type { EffectiveAccess } from '../../common/auth/access.port';
import { ACCOUNT_DIRECTORY, type AccountDirectory } from '../../common/auth/account-directory.port';
import { AUDIT_LOG, type Actor, type AuditLog } from '../../common/audit/audit.port';
import { DATABASE, type Database } from '../../db/database.module';
import { AssignmentService } from './assignment.service';
import {
  abandonmentReasons,
  caseAssignments,
  caseCompletionAlerts,
  caseIntakes,
  cases,
  caseStatusChanges,
} from './lead.schema';
import { requirePermission, UUID, type Tx } from './lead.shared';
import { PersonService, type PersonView } from './person.service';

type CaseRow = typeof cases.$inferSelect;

export interface CaseView {
  readonly id: string;
  readonly personId: string;
  readonly status: CaseStatus;
  readonly queueCode: string;
  readonly treatmentFieldCode: string;
  readonly cityCode: string | null;
  readonly channel: CaseRow['channel'];
  readonly isReturning: boolean;
  readonly assigneeAccountId: string | null;
  readonly abandonmentReasonCode: string | null;
  readonly createdAt: string;
  readonly closedAt: string | null;
}

/** A settled case left to staff (owner 1405/07/15): when its last loan was paid. */
export interface CompletionAlertView extends CaseView {
  readonly settledAt: string;
}

export interface CaseDetail extends CaseView {
  readonly person: PersonView;
  readonly intakes: { id: string; category: string; channel: string; at: string }[];
  readonly assignments: {
    accountId: string | null;
    kind: string;
    reason: string | null;
    at: string;
  }[];
  readonly statusChanges: {
    from: string | null;
    to: string;
    reasonCode: string | null;
    at: string;
  }[];
  /**
   * For a returning case (doc 05 §4): how far the previous one went, why it ended, when,
   * and with which advisor.
   */
  readonly previous: {
    caseId: string;
    status: CaseStatus;
    abandonmentReasonCode: string | null;
    closedAt: string | null;
    advisorAccountId: string | null;
  } | null;
}

const view = (c: CaseRow): CaseView => ({
  id: c.id,
  personId: c.personId,
  status: c.status,
  queueCode: c.queueCode,
  treatmentFieldCode: c.treatmentFieldCode,
  cityCode: c.cityCode,
  channel: c.channel,
  isReturning: c.isReturning,
  assigneeAccountId: c.assigneeAccountId,
  abandonmentReasonCode: c.abandonmentReasonCode,
  createdAt: c.createdAt.toISOString(),
  closedAt: c.closedAt?.toISOString() ?? null,
});

/**
 * Cases as people work them (doc 05). Seen by scope: an advisor's own (`own`: the cases
 * assigned to them), a team queue, a city, or everything; anything else does not exist
 * (404, rule 13). Staff take the first step (`new` → `advising`) and close (`cancelled`, with
 * a reason from the list); the funnel consumer takes the steps to `proforma_issued` on other
 * modules' events (owner 1405/07/23); later steps belong to the modules that own them, all
 * through the same status machine (rule 8, and a trigger).
 */
/**
 * A funnel event that came before the one it follows (an examination before the appointment's
 * confirmation reached the case): thrown so the event is delivered again, never skipping a step.
 */
export class FunnelEventEarly extends Error {
  constructor(caseId: string, status: CaseStatus, target: CaseStatus) {
    super(`case ${caseId} at ${status}: ${target} waits for the stage before it`);
    this.name = 'FunnelEventEarly';
  }
}

@Injectable()
export class CaseService {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(AUDIT_LOG) private readonly audit: AuditLog,
    @Inject(ACCOUNT_DIRECTORY) private readonly accounts: AccountDirectory,
    private readonly persons: PersonService,
    private readonly assignment: AssignmentService,
  ) {}

  async list(actor: Actor, access: EffectiveAccess, openOnly: boolean): Promise<CaseView[]> {
    requirePermission(access, 'lead.read_cases');
    const scope = this.scopeFilter(actor, access);
    if (scope === null) return [];
    const rows = await this.db
      .select()
      .from(cases)
      .where(
        and(
          isNull(cases.deletedAt),
          ...(scope === true ? [] : [scope]),
          ...(openOnly ? [notInArray(cases.status, [...CLOSED_CASE_STATUSES])] : []),
        ),
      )
      .orderBy(desc(cases.createdAt))
      .limit(500);
    return rows.map(view);
  }

  async get(actor: Actor, access: EffectiveAccess, caseId: string): Promise<CaseDetail> {
    requirePermission(access, 'lead.read_cases');
    const kase = await this.visible(this.db, actor, access, caseId);
    const person = await this.persons.canonical(this.db, kase.personId);
    const [intakes, assignments, changes] = await Promise.all([
      this.db
        .select()
        .from(caseIntakes)
        .where(eq(caseIntakes.caseId, kase.id))
        .orderBy(asc(caseIntakes.createdAt)),
      this.db
        .select()
        .from(caseAssignments)
        .where(eq(caseAssignments.caseId, kase.id))
        .orderBy(asc(caseAssignments.createdAt), asc(caseAssignments.id)),
      this.db
        .select()
        .from(caseStatusChanges)
        .where(eq(caseStatusChanges.caseId, kase.id))
        .orderBy(asc(caseStatusChanges.createdAt), asc(caseStatusChanges.id)),
    ]);
    let previous: CaseDetail['previous'] = null;
    if (kase.previousCaseId) {
      const [prev] = await this.db.select().from(cases).where(eq(cases.id, kase.previousCaseId));
      const [lastAdvisor] = await this.db
        .select({ accountId: caseAssignments.accountId })
        .from(caseAssignments)
        .where(eq(caseAssignments.caseId, kase.previousCaseId))
        .orderBy(desc(caseAssignments.createdAt), desc(caseAssignments.id))
        .limit(1);
      if (prev) {
        previous = {
          caseId: prev.id,
          status: prev.status,
          abandonmentReasonCode: prev.abandonmentReasonCode,
          closedAt: prev.closedAt?.toISOString() ?? null,
          advisorAccountId: lastAdvisor?.accountId ?? null,
        };
      }
    }
    return {
      ...view(kase),
      person: await this.persons.view(this.db, person),
      intakes: intakes.map((i) => ({
        id: i.id,
        category: i.category,
        channel: i.channel,
        at: i.createdAt.toISOString(),
      })),
      assignments: assignments.map((a) => ({
        accountId: a.accountId,
        kind: a.kind,
        reason: a.reason,
        at: a.createdAt.toISOString(),
      })),
      statusChanges: changes.map((c) => ({
        from: c.fromStatus,
        to: c.toStatus,
        reasonCode: c.reasonCode,
        at: c.createdAt.toISOString(),
      })),
      previous,
    };
  }

  /** The advisor takes the case up: `new` → `advising`. */
  async startAdvising(actor: Actor, access: EffectiveAccess, caseId: string): Promise<CaseView> {
    requirePermission(access, 'lead.update_cases');
    return this.db.transaction(async (tx) => {
      const kase = await this.visible(tx, actor, access, caseId, true);
      if (kase.status !== 'new') throw new ConflictException({ error: 'case_not_new' });
      return this.move(tx, actor, kase, 'advising', {});
    });
  }

  /**
   * Settled cases left to staff (owner 1405/07/15): their loans are all paid, but they stood
   * where they may not be completed from. Open ones the caller's scope covers.
   */
  async completionAlerts(actor: Actor, access: EffectiveAccess): Promise<CompletionAlertView[]> {
    requirePermission(access, 'lead.read_cases');
    const scope = this.scopeFilter(actor, access);
    if (scope === null) return [];
    const rows = await this.db
      .select({ kase: cases, alertAt: caseCompletionAlerts.createdAt })
      .from(caseCompletionAlerts)
      .innerJoin(cases, eq(cases.id, caseCompletionAlerts.caseId))
      .where(
        and(
          isNull(cases.deletedAt),
          notInArray(cases.status, [...CLOSED_CASE_STATUSES]),
          ...(scope === true ? [] : [scope]),
        ),
      )
      .orderBy(asc(caseCompletionAlerts.createdAt))
      .limit(500);
    return rows.map((r) => ({ ...view(r.kase), settledAt: r.alertAt.toISOString() }));
  }

  /**
   * Staff complete a settled case (owner 1405/07/15) once it stands where the chain allows
   * it (a settleable stage, advising to proforma_issued, owner 1405/07/23; or in_treatment).
   * Only a case with an alert.
   */
  async completeSettled(actor: Actor, access: EffectiveAccess, caseId: string): Promise<CaseView> {
    requirePermission(access, 'lead.update_cases');
    return this.db.transaction(async (tx) => {
      const kase = await this.visible(tx, actor, access, caseId, true);
      if (CLOSED_CASE_STATUSES.includes(kase.status)) {
        throw new ConflictException({ error: 'case_closed' });
      }
      const [alert] = await tx
        .select({ id: caseCompletionAlerts.id })
        .from(caseCompletionAlerts)
        .where(eq(caseCompletionAlerts.caseId, kase.id));
      if (!alert) throw new ConflictException({ error: 'case_not_settled' });
      if (!SETTLEABLE_CASE_STATUSES.includes(kase.status) && kase.status !== 'in_treatment') {
        throw new ConflictException({ error: 'case_not_ready', status: kase.status });
      }
      return this.move(
        tx,
        actor,
        kase,
        'completed',
        { closedAt: new Date() },
        null,
        'loan_settled',
      );
    });
  }

  /**
   * The case funnel (owner 1405/07/23, question 8): the stage an event brings a case to,
   * reached one step at a time through move (rule 8; the database still takes one step at a
   * time), each step recorded with `funnel_event` and the event's id and audited as `actor`.
   * From `new`, `advising` (which has no event) is passed on the way to `appointment_booked`;
   * any other stage only from the one just before it. A case at the stage or past it, or
   * closed, is left as it is: a repeated or late event, never backwards. A case further back
   * means the event came before the one it follows: FunnelEventEarly, so the queue tries it
   * again later, and no step is skipped.
   */
  async advanceFunnel(
    tx: Tx,
    actor: Actor,
    input: { caseId: string; eventType: keyof typeof CASE_FUNNEL_TARGETS; eventId: string },
  ): Promise<CaseStatus[]> {
    if (!UUID.test(input.caseId)) return [];
    const [kase] = await tx.select().from(cases).where(eq(cases.id, input.caseId)).for('update');
    if (!kase || kase.deletedAt !== null || CLOSED_CASE_STATUSES.includes(kase.status)) return [];
    const target = CASE_FUNNEL_TARGETS[input.eventType];
    const at = CASE_STATUSES.indexOf(kase.status);
    const to = CASE_STATUSES.indexOf(target);
    if (at >= to) return [];
    // The stage the case must have reached: new for appointment_booked, else the one before.
    const from = target === 'appointment_booked' ? 0 : to - 1;
    if (at < from) {
      throw new FunnelEventEarly(kase.id, kase.status, target);
    }
    const passed: CaseStatus[] = [];
    let row = kase;
    for (const next of CASE_STATUSES.slice(at + 1, to + 1)) {
      await this.move(tx, actor, row, next, {}, 'funnel_event', input.eventId);
      row = { ...row, status: next };
      passed.push(next);
    }
    return passed;
  }

  /** Closes a case with a reason from the list (doc 05 §5: required). */
  async cancel(
    actor: Actor,
    access: EffectiveAccess,
    caseId: string,
    input: { reasonCode: string; note?: string | undefined },
  ): Promise<CaseView> {
    requirePermission(access, 'lead.update_cases');
    return this.db.transaction(async (tx) => {
      const kase = await this.visible(tx, actor, access, caseId, true);
      if (CLOSED_CASE_STATUSES.includes(kase.status)) {
        throw new ConflictException({ error: 'case_closed' });
      }
      const [reason] = await tx
        .select()
        .from(abandonmentReasons)
        .where(
          and(eq(abandonmentReasons.code, input.reasonCode), isNull(abandonmentReasons.deletedAt)),
        );
      if (!reason) throw new BadRequestException({ error: 'unknown_abandonment_reason' });
      return this.move(
        tx,
        actor,
        kase,
        'cancelled',
        {
          abandonmentReasonCode: reason.code,
          abandonmentNote: input.note ?? null,
          closedAt: new Date(),
        },
        reason.code,
        input.note ?? null,
      );
    });
  }

  /** The person asked for no more SMS; recorded from any of their cases one can see. */
  async optOutOfSms(actor: Actor, access: EffectiveAccess, caseId: string, reason: string) {
    requirePermission(access, 'lead.update_cases');
    return this.db.transaction(async (tx) => {
      const kase = await this.visible(tx, actor, access, caseId);
      const person = await this.persons.lockPerson(
        tx,
        (await this.persons.canonical(tx, kase.personId)).id,
      );
      const row = await this.persons.optOutOfSms(tx, actor, person, reason);
      return this.persons.view(tx, row);
    });
  }

  /** Gives a case to someone by hand, with a required reason (doc 05 §6). */
  async assignManually(
    actor: Actor,
    access: EffectiveAccess,
    caseId: string,
    input: { accountId: string; reason: string },
  ): Promise<CaseView> {
    requirePermission(access, 'lead.assign_manually');
    const target = await this.accounts.find(input.accountId);
    if (target?.kind !== 'staff' || target.status !== 'active') {
      throw new BadRequestException({ error: 'not_an_active_staff_account' });
    }
    return this.db.transaction(async (tx) => {
      const kase = await this.visible(tx, actor, access, caseId, true);
      if (CLOSED_CASE_STATUSES.includes(kase.status)) {
        throw new ConflictException({ error: 'case_closed' });
      }
      await this.assignment.record(
        tx,
        actor,
        kase,
        { accountId: input.accountId, kind: 'manual', weightVersionId: null },
        input.reason,
      );
      await this.audit.record(
        {
          actor,
          action: 'lead.case_assigned_manually',
          entityType: 'case',
          entityId: kase.id,
          before: { assigneeAccountId: kase.assigneeAccountId },
          after: { assigneeAccountId: input.accountId },
          reason: input.reason,
        },
        tx,
      );
      const [row] = await tx.select().from(cases).where(eq(cases.id, kase.id));
      return view(row ?? kase);
    });
  }

  // --- helpers ----------------------------------------------------------------------------

  private async move(
    tx: Tx,
    actor: Actor,
    kase: CaseRow,
    to: CaseStatus,
    set: Partial<typeof cases.$inferInsert>,
    reasonCode: string | null = null,
    note: string | null = null,
  ): Promise<CaseView> {
    const [row] = await tx
      .update(cases)
      .set({ ...set, status: to })
      .where(eq(cases.id, kase.id))
      .returning();
    if (!row) throw new Error('case update returned nothing');
    await tx.insert(caseStatusChanges).values({
      caseId: kase.id,
      fromStatus: kase.status,
      toStatus: to,
      reasonCode,
      note,
      actorAccountId: actor.accountId,
    });
    await this.audit.record(
      {
        actor,
        action: 'lead.case_status_changed',
        entityType: 'case',
        entityId: kase.id,
        before: { status: kase.status },
        after: { status: to, reasonCode },
        reason: note,
      },
      tx,
    );
    return view(row);
  }

  /** A case the caller's scope covers; otherwise it does not exist (rule 13). */
  private async visible(
    ex: Tx | Database,
    actor: Actor,
    access: EffectiveAccess,
    caseId: string,
    lock = false,
  ): Promise<CaseRow> {
    if (!UUID.test(caseId)) throw new NotFoundException({ error: 'case_not_found' });
    const scope = this.scopeFilter(actor, access);
    if (scope === null) throw new NotFoundException({ error: 'case_not_found' });
    const query = ex
      .select()
      .from(cases)
      .where(
        and(eq(cases.id, caseId), isNull(cases.deletedAt), ...(scope === true ? [] : [scope])),
      );
    const [row] = lock ? await query.for('update') : await query;
    if (!row) throw new NotFoundException({ error: 'case_not_found' });
    return row;
  }

  /** What the caller's scopes cover: everything, a filter, or nothing at all. */
  private scopeFilter(actor: Actor, access: EffectiveAccess): SQL | true | null {
    const parts: SQL[] = [];
    for (const scope of access.scopes) {
      if (scope.kind === 'global') return true;
      if (scope.kind === 'city') parts.push(eq(cases.cityCode, scope.code));
      if (scope.kind === 'queue') parts.push(eq(cases.queueCode, scope.code));
      if (scope.kind === 'own' && actor.accountId !== null) {
        parts.push(eq(cases.assigneeAccountId, actor.accountId));
      }
    }
    if (parts.length === 0) return null;
    return parts.length === 1 ? (parts[0] ?? null) : (or(...parts) ?? null);
  }
}

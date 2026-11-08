import { ConflictException, Inject, Injectable } from '@nestjs/common';
import { CLOSED_CASE_STATUSES, SETTLEABLE_CASE_STATUSES, type CaseStatus } from '@sepehr/contracts';
import { eq } from 'drizzle-orm';
import {
  AUDIT_LOG,
  type Actor,
  type AuditLog,
  type SqlExecutor,
} from '../../common/audit/audit.port';
import type {
  BookingCase,
  BookingIntake,
  BookingIntakeSettings,
  CaseFacts,
  LeadCases,
  PersonStanding,
} from '../../common/lead/lead-cases.port';
import { DATABASE, type Database } from '../../db/database.module';
import { LeadIntakeService, type IntakeSettings } from './intake.service';
import { abandonmentReasons, caseCompletionAlerts, cases, caseStatusChanges } from './lead.schema';
import type { Tx } from './lead.shared';
import { AssignmentService } from './assignment.service';
import { PersonMobiles } from './person-mobiles';
import { ClubMembershipService } from './club-membership.service';
import { PersonService } from './person.service';

/**
 * The lead module's side of LEAD_CASES (task 2-6, ADR-027). A booking is an intake of the
 * app or an advisor through the one LeadIntakeService (doc 05 §1), so its rules hold: an
 * open case is reused without a new assignment (task 2-6 decision 3), a blocked person is
 * recorded and never assigned. Blocked for abuse, the booking is refused before anything
 * is written (decision 2).
 *
 * The booking module hands in its own Drizzle transaction; the port types it as a plain
 * executor so that booking does not depend on this module.
 */
@Injectable()
export class LeadCasesAdapter implements LeadCases {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(AUDIT_LOG) private readonly audit: AuditLog,
    private readonly persons: PersonService,
    private readonly intake: LeadIntakeService,
    private readonly assignment: AssignmentService,
    private readonly club: ClubMembershipService,
  ) {}

  clubMembershipAt(personId: string, day: string, tx?: SqlExecutor): Promise<string | null> {
    return this.club.membershipAt(personId, day, this.ex(tx));
  }

  async lockPerson(tx: SqlExecutor, personId: string): Promise<void> {
    await this.persons.lockPerson(tx as Tx, personId);
  }

  /** A block reaches a pending mobile too (task 9-3): it only restricts. */
  async standingOf(mobile: string, tx?: SqlExecutor): Promise<PersonStanding> {
    const person = await this.persons.holderOf(this.ex(tx), mobile);
    if (!person || person.blockedAt === null) return 'ok';
    return person.blockedKind === 'abuse' ? 'abuse' : 'do_not_contact';
  }

  /** Never by a pending mobile (task 9-3): staff would open a ticket on another's Person. */
  async personByMobile(mobile: string, tx?: SqlExecutor): Promise<string | null> {
    const person = await this.persons.byActiveMobile(this.ex(tx), mobile);
    return person ? this.canonicalPersonId(person.id, tx) : null;
  }

  async intakeSettings(): Promise<BookingIntakeSettings> {
    return { opaque: await this.intake.settings() };
  }

  async openForBooking(
    executor: SqlExecutor,
    actor: Actor,
    input: BookingIntake,
    settings: BookingIntakeSettings,
  ): Promise<BookingCase> {
    const tx = executor as Tx;
    if ((await this.standingOf(input.mobile, tx)) === 'abuse') return { kind: 'refused' };
    // Task 9-3: a patient's own booking with a pending mobile would open a case on a Person
    // the mobile does not yet stand for. Staff booking for a caller go on.
    if (
      input.channel === 'app' &&
      (await PersonMobiles.holder(tx, input.mobile))?.status === 'pending'
    ) {
      return { kind: 'refused' };
    }
    const result = await this.intake.intakeIn(
      tx,
      actor,
      {
        mobile: input.mobile,
        name: input.name ?? null,
        treatmentFieldCode: input.treatmentFieldCode,
        cityCode: input.cityCode,
        channel: input.channel,
        // The booking SMS are transactional; this is consent to anything more (doc 05).
        smsConsent: false,
      },
      settings.opaque as IntakeSettings,
    );
    if (result.caseId === null) return { kind: 'no_case', personId: result.personId };
    return {
      kind: 'case',
      personId: result.personId,
      caseId: result.caseId,
      caseCreated: result.caseCreated,
    };
  }

  samePersonIds(personId: string, tx?: SqlExecutor): Promise<string[]> {
    return this.persons.mergedIds(this.ex(tx), personId);
  }

  async canonicalPersonId(personId: string, tx?: SqlExecutor): Promise<string> {
    return (await this.persons.canonical(this.ex(tx), personId)).id;
  }

  async assigneeOf(caseId: string, tx?: SqlExecutor): Promise<string | null> {
    const [row] = await this.ex(tx)
      .select({ accountId: cases.assigneeAccountId })
      .from(cases)
      .where(eq(cases.id, caseId));
    return row?.accountId ?? null;
  }

  async caseFacts(caseId: string, tx?: SqlExecutor): Promise<CaseFacts | null> {
    if (!/^[0-9a-f-]{36}$/i.test(caseId)) return null;
    const [row] = await this.ex(tx)
      .select({
        id: cases.id,
        personId: cases.personId,
        treatmentFieldCode: cases.treatmentFieldCode,
        cityCode: cases.cityCode,
        closedAt: cases.closedAt,
      })
      .from(cases)
      .where(eq(cases.id, caseId));
    return row
      ? {
          caseId: row.id,
          personId: row.personId,
          treatmentFieldCode: row.treatmentFieldCode,
          cityCode: row.cityCode,
          closed: row.closedAt !== null,
        }
      : null;
  }

  /** Every SMS to a Person goes here: an approved mobile only, never a pending one (task 9-3). */
  async mobileOf(personId: string, tx?: SqlExecutor): Promise<string | null> {
    if (!/^[0-9a-f-]{36}$/i.test(personId)) return null;
    return PersonMobiles.firstActive(this.ex(tx), personId);
  }

  async recipientPerson(
    tx: SqlExecutor,
    actor: Actor,
    input: { mobile: string; nationalId: string; name: string },
  ): Promise<{ personId: string }> {
    // Task 9-3: a recipient's mobile is never added to a Person who already exists.
    const found = await this.persons.findOrCreate(tx as Tx, actor, {
      ...input,
      addedVia: 'credit_transfer',
      onExisting: 'refuse',
    });
    if (found.nationalIdConflict) throw new ConflictException({ error: 'national_id_mismatch' });
    return { personId: (await this.persons.canonical(tx as Tx, found.person.id)).id };
  }

  async displayNameOf(personId: string, tx?: SqlExecutor): Promise<string | null> {
    if (!/^[0-9a-f-]{36}$/i.test(personId)) return null;
    const person = await this.persons.canonical(this.ex(tx), personId).catch(() => null);
    return person?.displayName ?? null;
  }

  async completeCase(executor: SqlExecutor, actor: Actor, caseId: string): Promise<boolean> {
    const tx = executor as Tx;
    const [kase] = await tx.select().from(cases).where(eq(cases.id, caseId)).for('update');
    if (!kase || kase.deletedAt !== null || CLOSED_CASE_STATUSES.includes(kase.status)) {
      return false;
    }
    // Task 6-2: completed directly from a settleable stage, advising to proforma_issued, the
    // stages the funnel brings a case to (owner 1405/07/23, option A, migration 0086; was
    // advising only, 0057); in_treatment by the chain. Anywhere else, new included, it is
    // never passed on automatically (owner 1405/07/15): left to staff with an alert; false,
    // and the payment unaffected.
    if (!SETTLEABLE_CASE_STATUSES.includes(kase.status) && kase.status !== 'in_treatment') {
      const made = await tx
        .insert(caseCompletionAlerts)
        .values({ caseId: kase.id, statusAtSettlement: kase.status })
        .onConflictDoNothing()
        .returning({ id: caseCompletionAlerts.id });
      if (made.length > 0) {
        await this.audit.record(
          {
            actor,
            action: 'lead.case_completion_pending',
            entityType: 'case',
            entityId: kase.id,
            after: { status: kase.status },
            reason: 'loan_settled',
          },
          tx,
        );
      }
      return false;
    }
    await this.step(tx, actor, kase.id, kase.status, 'completed', new Date());
    return true;
  }

  /** One recorded, audited status change of a settled case. */
  private async step(
    tx: Tx,
    actor: Actor,
    caseId: string,
    from: CaseStatus,
    to: CaseStatus,
    closedAt: Date | null,
  ): Promise<void> {
    await tx
      .update(cases)
      .set(closedAt ? { status: to, closedAt } : { status: to })
      .where(eq(cases.id, caseId));
    await tx.insert(caseStatusChanges).values({
      caseId,
      fromStatus: from,
      toStatus: to,
      reasonCode: null,
      note: 'loan_settled',
      actorAccountId: actor.accountId,
    });
    await this.audit.record(
      {
        actor,
        action: 'lead.case_status_changed',
        entityType: 'case',
        entityId: caseId,
        before: { status: from },
        after: { status: to },
        reason: 'loan_settled',
      },
      tx,
    );
  }

  async closeCase(
    executor: SqlExecutor,
    actor: Actor,
    caseId: string,
    reasonCode: string,
    note: string | null,
  ): Promise<boolean> {
    const tx = executor as Tx;
    const [reason] = await tx
      .select({ code: abandonmentReasons.code })
      .from(abandonmentReasons)
      .where(eq(abandonmentReasons.code, reasonCode));
    // A base code of doc 05 §5; a retired one still names why a case closed.
    if (!reason) throw new Error(`no abandonment reason ${reasonCode}`);
    const [kase] = await tx.select().from(cases).where(eq(cases.id, caseId)).for('update');
    if (!kase || kase.deletedAt !== null || CLOSED_CASE_STATUSES.includes(kase.status)) {
      return false;
    }
    await tx
      .update(cases)
      .set({
        status: 'cancelled',
        abandonmentReasonCode: reasonCode,
        abandonmentNote: note,
        closedAt: new Date(),
      })
      .where(eq(cases.id, kase.id));
    await tx.insert(caseStatusChanges).values({
      caseId: kase.id,
      fromStatus: kase.status,
      toStatus: 'cancelled',
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
        after: { status: 'cancelled', reasonCode },
        reason: note,
      },
      tx,
    );
    return true;
  }

  async openFollowUpCase(
    executor: SqlExecutor,
    actor: Actor,
    fromCaseId: string,
    reason: string,
  ): Promise<string | null> {
    const tx = executor as Tx;
    const [from] = await tx.select().from(cases).where(eq(cases.id, fromCaseId));
    if (!from || from.deletedAt !== null) return null;
    const [made] = await tx
      .insert(cases)
      .values({
        personId: from.personId,
        queueCode: from.queueCode,
        treatmentFieldCode: from.treatmentFieldCode,
        cityCode: from.cityCode,
        channel: from.channel,
        // A returning case by the lead module's own rule: it has a previous case.
        isReturning: true,
        previousCaseId: from.id,
        createdBy: actor.accountId,
      })
      .returning();
    if (!made) throw new Error('case insert returned nothing');
    await tx.insert(caseStatusChanges).values({
      caseId: made.id,
      fromStatus: null,
      toStatus: 'new',
      note: reason,
      actorAccountId: actor.accountId,
    });
    // The same advisor follows it, by hand with the reason (doc 05 §6).
    await this.assignment.record(
      tx,
      actor,
      made,
      from.assigneeAccountId === null
        ? { accountId: null, kind: 'unassigned', weightVersionId: null }
        : { accountId: from.assigneeAccountId, kind: 'manual', weightVersionId: null },
      reason,
    );
    await this.audit.record(
      {
        actor,
        action: 'lead.case_opened_for_credit',
        entityType: 'case',
        entityId: made.id,
        after: { previousCaseId: from.id },
        reason,
      },
      tx,
    );
    return made.id;
  }

  private ex(tx?: SqlExecutor): Tx | Database {
    return (tx as Tx | undefined) ?? this.db;
  }
}

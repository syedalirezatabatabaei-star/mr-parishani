import { Inject, Injectable } from '@nestjs/common';
import {
  ADVISORY_QUEUE,
  EXISTING_CUSTOMERS_QUEUE,
  OPEN_CASE_STATUSES,
  type IntakeCategory,
  type IntakeChannel,
  type Utm,
} from '@sepehr/contracts';
import { and, desc, eq, inArray, isNull } from 'drizzle-orm';
import { AUDIT_LOG, type Actor, type AuditLog } from '../../common/audit/audit.port';
import { CONFIG, type ConfigPort } from '../../common/config/config.port';
import { OUTBOX, type OutboxPort } from '../../common/events/outbox.port';
import { REPAYMENT, type RepaymentPort } from '../../common/repayment/repayment.port';
import { DATABASE, type Database } from '../../db/database.module';
import { AssignmentService } from './assignment.service';
import { isExistingCustomer } from './existing-customer';
import { caseAssignments, caseIntakes, cases, caseStatusChanges } from './lead.schema';
import type { Tx } from './lead.shared';
import { PersonService } from './person.service';

/** One intake, already normalized (rules 23 and 24): what every source hands in. */
export interface IntakeInput {
  readonly mobile: string;
  readonly name?: string | null;
  readonly nationalId?: string | null;
  readonly treatmentFieldCode: string;
  readonly cityCode?: string | null;
  readonly channel: IntakeChannel;
  readonly smsConsent: boolean;
  readonly utm?: Utm | null;
  readonly pageUrl?: string | null;
  /** Task 8-2: the WordPress form's referrer. */
  readonly referrer?: string | null;
  readonly note?: string | null;
  readonly importBatchId?: string | null;
}

/**
 * The configuration an intake follows, read before its transaction opens: a read inside it
 * would take a second pooled connection while holding locks, and a burst of intakes could
 * then wait on each other for connections.
 */
export interface IntakeSettings {
  readonly duplicateWindowDays: number;
  readonly returningToPreviousAgent: boolean;
}

export interface IntakeResult {
  readonly intakeId: string;
  readonly category: IntakeCategory;
  readonly personId: string;
  readonly personCreated: boolean;
  /** Null only for a blocked person. */
  readonly caseId: string | null;
  readonly caseCreated: boolean;
  readonly assigneeAccountId: string | null;
  readonly nationalIdConflict: boolean;
}

const DAY_MS = 86_400_000;

/**
 * LeadIntakeService (doc 05 §1): the one path of every source (the app, the WordPress
 * form, the Excel import, an advisor), so that the same rules apply to all. Each intake is
 * recorded; what it becomes follows doc 05 §4, checked in this order:
 *
 * - `blocked`: the person is blocked; recorded, never assigned, the manager is told.
 * - `duplicate_active`: a case before contract is open; no new case, the intake is added
 *   to it and its advisor is told. TODO(decision): the duplicate window
 *   (`lead.duplicate_window_days`) is reported with the intake, but an open case older
 *   than it is still not opened twice (at most one open case per person).
 * - `existing_customer`: a loan in progress (isExistingCustomer); a new case in the
 *   existing customers' queue.
 * - `returning`: every earlier case is closed; a new case marked returning, linked to the
 *   latest one, back to its advisor when possible.
 * - `new`: no person before this intake.
 */
@Injectable()
export class LeadIntakeService {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(AUDIT_LOG) private readonly audit: AuditLog,
    @Inject(CONFIG) private readonly config: ConfigPort,
    @Inject(OUTBOX) private readonly outbox: OutboxPort,
    @Inject(REPAYMENT) private readonly repayment: RepaymentPort,
    private readonly persons: PersonService,
    private readonly assignment: AssignmentService,
  ) {}

  async intake(actor: Actor, input: IntakeInput): Promise<IntakeResult> {
    const settings = await this.settings();
    return this.db.transaction((tx) => this.intakeIn(tx, actor, input, settings));
  }

  /** Read once before the transaction (see IntakeSettings). */
  async settings(): Promise<IntakeSettings> {
    const [window, back] = await Promise.all([
      this.config.resolve('lead.duplicate_window_days'),
      this.config.resolve('lead.returning_to_previous_agent'),
    ]);
    return { duplicateWindowDays: window.value, returningToPreviousAgent: back.value };
  }

  /** The same, in the caller's transaction (the webhook's delivery, an import row). */
  async intakeIn(
    tx: Tx,
    actor: Actor,
    input: IntakeInput,
    settings: IntakeSettings,
  ): Promise<IntakeResult> {
    const found = await this.persons.findOrCreate(tx, actor, {
      mobile: input.mobile,
      name: input.name ?? null,
      nationalId: input.nationalId ?? null,
      importBatchId: input.importBatchId ?? null,
      addedVia: input.importBatchId ? 'import' : 'intake',
    });
    const person = found.person;
    const personIds = await this.persons.mergedIds(tx, person.id);

    if (person.blockedAt !== null) {
      const intakeId = await this.recordIntake(tx, actor, input, person.id, null, 'blocked');
      await this.outbox.publish(
        {
          type: 'lead.intake_blocked',
          aggregateType: 'person',
          aggregateId: person.id,
          payload: { intakeId, personId: person.id },
        },
        tx,
      );
      return this.result(intakeId, 'blocked', found, null, false, null);
    }

    const earlier = await tx
      .select()
      .from(cases)
      .where(and(inArray(cases.personId, personIds), isNull(cases.deletedAt)))
      .orderBy(desc(cases.createdAt), desc(cases.id));

    const open = earlier.find((c) => OPEN_CASE_STATUSES.includes(c.status));
    if (open) {
      const [last] = await tx
        .select({ at: caseIntakes.createdAt })
        .from(caseIntakes)
        .where(eq(caseIntakes.caseId, open.id))
        .orderBy(desc(caseIntakes.createdAt))
        .limit(1);
      const withinWindow =
        last !== undefined &&
        Date.now() - last.at.getTime() < settings.duplicateWindowDays * DAY_MS;
      const intakeId = await this.recordIntake(
        tx,
        actor,
        input,
        person.id,
        open.id,
        'duplicate_active',
        {
          withinWindow,
        },
      );
      await this.outbox.publish(
        {
          type: 'lead.intake_duplicate',
          aggregateType: 'case',
          aggregateId: open.id,
          payload: { caseId: open.id, intakeId, advisorAccountId: open.assigneeAccountId },
        },
        tx,
      );
      return this.result(
        intakeId,
        'duplicate_active',
        found,
        open.id,
        false,
        open.assigneeAccountId,
      );
    }
    if (await isExistingCustomer(tx, this.repayment, personIds)) {
      return this.openCase(
        tx,
        actor,
        input,
        found,
        'existing_customer',
        EXISTING_CUSTOMERS_QUEUE,
        null,
        settings,
      );
    }
    const previous = earlier[0] ?? null;
    if (previous) {
      return this.openCase(
        tx,
        actor,
        input,
        found,
        'returning',
        ADVISORY_QUEUE,
        previous,
        settings,
      );
    }
    return this.openCase(tx, actor, input, found, 'new', ADVISORY_QUEUE, null, settings);
  }

  private async openCase(
    tx: Tx,
    actor: Actor,
    input: IntakeInput,
    found: { person: { id: string }; created: boolean; nationalIdConflict: boolean },
    category: 'new' | 'returning' | 'existing_customer',
    queueCode: string,
    previous: typeof cases.$inferSelect | null,
    settings: IntakeSettings,
  ): Promise<IntakeResult> {
    const [kase] = await tx
      .insert(cases)
      .values({
        personId: found.person.id,
        queueCode,
        treatmentFieldCode: input.treatmentFieldCode,
        cityCode: input.cityCode ?? null,
        channel: input.channel,
        isReturning: category === 'returning',
        previousCaseId: category === 'returning' ? (previous?.id ?? null) : null,
        importBatchId: input.importBatchId ?? null,
        createdBy: actor.accountId,
      })
      .returning();
    if (!kase) throw new Error('case insert returned nothing');
    await tx.insert(caseStatusChanges).values({
      caseId: kase.id,
      fromStatus: null,
      toStatus: 'new',
      actorAccountId: actor.accountId,
    });
    const intakeId = await this.recordIntake(tx, actor, input, found.person.id, kase.id, category);
    await this.outbox.publish(
      {
        type: 'lead.case_opened',
        aggregateType: 'case',
        aggregateId: kase.id,
        payload: { caseId: kase.id, personId: found.person.id, category },
      },
      tx,
    );
    const previousAssignee =
      category === 'returning' && previous ? await this.lastAssignee(tx, previous.id) : null;
    const outcome = await this.assignment.assign(
      tx,
      actor,
      kase,
      settings.returningToPreviousAgent ? previousAssignee : null,
    );
    return this.result(intakeId, category, found, kase.id, true, outcome.accountId);
  }

  private async recordIntake(
    tx: Tx,
    actor: Actor,
    input: IntakeInput,
    personId: string,
    caseId: string | null,
    category: IntakeCategory,
    extra: Record<string, unknown> = {},
  ): Promise<string> {
    const [row] = await tx
      .insert(caseIntakes)
      .values({
        personId,
        caseId,
        category,
        channel: input.channel,
        mobile: input.mobile,
        name: input.name ?? null,
        treatmentFieldCode: input.treatmentFieldCode,
        cityCode: input.cityCode ?? null,
        smsConsent: input.smsConsent,
        utm: input.utm ?? null,
        pageUrl: input.pageUrl ?? null,
        referrer: input.referrer ?? null,
        note: input.note ?? null,
        importBatchId: input.importBatchId ?? null,
        createdBy: actor.accountId,
      })
      .returning({ id: caseIntakes.id });
    if (!row) throw new Error('intake insert returned nothing');
    // Ids and the decision only: the mobile and name stay in the intake row.
    await this.audit.record(
      {
        actor,
        action: 'lead.intake_recorded',
        entityType: 'case_intake',
        entityId: row.id,
        after: { personId, caseId, category, channel: input.channel, ...extra },
      },
      tx,
    );
    return row.id;
  }

  /** The last person who had this case, whoever they were. */
  private async lastAssignee(tx: Tx, caseId: string): Promise<string | null> {
    const rows = await tx
      .select({ accountId: caseAssignments.accountId })
      .from(caseAssignments)
      .where(eq(caseAssignments.caseId, caseId))
      .orderBy(desc(caseAssignments.createdAt), desc(caseAssignments.id));
    return rows.find((r) => r.accountId !== null)?.accountId ?? null;
  }

  private result(
    intakeId: string,
    category: IntakeCategory,
    found: { person: { id: string }; created: boolean; nationalIdConflict: boolean },
    caseId: string | null,
    caseCreated: boolean,
    assigneeAccountId: string | null,
  ): IntakeResult {
    return {
      intakeId,
      category,
      personId: found.person.id,
      personCreated: found.created,
      caseId,
      caseCreated,
      assigneeAccountId,
      nationalIdConflict: found.nationalIdConflict,
    };
  }
}

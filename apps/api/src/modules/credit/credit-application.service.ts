import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  gregorianDayOf,
  normalizeMobile,
  toJalali,
  PERSON_DIRECTORY,
  plansFor,
  type CreditApplicationView,
  type CreditGroupView,
  type CreditQueue,
  type PersonDirectory,
} from '@sepehr/contracts';
import { and, desc, eq, inArray, isNotNull, isNull, ne, notInArray, or, sql } from 'drizzle-orm';
import type { EffectiveAccess } from '../../common/auth/access.port';
import { ACCOUNT_DIRECTORY, type AccountDirectory } from '../../common/auth/account-directory.port';
import { AUDIT_LOG, type Actor, type AuditLog } from '../../common/audit/audit.port';
import { CONFIG, type ConfigPort } from '../../common/config/config.port';
import { OUTBOX, type OutboxPort } from '../../common/events/outbox.port';
import { LEAD_CASES, type LeadCases } from '../../common/lead/lead-cases.port';
import {
  PROFORMA_DIRECTORY,
  type ProformaDirectory,
  type ProformaRecord,
} from '../../common/proforma/proforma-directory.port';
import { DATABASE, type Database } from '../../db/database.module';
import { CreditPlanService, type LockedQuote } from './credit-plan.service';
import { CreditQueueService } from './credit-queue.service';
import {
  creditApplications,
  creditApplicationStatusChanges,
  creditConditionChecks,
  creditConsents,
  creditDocuments,
} from './credit.schema';

type Tx = Parameters<Parameters<Database['transaction']>[0]>[0];
type ApplicationRow = typeof creditApplications.$inferSelect;
type Status = ApplicationRow['status'];

const HOUR_MS = 3_600_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const notFound = () => new NotFoundException({ error: 'credit_application_not_found' });

/**
 * Credit applications (task 3-5 part A, doc 10 §4). The patient asks for one on their
 * confirmed proforma, choosing among the plans that fit its case; the preview is locked to
 * the configuration versions of that day (rule 16). The borrower may be another person
 * (doc 01). The patient submits it; the case-completion specialist sends it on to credit
 * review, which starts its deadline (`credit.sla_hours`). No ledger entry (doc 10 §1).
 *
 * Staff reach an application by permission and scope (global, or the city of its
 * proforma); patients and borrowers reach their own only (rule 13).
 */
@Injectable()
export class CreditApplicationService {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(AUDIT_LOG) private readonly audit: AuditLog,
    @Inject(OUTBOX) private readonly outbox: OutboxPort,
    @Inject(CONFIG) private readonly config: ConfigPort,
    @Inject(PROFORMA_DIRECTORY) private readonly proformas: ProformaDirectory,
    @Inject(LEAD_CASES) private readonly leads: LeadCases,
    @Inject(ACCOUNT_DIRECTORY) private readonly accounts: AccountDirectory,
    @Inject(PERSON_DIRECTORY) private readonly persons: PersonDirectory,
    private readonly plans: CreditPlanService,
    private readonly queues: CreditQueueService,
  ) {}

  // --- the patient's side -----------------------------------------------------------

  /** The plans a confirmed proforma of this patient can be financed by, with previews. */
  async planOptions(accountId: string, proformaId: string, now = new Date()) {
    const proforma = await this.confirmedProforma(accountId, proformaId);
    const offered = await this.offeredPlans(proforma, now);
    const wageRial = await this.wageOf(proforma);
    const plans = [];
    const unavailablePlans: { code: string; title: string }[] = [];
    for (const plan of offered) {
      const options = [];
      for (const installmentCount of plan.installmentCounts) {
        const quoted = await this.plans
          .quote(
            plan.code,
            { proformaTotalRial: proforma.totalRial, installmentCount, wageRial },
            undefined,
            now,
          )
          .catch((error: unknown) => {
            if (error instanceof BadRequestException) return null;
            throw error;
          });
        if (quoted) options.push({ installmentCount, quote: quoteView(quoted) });
      }
      if (options.length > 0) plans.push({ code: plan.code, title: plan.title, options });
      else unavailablePlans.push({ code: plan.code, title: plan.title });
    }
    return {
      proformaId: proforma.proformaId,
      totalRial: proforma.totalRial.toString(),
      plans,
      unavailablePlans,
    };
  }

  async create(
    actor: Actor,
    accountId: string,
    input: {
      proformaId: string;
      planCode: string;
      installmentCount: number;
      requestedAmountRial?: bigint | undefined;
      borrowerMobile?: string | undefined;
    },
    now = new Date(),
  ): Promise<CreditApplicationView> {
    const proforma = await this.confirmedProforma(accountId, input.proformaId);
    const offered = await this.offeredPlans(proforma, now);
    if (!offered.some((p) => p.code === input.planCode)) {
      throw new ConflictException({ error: 'plan_not_offered' });
    }
    const locked = await this.plans.quote(
      input.planCode,
      {
        proformaTotalRial: proforma.totalRial,
        installmentCount: input.installmentCount,
        wageRial: await this.wageOf(proforma),
        ...(input.requestedAmountRial === undefined
          ? {}
          : { requestedAmountRial: input.requestedAmountRial }),
      },
      undefined,
      now,
    );
    const borrowerPersonId = await this.borrowerOf(proforma, input.borrowerMobile);
    const row = await this.db
      .transaction(async (tx) => {
        await this.lockProforma(tx, proforma.proformaId);
        // Alone, still one open application per proforma; a group is made as one (task 3-7).
        if (await this.openOn(tx, proforma.proformaId)) {
          throw new ConflictException({ error: 'application_exists' });
        }
        return this.insert(tx, actor, accountId, {
          caseId: proforma.caseId,
          proforma,
          borrowerPersonId,
          locked,
          installmentCount: input.installmentCount,
          proformaTotalRial: proforma.totalRial,
          caseGroupId: null,
        });
      })
      .catch(uniqueToConflict);
    return view(row);
  }

  /**
   * Over the cap (doc 10 §7; task 3-7): two borrowers finance one proforma, each on their
   * own share, which add up to it. Each is a credit application of its own, scored and
   * decided independently; its down payment and fees are its own, on its share (owner,
   * 1405/07/10).
   */
  async createGroup(
    actor: Actor,
    accountId: string,
    input: {
      proformaId: string;
      members: readonly {
        planCode: string;
        installmentCount: number;
        shareRial: bigint;
        borrowerMobile?: string | undefined;
      }[];
    },
    now = new Date(),
  ): Promise<CreditApplicationView[]> {
    const proforma = await this.confirmedProforma(accountId, input.proformaId);
    const sum = input.members.reduce((total, m) => total + m.shareRial, 0n);
    if (sum !== proforma.totalRial) {
      throw new BadRequestException({
        error: 'shares_must_add_up',
        totalRial: proforma.totalRial.toString(),
      });
    }
    const offered = await this.offeredPlans(proforma, now);
    const members: {
      member: (typeof input.members)[number];
      locked: LockedQuote;
      borrowerPersonId: string;
    }[] = [];
    for (const m of input.members) {
      const plan = offered.find((p) => p.code === m.planCode);
      if (!plan) throw new ConflictException({ error: 'plan_not_offered' });
      // ADR-050: a member's share is a part of the whole proforma, not of its wage lines.
      if (plan.financeableBasis === 'wage') {
        throw new ConflictException({ error: 'wage_plan_not_for_groups' });
      }
      members.push({
        member: m,
        locked: await this.plans.quote(
          m.planCode,
          { proformaTotalRial: m.shareRial, installmentCount: m.installmentCount },
          undefined,
          now,
        ),
        borrowerPersonId: await this.borrowerOf(proforma, m.borrowerMobile),
      });
    }
    if (new Set(members.map((m) => m.borrowerPersonId)).size !== members.length) {
      throw new ConflictException({ error: 'same_borrower' });
    }
    const rows = await this.db
      .transaction(async (tx) => {
        await this.lockProforma(tx, proforma.proformaId);
        if (await this.openOn(tx, proforma.proformaId)) {
          throw new ConflictException({ error: 'application_exists' });
        }
        const caseGroupId = await newId(tx);
        const made: ApplicationRow[] = [];
        for (const m of members) {
          made.push(
            await this.insert(tx, actor, accountId, {
              caseId: proforma.caseId,
              proforma,
              borrowerPersonId: m.borrowerPersonId,
              locked: m.locked,
              installmentCount: m.member.installmentCount,
              proformaTotalRial: m.member.shareRial,
              caseGroupId,
            }),
          );
        }
        return made;
      })
      .catch(uniqueToConflict);
    return rows.map(view);
  }

  /**
   * A large shortfall (doc 10 §7; task 3-7): what an approval left uncovered beyond the
   * small-shortfall threshold is financed by a new case of the same person and a new
   * application on it, in the approved one's group. Its down payment and fees are its own.
   */
  async createForShortfall(
    actor: Actor,
    accountId: string,
    id: string,
    input: { planCode: string; installmentCount: number; borrowerMobile?: string | undefined },
    now = new Date(),
  ): Promise<CreditApplicationView> {
    const approved = await this.ownRow(accountId, id);
    if (
      !['approved', 'conditional'].includes(approved.status) ||
      approved.shortfallKind !== 'large' ||
      approved.approvedCashTopUpRial === null
    ) {
      throw new ConflictException({ error: 'no_large_shortfall' });
    }
    const share = approved.approvedCashTopUpRial;
    const proforma = await this.proformas.proforma(approved.proformaId);
    if (!proforma) throw new NotFoundException({ error: 'proforma_not_found' });
    const offered = await this.offeredPlans(proforma, now);
    const shortfallPlan = offered.find((p) => p.code === input.planCode);
    if (!shortfallPlan) throw new ConflictException({ error: 'plan_not_offered' });
    // ADR-050: the shortfall is a share of the whole proforma, not of its wage lines.
    if (shortfallPlan.financeableBasis === 'wage') {
      throw new ConflictException({ error: 'wage_plan_not_for_groups' });
    }
    const locked = await this.plans.quote(
      input.planCode,
      { proformaTotalRial: share, installmentCount: input.installmentCount },
      undefined,
      now,
    );
    const borrowerPersonId = await this.borrowerOf(proforma, input.borrowerMobile);
    const row = await this.db
      .transaction(async (tx) => {
        const [first] = await tx
          .select()
          .from(creditApplications)
          .where(eq(creditApplications.id, approved.id))
          .for('update');
        if (!first) throw notFound();
        let caseGroupId = first.caseGroupId;
        if (caseGroupId === null) {
          caseGroupId = await newId(tx);
          await tx
            .update(creditApplications)
            .set({ caseGroupId })
            .where(eq(creditApplications.id, first.id));
        } else {
          const followUps = await tx
            .select({ id: creditApplications.id })
            .from(creditApplications)
            .where(
              and(
                eq(creditApplications.caseGroupId, caseGroupId),
                ne(creditApplications.caseId, first.caseId),
                notInArray(creditApplications.status, ['rejected', 'expired']),
              ),
            );
          if (followUps.length > 0) throw new ConflictException({ error: 'application_exists' });
        }
        const caseId = await this.leads.openFollowUpCase(
          tx,
          actor,
          first.caseId,
          'کسری زیاد پس از تصمیم اعتباری (سند ۱۰ §۷)',
        );
        if (caseId === null) throw new ConflictException({ error: 'case_closed' });
        return this.insert(tx, actor, accountId, {
          caseId,
          proforma,
          borrowerPersonId,
          locked,
          installmentCount: input.installmentCount,
          proformaTotalRial: share,
          caseGroupId,
        });
      })
      .catch(uniqueToConflict);
    return view(row);
  }

  /** The credit specialist's report of a group (task 3-7): its members, side by side. */
  async group(access: EffectiveAccess, caseGroupId: string): Promise<CreditGroupView> {
    this.require(access, 'credit.read_applications');
    if (!UUID.test(caseGroupId)) throw new NotFoundException({ error: 'credit_group_not_found' });
    const rows = await this.db
      .select()
      .from(creditApplications)
      .where(eq(creditApplications.caseGroupId, caseGroupId))
      // Members made together share a timestamp; UUIDv7 keeps the order they were made in.
      .orderBy(creditApplications.createdAt, creditApplications.id);
    const visible = await this.visibleOf(access, rows);
    if (visible.length === 0) throw new NotFoundException({ error: 'credit_group_not_found' });
    return groupView(caseGroupId, visible);
  }

  /** The latest groups the caller can see, newest first. */
  async groups(access: EffectiveAccess): Promise<CreditGroupView[]> {
    this.require(access, 'credit.read_applications');
    const rows = await this.db
      .select()
      .from(creditApplications)
      .where(isNotNull(creditApplications.caseGroupId))
      .orderBy(desc(creditApplications.createdAt), desc(creditApplications.id))
      .limit(500);
    const byGroup = new Map<string, ApplicationRow[]>();
    for (const r of await this.visibleOf(access, rows)) {
      const key = r.caseGroupId ?? '';
      byGroup.set(key, [r, ...(byGroup.get(key) ?? [])]);
    }
    return [...byGroup].map(([groupId, members]) => groupView(groupId, members));
  }

  async listMine(accountId: string): Promise<CreditApplicationView[]> {
    const persons = await this.personsOf(accountId);
    const rows = await this.db
      .select()
      .from(creditApplications)
      .where(
        or(
          inArray(creditApplications.patientPersonId, persons),
          inArray(creditApplications.borrowerPersonId, persons),
        ),
      )
      .orderBy(desc(creditApplications.createdAt));
    return rows.map(view);
  }

  async getMine(accountId: string, id: string): Promise<CreditApplicationView> {
    return view(await this.ownRow(accountId, id));
  }

  /**
   * A draft's own figures before it is submitted (owner 1405/07/22, M1 §8.7 option ب): the
   * quote made again from the versions the application locked at creation, as its decision
   * and contract make it, never from today's configuration. The loan is the one it locked, so
   * a reduction the patient asked for is kept. Only a draft: after submission the credit unit
   * decides the amount. Read only; the due days are counted from today (approximate).
   */
  async lockedQuoteMine(accountId: string, id: string, now = new Date()) {
    const row = await this.ownRow(accountId, id);
    if (row.status !== 'draft') {
      throw new ConflictException({ error: 'application_not_draft', status: row.status });
    }
    const locked = await this.plans.quote(
      row.planCode,
      {
        proformaTotalRial: row.proformaTotalRial,
        installmentCount: row.installmentCount,
        requestedAmountRial: row.loanRial,
        wageRial: row.wageRial ?? undefined,
      },
      {
        plansVersionId: row.plansVersionId,
        roundingVersionId: row.roundingVersionId,
        reductionVersionId: row.reductionVersionId,
        shiftVersionId: row.shiftVersionId,
        graceVersionId: row.graceVersionId,
      },
      now,
    );
    return { applicationId: row.id, quote: quoteView(locked), dueDatesApproximate: true as const };
  }

  /** The patient or the borrower submits a draft: it goes to case completion. */
  async submit(actor: Actor, accountId: string, id: string, now = new Date()) {
    const own = await this.ownRow(accountId, id);
    const completionKey = {
      ...(await this.queues.keyFor(own, 'completion')),
      queueCode: 'completion' as const,
    };
    // The document checklist of the day it is submitted is the one it is held to (rule 16).
    const checklist = await this.config.resolve('credit.document_checklist', {}, now);
    return view(
      await this.transition(
        actor,
        own.id,
        ['draft'],
        'incomplete',
        null,
        'credit.submitted',
        { submittedAt: now, checklistVersionId: checklist.versionId },
        (tx, moved) => this.queues.assign(tx, actor, moved, completionKey),
      ),
    );
  }

  // --- staff ------------------------------------------------------------------------

  async get(access: EffectiveAccess, id: string): Promise<CreditApplicationView> {
    this.require(access, 'credit.read_applications');
    return view(await this.staffApplication(access, id));
  }

  /**
   * The case-completion specialist sends a complete application on to credit review; its
   * deadline starts (doc 10 §4). The completeness checks of documents, consents and
   * guarantors join here in parts B and C of this task.
   */
  async markReadyForReview(actor: Actor, access: EffectiveAccess, id: string, now = new Date()) {
    this.require(access, 'credit.complete_applications');
    const row = await this.staffApplication(access, id);
    const missing = await this.missingForReview(row);
    if (missing.length > 0) throw new ConflictException({ error: 'not_complete', missing });
    const hours = (await this.config.resolve('credit.sla_hours', {}, now)).value;
    const creditKey = {
      ...(await this.queues.keyFor(row, 'credit')),
      queueCode: 'credit' as const,
    };
    return view(
      await this.transition(
        actor,
        row.id,
        ['incomplete'],
        'ready_for_review',
        null,
        'credit.ready_for_review',
        {
          slaDueAt: new Date(now.getTime() + hours * HOUR_MS),
          needsMoreGuarantors: false,
        },
        (tx, moved) => this.queues.assign(tx, actor, moved, creditKey),
      ),
    );
  }

  /** The caller's own work in a credit queue (doc 10 §8): open applications assigned to them. */
  async myQueue(access: EffectiveAccess, queueCode: CreditQueue): Promise<CreditApplicationView[]> {
    this.require(access, 'credit.read_applications');
    const ids = await this.queues.assignedTo(access.accountId, queueCode);
    if (ids.length === 0) return [];
    const rows = await this.db
      .select()
      .from(creditApplications)
      .where(inArray(creditApplications.id, ids))
      .orderBy(creditApplications.createdAt);
    return rows.map(view);
  }

  /**
   * The credit units' list (task 3-8), filtered and paged on the server: by state, and to
   * the caller's own work in a queue. A city scope sees its city's, among the latest 1,000.
   */
  async list(
    access: EffectiveAccess,
    query: {
      status?: Status | undefined;
      queueCode?: CreditQueue | undefined;
      page?: number | undefined;
      pageSize?: number | undefined;
    },
  ) {
    this.require(access, 'credit.read_applications');
    const page = query.page ?? 1;
    const pageSize = query.pageSize ?? 20;
    const empty = { page, pageSize, total: 0, items: [] as CreditApplicationView[] };
    const conditions = [isNull(creditApplications.deletedAt)];
    if (query.status) conditions.push(eq(creditApplications.status, query.status));
    if (query.queueCode) {
      const ids = await this.queues.assignedTo(access.accountId, query.queueCode);
      if (ids.length === 0) return empty;
      conditions.push(inArray(creditApplications.id, ids));
    }
    const where = and(...conditions);
    if (access.scopes.some((s) => s.kind === 'global')) {
      const [counted] = await this.db
        .select({ n: sql<number>`count(*)::int` })
        .from(creditApplications)
        .where(where);
      const rows = await this.db
        .select()
        .from(creditApplications)
        .where(where)
        .orderBy(desc(creditApplications.createdAt), desc(creditApplications.id))
        .limit(pageSize)
        .offset((page - 1) * pageSize);
      return { page, pageSize, total: counted?.n ?? 0, items: rows.map(view) };
    }
    const latest = await this.db
      .select()
      .from(creditApplications)
      .where(where)
      .orderBy(desc(creditApplications.createdAt), desc(creditApplications.id))
      .limit(1000);
    const visible = await this.visibleOf(access, latest);
    return {
      page,
      pageSize,
      total: visible.length,
      items: visible.slice((page - 1) * pageSize, page * pageSize).map(view),
    };
  }

  /**
   * A condition of a conditional approval is met (task 4-3; doc 12 §4 item 3): ticked once
   * by case completion, with who and when, before the application may be completed.
   */
  async checkCondition(
    actor: Actor,
    access: EffectiveAccess,
    id: string,
    index: number,
    note: string | undefined,
  ) {
    if (!access.permissions.has('credit.check_conditions')) {
      throw new ForbiddenException({ error: 'permission_required' });
    }
    const app = await this.staffApplication(access, id);
    if (app.status !== 'conditional' || app.conditions === null) {
      throw new ConflictException({ error: 'not_conditional', status: app.status });
    }
    const text = app.conditions[index];
    if (text === undefined) throw new NotFoundException({ error: 'condition_not_found' });
    await this.db
      .transaction(async (tx) => {
        await tx.insert(creditConditionChecks).values({
          creditApplicationId: app.id,
          conditionIndex: index,
          conditionText: text,
          checkedBy: actor.accountId ?? '',
          note: note ?? null,
        });
        await this.audit.record(
          {
            actor,
            action: 'credit.condition_checked',
            entityType: 'credit_application',
            entityId: app.id,
            after: { index, text },
            reason: note ?? null,
          },
          tx,
        );
      })
      .catch((error: unknown) => {
        if (isUniqueViolation(error)) throw new ConflictException({ error: 'already_checked' });
        throw error;
      });
    return view(app);
  }

  async assignments(access: EffectiveAccess, id: string) {
    this.require(access, 'credit.read_applications');
    return this.queues.history((await this.staffApplication(access, id)).id);
  }

  async assignManually(
    actor: Actor,
    access: EffectiveAccess,
    id: string,
    input: { queueCode: CreditQueue; accountId: string; reason: string },
  ) {
    if (!access.permissions.has('credit.assign_manually')) {
      throw new ForbiddenException({ error: 'permission_required' });
    }
    const app = await this.staffApplication(access, id);
    await this.queues.assignManually(actor, app, input);
    return this.queues.history(app.id);
  }

  // --- helpers ----------------------------------------------------------------------

  /**
   * What the borrower still owes before credit review (doc 10 §4): their consent, and
   * every required document of the locked checklist accepted. Items for a job are asked
   * once a sheet names the job, so not yet here. Guarantors come after the borrower's grade
   * (doc 03 §1), so theirs are checked at the decision (task 3-6).
   */
  private async missingForReview(app: ApplicationRow): Promise<string[]> {
    const missing: string[] = [];
    const [consent] = await this.db
      .select({ id: creditConsents.id })
      .from(creditConsents)
      .where(
        and(
          eq(creditConsents.creditApplicationId, app.id),
          eq(creditConsents.personId, app.borrowerPersonId),
          eq(creditConsents.role, 'borrower'),
        ),
      );
    if (!consent) missing.push('consent:borrower');
    if (app.checklistVersionId === null) return [...missing, 'checklist'];
    const checklist = (
      await this.config.getVersion('credit.document_checklist', app.checklistVersionId)
    ).value;
    const accepted = await this.db
      .select({ itemCode: creditDocuments.itemCode })
      .from(creditDocuments)
      .where(
        and(
          eq(creditDocuments.creditApplicationId, app.id),
          eq(creditDocuments.personId, app.borrowerPersonId),
          eq(creditDocuments.role, 'borrower'),
          eq(creditDocuments.status, 'accepted'),
        ),
      );
    const have = new Set(accepted.map((d) => d.itemCode));
    for (const item of checklist.items) {
      if (
        item.required &&
        item.jobs === null &&
        item.roles.includes('borrower') &&
        !have.has(item.code)
      ) {
        missing.push(`document:${item.code}`);
      }
    }
    return missing;
  }

  private async insert(
    tx: Tx,
    actor: Actor,
    accountId: string,
    a: {
      caseId: string;
      proforma: ProformaRecord;
      borrowerPersonId: string;
      locked: LockedQuote;
      installmentCount: number;
      /** The proforma's total, or this member's share of it in a group. */
      proformaTotalRial: bigint;
      caseGroupId: string | null;
    },
  ): Promise<ApplicationRow> {
    const q = a.locked.quote;
    // ADR-048: a club plan only for a member today, the membership locked on the application.
    let clubMembershipId: string | null = null;
    if (a.locked.plan.requiresClubMembership === true) {
      clubMembershipId = await this.leads.clubMembershipAt(
        a.proforma.personId,
        gregorianDayOf(toJalali(new Date())),
        tx,
      );
      if (clubMembershipId === null) {
        throw new ConflictException({ error: 'club_membership_required' });
      }
    }
    const [made] = await tx
      .insert(creditApplications)
      .values({
        caseId: a.caseId,
        proformaId: a.proforma.proformaId,
        patientPersonId: a.proforma.personId,
        borrowerPersonId: a.borrowerPersonId,
        createdBy: accountId,
        planCode: a.locked.plan.code,
        planTitle: a.locked.plan.title,
        plansVersionId: a.locked.versions.plansVersionId,
        roundingVersionId: a.locked.versions.roundingVersionId,
        reductionVersionId: a.locked.versions.reductionVersionId,
        shiftVersionId: a.locked.versions.shiftVersionId,
        graceVersionId: a.locked.versions.graceVersionId,
        installmentCount: a.installmentCount,
        proformaTotalRial: a.proformaTotalRial,
        downPaymentRial: q.downPaymentRial,
        loanRial: q.loanRial,
        cashTopUpRial: q.cashTopUpRial,
        planFeeRial: q.planFeeRial,
        planFeeTiming: q.planFeeTiming,
        originationFeeRial: q.originationFeeRial,
        totalObligationRial: q.totalObligationRial,
        caseGroupId: a.caseGroupId,
        clubMembershipId,
        // ADR-050: the wage lines locked for a wage-only plan; the materials go to the doctor.
        wageRial:
          a.locked.plan.financeableBasis === 'wage'
            ? a.proformaTotalRial - q.materialCashRial
            : null,
        materialCashRial: q.materialCashRial,
      })
      .returning();
    if (!made) throw new Error('credit application insert returned nothing');
    await this.recordMove(tx, actor, made, null, 'draft', null);
    await this.audit.record(
      {
        actor,
        action: 'credit.application_created',
        entityType: 'credit_application',
        entityId: made.id,
        after: {
          planCode: made.planCode,
          installmentCount: made.installmentCount,
          loanRial: made.loanRial.toString(),
          borrowerIsPatient: made.borrowerPersonId === made.patientPersonId,
          caseGroupId: made.caseGroupId,
        },
      },
      tx,
    );
    await this.publish(tx, 'credit.plan_selected', made);
    return made;
  }

  private async borrowerOf(proforma: ProformaRecord, mobileInput: string | undefined) {
    if (mobileInput === undefined) return proforma.personId;
    const mobile = normalizeMobile(mobileInput);
    if (mobile === null) throw new BadRequestException({ error: 'invalid_mobile' });
    const { personId } = await this.persons.findOrCreateByMobile(mobile);
    // Task 9-3: a pending mobile stands for nobody yet, so it borrows for nobody.
    if (personId === null) throw new ConflictException({ error: 'person_mobile_pending' });
    return personId;
  }

  /** ADR-050: the proforma's wage lines (W), as issued. */
  private async wageOf(proforma: ProformaRecord): Promise<bigint> {
    const lines = await this.proformas.lines(proforma.proformaId);
    return lines.filter((l) => l.costKind === 'wage').reduce((sum, l) => sum + l.lineTotalRial, 0n);
  }

  /** Applications on a proforma are made one at a time (the unique index is per borrower). */
  private async lockProforma(tx: Tx, proformaId: string) {
    const key = `credit.proforma:${proformaId}`;
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${key}))`);
  }

  private async openOn(tx: Tx, proformaId: string): Promise<boolean> {
    const [row] = await tx
      .select({ id: creditApplications.id })
      .from(creditApplications)
      .where(
        and(
          eq(creditApplications.proformaId, proformaId),
          notInArray(creditApplications.status, ['rejected', 'expired']),
          isNull(creditApplications.deletedAt),
        ),
      )
      .limit(1);
    return row !== undefined;
  }

  /** The rows of these the caller's scope reaches (staffApplication's rule). */
  private async visibleOf(access: EffectiveAccess, rows: readonly ApplicationRow[]) {
    const visible: ApplicationRow[] = [];
    for (const r of rows) {
      const reached = await this.staffApplication(access, r.id).then(
        () => true,
        () => false,
      );
      if (reached) visible.push(r);
    }
    return visible;
  }

  private async transition(
    actor: Actor,
    id: string,
    from: readonly Status[],
    to: Status,
    note: string | null,
    event: string,
    set: Partial<typeof creditApplications.$inferInsert>,
    after?: (tx: Tx, moved: ApplicationRow) => Promise<unknown>,
  ): Promise<ApplicationRow> {
    return this.db.transaction(async (tx) => {
      const [locked] = await tx
        .select()
        .from(creditApplications)
        .where(eq(creditApplications.id, id))
        .for('update');
      if (!locked) throw notFound();
      if (!from.includes(locked.status)) {
        throw new ConflictException({ error: 'wrong_status', status: locked.status });
      }
      const [moved] = await tx
        .update(creditApplications)
        .set({ ...set, status: to })
        .where(eq(creditApplications.id, id))
        .returning();
      if (!moved) throw new Error('credit application move returned nothing');
      await this.recordMove(tx, actor, moved, locked.status, to, note);
      await this.audit.record(
        {
          actor,
          action: 'credit.application_status_changed',
          entityType: 'credit_application',
          entityId: id,
          before: { status: locked.status },
          after: { status: to },
          reason: note,
        },
        tx,
      );
      await this.publish(tx, event, moved);
      if (after) await after(tx, moved);
      return moved;
    });
  }

  private async recordMove(
    tx: Tx,
    actor: Actor,
    row: ApplicationRow,
    from: Status | null,
    to: Status,
    note: string | null,
  ) {
    await tx.insert(creditApplicationStatusChanges).values({
      creditApplicationId: row.id,
      fromStatus: from,
      toStatus: to,
      actorAccountId: actor.accountId,
      note,
    });
  }

  private async publish(tx: Tx, type: string, row: ApplicationRow) {
    await this.outbox.publish(
      {
        type,
        aggregateType: 'credit_application',
        aggregateId: row.id,
        payload: { creditApplicationId: row.id, caseId: row.caseId, proformaId: row.proformaId },
      },
      tx,
    );
  }

  /** The plans of today's configuration that fit the proforma's city, field and doctor. */
  private async offeredPlans(proforma: ProformaRecord, now: Date) {
    const facts = await this.leads.caseFacts(proforma.caseId);
    if (!facts || facts.closed) throw new ConflictException({ error: 'case_closed' });
    const { value } = await this.config.resolve('credit.plans', {}, now);
    const day = gregorianDayOf(toJalali(now));
    return plansFor(value.plans, {
      cityCode: proforma.cityCode,
      treatmentFieldCode: facts.treatmentFieldCode,
      doctorId: proforma.doctorId,
      // ADR-048: the patient's membership, read only when some plan asks for it.
      clubMember: value.plans.some((p) => p.requiresClubMembership === true)
        ? (await this.leads.clubMembershipAt(proforma.personId, day)) !== null
        : false,
    });
  }

  /** The patient's own proforma, confirmed (doc 10 §2: only then may credit be asked). */
  private async confirmedProforma(accountId: string, proformaId: string): Promise<ProformaRecord> {
    const persons = await this.personsOf(accountId);
    const proforma = await this.proformas.proforma(proformaId);
    if (!proforma || !persons.includes(proforma.personId)) {
      throw new NotFoundException({ error: 'proforma_not_found' });
    }
    if (proforma.status !== 'patient_confirmed') {
      throw new ConflictException({ error: 'proforma_not_confirmed', status: proforma.status });
    }
    return proforma;
  }

  /** The persons this patient-kind account speaks for: theirs and everyone merged in. */
  async personsOf(accountId: string): Promise<string[]> {
    const account = await this.accounts.find(accountId);
    if (!account || account.kind !== 'patient')
      throw new ForbiddenException({ error: 'patients_only' });
    if (!account.personId) return [];
    return this.leads.samePersonIds(await this.leads.canonicalPersonId(account.personId));
  }

  /** An application whose patient or borrower is this account's person. */
  private async ownRow(accountId: string, id: string): Promise<ApplicationRow> {
    if (!UUID.test(id)) throw notFound();
    const persons = await this.personsOf(accountId);
    const [row] = await this.db
      .select()
      .from(creditApplications)
      .where(eq(creditApplications.id, id));
    if (
      !row ||
      (!persons.includes(row.patientPersonId) && !persons.includes(row.borrowerPersonId))
    ) {
      throw notFound();
    }
    return row;
  }

  /** Global scope reaches every application; a city scope those of its city. */
  async staffApplication(access: EffectiveAccess, id: string): Promise<ApplicationRow> {
    if (!UUID.test(id)) throw notFound();
    const [row] = await this.db
      .select()
      .from(creditApplications)
      .where(eq(creditApplications.id, id));
    if (!row) throw notFound();
    if (access.scopes.some((s) => s.kind === 'global')) return row;
    const cities = access.scopes.flatMap((s) => (s.kind === 'city' ? [s.code] : []));
    if (cities.length === 0) throw notFound();
    const proforma = await this.proformas.proforma(row.proformaId);
    if (!proforma || !cities.includes(proforma.cityCode)) throw notFound();
    return row;
  }

  private require(
    access: EffectiveAccess,
    permission: 'credit.read_applications' | 'credit.complete_applications',
  ) {
    if (!access.permissions.has(permission)) {
      throw new ForbiddenException({ error: 'permission_required', permission });
    }
  }
}

function uniqueToConflict(error: unknown): never {
  if (isUniqueViolation(error)) throw new ConflictException({ error: 'application_exists' });
  throw error;
}

async function newId(tx: Tx): Promise<string> {
  const result = await tx.execute(sql`SELECT uuidv7() AS id`);
  return result.rows[0]?.['id'] as string;
}

function groupView(caseGroupId: string, rows: readonly ApplicationRow[]): CreditGroupView {
  return {
    caseGroupId,
    members: rows.map((r) => ({
      id: r.id,
      caseId: r.caseId,
      proformaId: r.proformaId,
      status: r.status,
      borrowerIsPatient: r.borrowerPersonId === r.patientPersonId,
      shareRial: r.proformaTotalRial.toString(),
      loanRial: r.loanRial.toString(),
      approvedAmountRial: r.approvedAmountRial?.toString() ?? null,
      shortfallKind: r.shortfallKind,
      createdAt: r.createdAt.toISOString(),
    })),
  };
}

function isUniqueViolation(error: unknown): boolean {
  const e = error as { code?: string; cause?: { code?: string } };
  return e.code === '23505' || e.cause?.code === '23505';
}

function quoteView({ quote: q }: LockedQuote) {
  return {
    downPaymentRial: q.downPaymentRial.toString(),
    financeableRial: q.financeableRial.toString(),
    loanRial: q.loanRial.toString(),
    cashTopUpRial: q.cashTopUpRial.toString(),
    materialCashRial: q.materialCashRial.toString(),
    planFeeRial: q.planFeeRial.toString(),
    planFeeTiming: q.planFeeTiming,
    originationFeeRial: q.originationFeeRial.toString(),
    dueAtCompletionRial: q.dueAtCompletionRial.toString(),
    totalObligationRial: q.totalObligationRial.toString(),
    totalPayableRial: q.totalPayableRial.toString(),
    installments: q.installments.map((i) => ({
      index: i.index,
      dueOn: i.dueOn,
      amountRial: i.amountRial.toString(),
    })),
  };
}

function view(row: ApplicationRow): CreditApplicationView {
  return {
    id: row.id,
    caseId: row.caseId,
    proformaId: row.proformaId,
    status: row.status,
    borrowerIsPatient: row.borrowerPersonId === row.patientPersonId,
    planCode: row.planCode,
    planTitle: row.planTitle,
    installmentCount: row.installmentCount,
    proformaTotalRial: row.proformaTotalRial.toString(),
    downPaymentRial: row.downPaymentRial.toString(),
    loanRial: row.loanRial.toString(),
    cashTopUpRial: row.cashTopUpRial.toString(),
    materialCashRial: row.materialCashRial.toString(),
    planFeeRial: row.planFeeRial.toString(),
    planFeeTiming: row.planFeeTiming,
    originationFeeRial: row.originationFeeRial.toString(),
    totalObligationRial: row.totalObligationRial.toString(),
    needsMoreGuarantors: row.needsMoreGuarantors,
    caseGroupId: row.caseGroupId,
    approvedCashTopUpRial: row.approvedCashTopUpRial?.toString() ?? null,
    shortfallKind: row.shortfallKind,
    approvedAmountRial: row.approvedAmountRial?.toString() ?? null,
    conditions: row.conditions,
    submittedAt: row.submittedAt?.toISOString() ?? null,
    slaDueAt: row.slaDueAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
  };
}

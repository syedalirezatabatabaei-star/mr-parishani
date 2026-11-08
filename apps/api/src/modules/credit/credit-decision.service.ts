import { FINANCIAL_STEP_UP, type FinancialStepUp } from '../../common/auth/step-up.port';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  DECISION_AUTHORITIES,
  type DecisionAuthority,
  type PermissionCode,
  type ProposeCreditDecisionInput,
  type ScoringOutcome,
} from '@sepehr/contracts';
import { and, asc, desc, eq, inArray, ne, notInArray } from 'drizzle-orm';
import type { EffectiveAccess } from '../../common/auth/access.port';
import { AUDIT_LOG, type Actor, type AuditLog } from '../../common/audit/audit.port';
import { CONFIG, type ConfigPort } from '../../common/config/config.port';
import { OUTBOX, type OutboxPort } from '../../common/events/outbox.port';
import { LEAD_CASES, type LeadCases } from '../../common/lead/lead-cases.port';
import { DATABASE, type Database } from '../../db/database.module';
import { CreditApplicationService } from './credit-application.service';
import { CreditDocumentService } from './credit-document.service';
import { BorrowerCapExceeded } from '../../common/credit/borrower-exposure.port';
import { BorrowerExposureService } from './borrower-exposure.service';
import { CreditPlanService, type LockedQuote } from './credit-plan.service';
import { CreditQueueService } from './credit-queue.service';
import { CreditScoringService } from './credit-scoring.service';
import {
  creditApplicationAssignments,
  creditApplications,
  creditApplicationStatusChanges,
  creditCommitteeVotes,
  creditConsents,
  creditCostSplitReviews,
  creditDecisions,
  creditGuarantors,
} from './credit.schema';

type Tx = Parameters<Parameters<Database['transaction']>[0]>[0];
type ApplicationRow = typeof creditApplications.$inferSelect;
type DecisionRow = typeof creditDecisions.$inferSelect;
type VoteRow = typeof creditCommitteeVotes.$inferSelect;
type Status = ApplicationRow['status'];
type ProposeInput = ProposeCreditDecisionInput;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const decisionNotFound = () => new NotFoundException({ error: 'credit_decision_not_found' });
const APPROVALS = ['approved', 'conditional'] as const;
const isApproval = (o: string): o is (typeof APPROVALS)[number] =>
  (APPROVALS as readonly string[]).includes(o);

/** Who confirms what the engine's authority decides (doc 10 §6). */
const CONFIRMER: Readonly<Record<'expert_second_check' | 'credit_manager', PermissionCode>> = {
  expert_second_check: 'credit.decide_second_check',
  credit_manager: 'credit.decide_manager',
};

function authorityOf(outcome: ScoringOutcome): DecisionAuthority {
  const code = outcome.authority?.authority;
  if (!code || !(DECISION_AUTHORITIES as readonly string[]).includes(code)) {
    throw new Error(`the rules name an unknown decision authority: ${String(code)}`);
  }
  return code as DecisionAuthority;
}

/**
 * Credit decisions (task 3-6; doc 10 §6; doc 03 §6). The engine names who decides and the
 * application keeps it: a person never chooses it. Every decision is proposed with a
 * reason and becomes final only through that authority:
 *
 * - the credit specialist and a second person (`credit.decide_second_check`), never the
 *   same one (doc 10 §10 test 9);
 * - the credit manager (`credit.decide_manager`);
 * - the committee: approving votes of members of at least `minUnits` units, each a
 *   different person (test 9); one objection refuses the proposal;
 * - a rejecting grade or a stop: no approval at all, even by a direct call (test 8); only
 *   a rejection, or an exception out of the matrix.
 *
 * Out of the matrix (doc 03 §6, doc 04 §5): an approval the engine does not allow, only by
 * `credit.decide_out_of_matrix`, confirmed by a second such person and by the committee,
 * and labelled `out_of_matrix` in the history.
 *
 * A reduced approved amount is levelled again by the engine, and the authority with it
 * (doc 03 §4; test 7). No ledger entry (doc 10 §1).
 */
@Injectable()
export class CreditDecisionService {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(AUDIT_LOG) private readonly audit: AuditLog,
    @Inject(OUTBOX) private readonly outbox: OutboxPort,
    @Inject(CONFIG) private readonly config: ConfigPort,
    @Inject(LEAD_CASES) private readonly leads: LeadCases,
    private readonly applications: CreditApplicationService,
    private readonly scoring: CreditScoringService,
    private readonly documents: CreditDocumentService,
    private readonly plans: CreditPlanService,
    private readonly queues: CreditQueueService,
    private readonly exposure: BorrowerExposureService,
    @Inject(FINANCIAL_STEP_UP) private readonly stepUp: FinancialStepUp,
  ) {}

  // --- to the decision ----------------------------------------------------------------

  /**
   * The credit specialist sends a scored application to its decision (`manual_review`):
   * every guarantor consented, scored and documented first (task 3-5 decision). The
   * engine's authority is locked on it; the committee's go to the committee queue.
   */
  async toDecision(actor: Actor, access: EffectiveAccess, id: string) {
    this.require(access, 'credit.propose_decision');
    const reached = await this.applications.staffApplication(access, id);
    const missing = await this.gaps(reached);
    if (missing.length > 0) throw new ConflictException({ error: 'not_complete', missing });
    const committeeKey = {
      ...(await this.queues.keyFor(reached, 'committee')),
      queueCode: 'committee' as const,
    };
    await this.db.transaction(async (tx) => {
      const app = await this.lockApplication(tx, reached.id);
      if (app.status !== 'ready_for_review' && app.status !== 'scoring') {
        throw new ConflictException({ error: 'wrong_status', status: app.status });
      }
      const outcome = await this.scoring.assess(tx, app, app.loanRial);
      if (outcome === null || outcome.authority === null) {
        throw new ConflictException({ error: 'not_complete', missing: ['score:borrower'] });
      }
      const authority = authorityOf(outcome);
      if (app.status === 'ready_for_review') {
        await this.move(tx, actor, app, 'scoring', {}, 'sent to decision');
      }
      const moved = await this.move(
        tx,
        actor,
        { ...app, status: 'scoring' },
        'manual_review',
        this.engineColumns(outcome, authority),
        'sent to decision',
      );
      await this.audit.record(
        {
          actor,
          action: 'credit.sent_to_decision',
          entityType: 'credit_application',
          entityId: app.id,
          after: {
            authority,
            amountLevel: outcome.amountLevel?.level ?? null,
            sufficiency: outcome.sufficiency.outcome,
          },
        },
        tx,
      );
      if (authority === 'committee') await this.queues.assign(tx, actor, moved, committeeKey);
    });
    return this.page(access, reached.id);
  }

  // --- proposals ----------------------------------------------------------------------

  async propose(actor: Actor, access: EffectiveAccess, id: string, input: ProposeInput) {
    const outOfMatrix = input.outOfMatrix === true;
    if (outOfMatrix) {
      // The credit specialist may not decide out of the matrix (doc 04 §3).
      this.require(access, 'credit.decide_out_of_matrix');
    } else if (
      !access.permissions.has('credit.propose_decision') &&
      !access.permissions.has('credit.decide_manager')
    ) {
      throw new ForbiddenException({ error: 'permission_required' });
    }
    await this.checkShape(input, outOfMatrix);
    const reached = await this.applications.staffApplication(access, id);
    const missing = isApproval(input.outcome) ? await this.gaps(reached) : [];
    if (isApproval(input.outcome)) {
      // ADR-052: proposing an approved amount is signed with the proposer's own SMS code.
      await this.stepUp.assert(actor, {
        type: 'credit_decision',
        id: reached.id,
        amountRial: input.approvedAmountRial ?? reached.loanRial,
        step: 'request',
      });
    }
    if (missing.length > 0) throw new ConflictException({ error: 'not_complete', missing });
    const now = new Date();
    const committeeKey = {
      ...(await this.queues.keyFor(reached, 'committee')),
      queueCode: 'committee' as const,
    };

    const decisionId = await this.db
      .transaction(async (tx) => {
        const app = await this.lockApplication(tx, reached.id);
        if (app.status !== 'manual_review') {
          throw new ConflictException({ error: 'wrong_status', status: app.status });
        }
        if (app.rulesetVersionId === null) throw new Error('a decided application has rules');
        const amount = isApproval(input.outcome)
          ? (input.approvedAmountRial ?? app.loanRial)
          : app.loanRial;
        if (amount > app.loanRial) {
          throw new BadRequestException({ error: 'amount_above_loan' });
        }
        const outcome = await this.scoring.assess(tx, app, amount);
        if (outcome === null) throw new Error('a decided application has a borrower sheet');
        const engine = authorityOf(outcome);

        let authority: DecisionAuthority = engine;
        if (isApproval(input.outcome)) {
          const within =
            engine !== 'reject_no_override' &&
            !['insufficient', 'not_reviewable', 'incomplete'].includes(outcome.sufficiency.outcome);
          if (!outOfMatrix && engine === 'reject_no_override') {
            // A rejecting grade or a stop is never approved in the normal path (test 8).
            throw new ConflictException({ error: 'approval_not_allowed', authority: engine });
          }
          if (!outOfMatrix && !within) {
            throw new ConflictException({
              error: 'out_of_matrix_required',
              sufficiency: outcome.sufficiency.outcome,
            });
          }
          if (outOfMatrix && within) throw new ConflictException({ error: 'within_matrix' });
          if (outOfMatrix) authority = 'committee';
        } else if (outOfMatrix) {
          throw new BadRequestException({ error: 'out_of_matrix_is_an_approval' });
        } else if (engine === 'reject_no_override') {
          // The rejection the rules impose: a proposal and a second check.
          authority = 'expert_second_check';
        }
        if (
          authority === 'committee' &&
          input.outcome !== 'needs_more_guarantors' &&
          input.committee === undefined
        ) {
          throw new BadRequestException({ error: 'committee_minutes_required' });
        }

        const quote = isApproval(input.outcome) ? await this.quoteFor(app, amount, now) : null;
        const [made] = await tx
          .insert(creditDecisions)
          .values({
            creditApplicationId: app.id,
            outcome: input.outcome,
            authority,
            rulesetVersionId: app.rulesetVersionId,
            outOfMatrix,
            approvedAmountRial: isApproval(input.outcome) ? amount : null,
            amountLevel: outcome.amountLevel?.level ?? null,
            quote: quote ? quoteJson(quote) : null,
            conditions: input.outcome === 'conditional' ? (input.conditions ?? null) : null,
            missing: input.outcome === 'needs_more_guarantors' ? (input.missing ?? null) : null,
            reasonCode: input.outcome === 'rejected' ? (input.reasonCode ?? null) : null,
            reason: input.reason,
            minutesNumber:
              authority === 'committee' ? (input.committee?.minutesNumber ?? null) : null,
            meetingAt:
              authority === 'committee' && input.committee
                ? new Date(input.committee.meetingAt)
                : null,
            attendeeAccountIds:
              authority === 'committee' && input.committee
                ? [...new Set(input.committee.attendeeAccountIds)]
                : null,
            proposedBy: actor.accountId ?? '',
          })
          .returning();
        if (!made) throw new Error('credit decision insert returned nothing');

        // What the engine says for this amount is the application's now (doc 03 §4).
        if (isApproval(input.outcome)) {
          await tx
            .update(creditApplications)
            .set(this.engineColumns(outcome, engine))
            .where(eq(creditApplications.id, app.id));
        }
        await this.audit.record(
          {
            actor,
            action: 'credit.decision_proposed',
            entityType: 'credit_application',
            entityId: app.id,
            before: { authority: app.decisionAuthority, amountLevel: app.amountLevel },
            after: {
              decisionId: made.id,
              outcome: made.outcome,
              authority,
              outOfMatrix,
              approvedAmountRial: made.approvedAmountRial?.toString() ?? null,
              amountLevel: made.amountLevel,
            },
            reason: input.reason,
          },
          tx,
        );
        await this.publish(tx, 'credit.decision_proposed', app, { decisionId: made.id });
        if (authority === 'committee' && !(await this.inCommitteeQueue(tx, app.id))) {
          await this.queues.assign(tx, actor, app, committeeKey);
        }

        // Final at once: a return for more guarantors (not a credit decision), and the
        // credit manager deciding where the engine names the credit manager.
        if (
          input.outcome === 'needs_more_guarantors' ||
          (authority === 'credit_manager' && access.permissions.has('credit.decide_manager'))
        ) {
          await this.finalize(tx, actor, app, made, now);
        }
        return made.id;
      })
      .catch((error: unknown) => {
        if (isUniqueViolation(error)) throw new ConflictException({ error: 'decision_pending' });
        throw error;
      });
    return this.decisionView(access, await this.decisionRow(reached.id, decisionId));
  }

  /** The second check, the credit manager, or the second approver out of the matrix. */
  async confirm(actor: Actor, access: EffectiveAccess, id: string, decisionId: string) {
    const reached = await this.applications.staffApplication(access, id);
    const now = new Date();
    await this.db
      .transaction(async (tx) => {
        // ADR-051: the borrower's row first, then the application (the order funding keeps too).
        await this.exposure.lockBorrower(tx, reached.borrowerPersonId);
        const app = await this.lockApplication(tx, reached.id);
        const decision = await this.lockOpenDecision(tx, app.id, decisionId);
        if (isApproval(decision.outcome)) {
          // ADR-052: confirming an approved amount, with the confirmer's own SMS code.
          await this.stepUp.assert(actor, {
            type: 'credit_decision',
            id: decisionId,
            amountRial: decision.approvedAmountRial,
            step: 'approve',
          });
        }
        if (decision.proposedBy === actor.accountId) {
          // Two people, never one (doc 04 §5; doc 10 §10 test 9).
          throw new ConflictException({ error: 'same_person' });
        }
        if (decision.outOfMatrix) {
          this.require(access, 'credit.decide_out_of_matrix');
          if (decision.checkedBy !== null)
            throw new ConflictException({ error: 'already_checked' });
          const [checked] = await tx
            .update(creditDecisions)
            .set({ checkedBy: actor.accountId, checkedAt: now })
            .where(eq(creditDecisions.id, decision.id))
            .returning();
          if (!checked) throw new Error('credit decision check returned nothing');
          await this.audit.record(
            {
              actor,
              action: 'credit.decision_checked',
              entityType: 'credit_application',
              entityId: app.id,
              after: { decisionId: decision.id, outOfMatrix: true },
            },
            tx,
          );
          if (await this.quorum(tx, checked)) await this.finalize(tx, actor, app, checked, now);
          return;
        }
        if (decision.authority === 'committee') {
          throw new ConflictException({ error: 'committee_decides' });
        }
        this.require(access, CONFIRMER[decision.authority as keyof typeof CONFIRMER]);
        const [checked] = await tx
          .update(creditDecisions)
          .set({ checkedBy: actor.accountId, checkedAt: now })
          .where(eq(creditDecisions.id, decision.id))
          .returning();
        if (!checked) throw new Error('credit decision check returned nothing');
        await this.finalize(tx, actor, app, checked, now);
      })
      .catch((error: unknown) => this.refused(error));
    return this.decisionView(access, await this.decisionRow(reached.id, decisionId));
  }

  /** A committee member's vote, for a unit of their roles (doc 03 §6). */
  async vote(
    actor: Actor,
    access: EffectiveAccess,
    id: string,
    decisionId: string,
    input: { unitCode: string; vote: 'approve' | 'object'; note?: string | undefined },
  ) {
    this.require(access, 'credit.committee_vote');
    const reached = await this.applications.staffApplication(access, id);
    const units = (await this.config.resolve('credit.committee_units')).value;
    const unit = units.units.find((u) => u.code === input.unitCode);
    if (!unit) throw new BadRequestException({ error: 'unknown_unit' });
    if (!unit.roleCodes.some((r) => access.roles.includes(r))) {
      throw new ForbiddenException({ error: 'not_a_unit_member' });
    }
    const now = new Date();
    await this.db
      .transaction(async (tx) => {
        // ADR-051: the borrower's row first, then the application.
        await this.exposure.lockBorrower(tx, reached.borrowerPersonId);
        const app = await this.lockApplication(tx, reached.id);
        const decision = await this.lockOpenDecision(tx, app.id, decisionId);
        if (decision.authority !== 'committee') {
          throw new ConflictException({ error: 'not_a_committee_decision' });
        }
        // Owner 1405/08/01: whoever proposed it may sit in the meeting but never votes, for or
        // against (an objection would refuse it alone). Votes already cast stay (rule 7).
        if (decision.proposedBy === actor.accountId) {
          throw new ConflictException({ error: 'proposer_cannot_vote' });
        }
        if (!(decision.attendeeAccountIds ?? []).includes(access.accountId)) {
          throw new ForbiddenException({ error: 'not_an_attendee' });
        }
        await tx.insert(creditCommitteeVotes).values({
          creditDecisionId: decision.id,
          accountId: access.accountId,
          unitCode: unit.code,
          vote: input.vote,
          note: input.note ?? null,
        });
        await this.audit.record(
          {
            actor,
            action: 'credit.committee_voted',
            entityType: 'credit_application',
            entityId: app.id,
            after: { decisionId: decision.id, unitCode: unit.code, vote: input.vote },
            reason: input.note ?? null,
          },
          tx,
        );
        await this.publish(tx, 'credit.committee_voted', app, { decisionId: decision.id });
        if (input.vote === 'object') {
          // TODO(decision): majority or veto; the cautious default: one objection refuses it.
          await this.close(tx, actor, app, decision, 'refused', `رأی مخالف کمیته: ${unit.label}`);
          return;
        }
        if (await this.quorum(tx, decision)) await this.finalize(tx, actor, app, decision, now);
      })
      .catch((error: unknown) => {
        if (isUniqueViolation(error)) throw new ConflictException({ error: 'already_voted' });
        return this.refused(error);
      });
    return this.decisionView(access, await this.decisionRow(reached.id, decisionId));
  }

  /** The proposer takes it back, or a confirmer refuses it; with a reason, either way. */
  async closeProposal(
    actor: Actor,
    access: EffectiveAccess,
    id: string,
    decisionId: string,
    reason: string,
  ) {
    const reached = await this.applications.staffApplication(access, id);
    await this.db.transaction(async (tx) => {
      const app = await this.lockApplication(tx, reached.id);
      const decision = await this.lockOpenDecision(tx, app.id, decisionId);
      if (decision.proposedBy === actor.accountId) {
        await this.close(tx, actor, app, decision, 'withdrawn', reason);
        return;
      }
      const may = decision.outOfMatrix
        ? access.permissions.has('credit.decide_out_of_matrix')
        : decision.authority === 'committee'
          ? false
          : access.permissions.has(CONFIRMER[decision.authority as keyof typeof CONFIRMER]);
      if (!may) throw new ForbiddenException({ error: 'permission_required' });
      await this.close(tx, actor, app, decision, 'refused', reason);
    });
    return this.decisionView(access, await this.decisionRow(reached.id, decisionId));
  }

  // --- reading ------------------------------------------------------------------------

  /**
   * The decision page. Reasons ride in `decisionReasons` and the engine's words in
   * `creditScore`, which the output layer strips from whoever lacks the permission
   * (doc 04 §4; FieldFilterInterceptor).
   */
  async page(access: EffectiveAccess, id: string) {
    this.require(access, 'credit.read_applications');
    const app = await this.applications.staffApplication(access, id);
    const rows = await this.db
      .select()
      .from(creditDecisions)
      .where(eq(creditDecisions.creditApplicationId, app.id))
      .orderBy(desc(creditDecisions.createdAt));
    const votes = await this.votesOf(rows.map((r) => r.id));
    return {
      creditApplicationId: app.id,
      status: app.status,
      authority: app.decisionAuthority as DecisionAuthority | null,
      decision: app.decision,
      approvedAmountRial: app.approvedAmountRial?.toString() ?? null,
      conditions: app.conditions,
      decidedAt: app.decidedAt?.toISOString() ?? null,
      creditScore: {
        borrowerGrade: app.borrowerGrade,
        amountLevel: app.amountLevel,
        guaranteeRequirement: app.guaranteeRequirement,
        sufficiency: app.sufficiency,
      },
      decisions: rows.map((r) => decisionView(r, votes)),
      // What the forms offer (task 3-8): the editable reasons and the committee's units.
      rejectionReasons: (await this.config.resolve('credit.rejection_reasons')).value.reasons,
      committeeUnits: (await this.config.resolve('credit.committee_units')).value.units.map(
        (u) => ({ code: u.code, label: u.label }),
      ),
    };
  }

  // --- helpers ------------------------------------------------------------------------

  /** What must hold before a decision: the borrower graded; each guarantor complete. */
  private async gaps(app: ApplicationRow): Promise<string[]> {
    const missing: string[] = [];
    if (app.borrowerGrade === null) missing.push('score:borrower');
    const guarantors = await this.db
      .select()
      .from(creditGuarantors)
      .where(
        and(
          eq(creditGuarantors.creditApplicationId, app.id),
          ne(creditGuarantors.status, 'withdrawn'),
        ),
      )
      .orderBy(asc(creditGuarantors.createdAt));
    const consents = await this.db
      .select({ personId: creditConsents.personId })
      .from(creditConsents)
      .where(
        and(eq(creditConsents.creditApplicationId, app.id), eq(creditConsents.role, 'guarantor')),
      );
    for (const g of guarantors) {
      if (!consents.some((c) => c.personId === g.personId))
        missing.push(`consent:guarantor:${g.id}`);
      if (g.status !== 'scored') missing.push(`score:guarantor:${g.id}`);
    }
    // ADR-050: a wage-only application waits for its wage and materials split to be checked.
    if (app.wageRial !== null) {
      const [review] = await this.db
        .select({ id: creditCostSplitReviews.id })
        .from(creditCostSplitReviews)
        .where(eq(creditCostSplitReviews.creditApplicationId, app.id));
      if (!review) missing.push('cost_split_review');
    }
    return [...missing, ...(await this.documents.missingRequired(app))];
  }

  /** Validates what the outcome needs, before anything is read or locked. */
  private async checkShape(input: ProposeInput, outOfMatrix: boolean) {
    const has = (v: unknown) => v !== undefined;
    const wrong = (field: string) => new BadRequestException({ error: 'invalid_field', field });
    if (has(input.conditions) !== (input.outcome === 'conditional')) throw wrong('conditions');
    if (has(input.missing) !== (input.outcome === 'needs_more_guarantors')) throw wrong('missing');
    if (has(input.reasonCode) !== (input.outcome === 'rejected')) throw wrong('reasonCode');
    if (has(input.approvedAmountRial) && !isApproval(input.outcome)) {
      throw wrong('approvedAmountRial');
    }
    if (outOfMatrix && !isApproval(input.outcome)) throw wrong('outOfMatrix');
    if (input.reasonCode !== undefined) {
      const reasons = (await this.config.resolve('credit.rejection_reasons')).value.reasons;
      if (!reasons.some((r) => r.code === input.reasonCode)) {
        throw new BadRequestException({ error: 'unknown_rejection_reason' });
      }
    }
  }

  /** The preview of the approved amount, with the application's locked versions (rule 16). */
  private quoteFor(app: ApplicationRow, amount: bigint, now: Date): Promise<LockedQuote> {
    return this.plans.quote(
      app.planCode,
      {
        proformaTotalRial: app.proformaTotalRial,
        installmentCount: app.installmentCount,
        requestedAmountRial: amount,
        wageRial: app.wageRial ?? undefined,
      },
      {
        plansVersionId: app.plansVersionId,
        roundingVersionId: app.roundingVersionId,
        reductionVersionId: app.reductionVersionId,
        shiftVersionId: app.shiftVersionId,
        graceVersionId: app.graceVersionId,
      },
      now,
      { staffAmount: true },
    );
  }

  private engineColumns(outcome: ScoringOutcome, authority: DecisionAuthority) {
    return {
      decisionAuthority: authority,
      amountLevel: outcome.amountLevel?.level ?? null,
      guaranteeRequirement: outcome.requirement?.label ?? null,
      sufficiency: outcome.sufficiency.outcome,
    };
  }

  /** Approving votes cover enough units; out of the matrix, the second approver too. */
  private async quorum(tx: Tx, decision: DecisionRow): Promise<boolean> {
    if (decision.outOfMatrix && decision.checkedBy === null) return false;
    const { minUnits } = (await this.config.resolve('credit.committee_units')).value;
    const votes = await tx
      .select()
      .from(creditCommitteeVotes)
      .where(eq(creditCommitteeVotes.creditDecisionId, decision.id));
    if (votes.some((v) => v.vote === 'object')) return false;
    const units = new Set(votes.filter((v) => v.vote === 'approve').map((v) => v.unitCode));
    return units.size >= minUnits;
  }

  /** The decision becomes the application's (one transaction, the application locked). */
  private async finalize(
    tx: Tx,
    actor: Actor,
    app: ApplicationRow,
    decision: DecisionRow,
    now: Date,
  ) {
    await tx
      .update(creditDecisions)
      .set({ status: 'decided', closedBy: actor.accountId, closedAt: now })
      .where(eq(creditDecisions.id, decision.id));
    const note = decision.outOfMatrix
      ? `decision ${decision.id} (out_of_matrix)`
      : `decision ${decision.id}`;
    if (decision.outcome === 'needs_more_guarantors') {
      // A label on `incomplete`, not a status (doc 10 §4); case completion works it again.
      const moved = await this.move(
        tx,
        actor,
        app,
        'incomplete',
        { needsMoreGuarantors: true },
        note,
      );
      const key = await this.queues.keyFor(moved, 'completion');
      await this.queues.assign(tx, actor, moved, { ...key, queueCode: 'completion' });
    } else {
      const outcome = decision.outcome;
      // ADR-051: an approval stays within the borrower's cap (the borrower's row is locked).
      if (outcome !== 'rejected' && decision.approvedAmountRial !== null) {
        await this.exposure.check(tx, app.id, decision.approvedAmountRial, 'decision');
      }
      await this.move(
        tx,
        actor,
        app,
        outcome,
        {
          decision: outcome,
          approvedAmountRial: decision.approvedAmountRial,
          conditions: decision.conditions,
          decidedBy: actor.accountId,
          decidedAt: now,
          ...(outcome === 'rejected' ? {} : await this.shortfall(decision)),
        },
        note,
      );
      // A rejection closes the case, unless another application of its group still
      // finances it there (doc 10 §7: one member's rejection leaves the other unchanged).
      if (outcome === 'rejected' && !(await this.siblingOnCase(tx, app))) {
        await this.leads.closeCase(tx, actor, app.caseId, 'credit_rejected', null);
      }
    }
    await this.audit.record(
      {
        actor,
        action: 'credit.decided',
        entityType: 'credit_application',
        entityId: app.id,
        after: {
          decisionId: decision.id,
          outcome: decision.outcome,
          authority: decision.authority,
          approvedAmountRial: decision.approvedAmountRial?.toString() ?? null,
          ...(decision.outOfMatrix ? { label: 'out_of_matrix' } : {}),
        },
        reason: decision.reason,
      },
      tx,
    );
    await this.publish(tx, 'credit.decided', app, {
      decisionId: decision.id,
      outcome: decision.outcome,
    });
  }

  /**
   * What the approved amount leaves to pay in cash (the decision's preview), and whether it
   * is small: at most `credit.small_shortfall_bps` of the approved amount, paid at the
   * doctor outside the ledger; beyond it, a new case and loan (doc 10 §7; task 3-7).
   */
  private async shortfall(decision: DecisionRow) {
    const stored = decision.quote as { cashTopUpRial?: string; materialCashRial?: string } | null;
    // ADR-050: the materials are the doctor's in cash by design, never a shortfall.
    const topUp = BigInt(stored?.cashTopUpRial ?? '0') - BigInt(stored?.materialCashRial ?? '0');
    const approved = decision.approvedAmountRial ?? 0n;
    const bps = BigInt((await this.config.resolve('credit.small_shortfall_bps')).value);
    const kind: 'none' | 'small' | 'large' =
      topUp === 0n ? 'none' : topUp * 10_000n <= approved * bps ? 'small' : 'large';
    return { approvedCashTopUpRial: topUp, shortfallKind: kind };
  }

  /** ADR-051: a refusal by the cap is recorded on its own, after the decision rolled back. */
  private async refused(error: unknown): Promise<never> {
    if (error instanceof BorrowerCapExceeded) await this.exposure.recordRefusal(error.refusal);
    throw error;
  }

  /** Another application of the group on the same case, not rejected or expired. */
  private async siblingOnCase(tx: Tx, app: ApplicationRow): Promise<boolean> {
    if (app.caseGroupId === null) return false;
    const [row] = await tx
      .select({ id: creditApplications.id })
      .from(creditApplications)
      .where(
        and(
          eq(creditApplications.caseGroupId, app.caseGroupId),
          eq(creditApplications.caseId, app.caseId),
          ne(creditApplications.id, app.id),
          notInArray(creditApplications.status, ['rejected', 'expired']),
        ),
      )
      .limit(1);
    return row !== undefined;
  }

  private async close(
    tx: Tx,
    actor: Actor,
    app: ApplicationRow,
    decision: DecisionRow,
    status: 'refused' | 'withdrawn',
    reason: string,
  ) {
    await tx
      .update(creditDecisions)
      .set({ status, closedBy: actor.accountId, closeReason: reason, closedAt: new Date() })
      .where(eq(creditDecisions.id, decision.id));
    await this.audit.record(
      {
        actor,
        action: `credit.decision_${status}`,
        entityType: 'credit_application',
        entityId: app.id,
        after: { decisionId: decision.id },
        reason,
      },
      tx,
    );
    await this.publish(tx, 'credit.decision_closed', app, { decisionId: decision.id });
  }

  private async move(
    tx: Tx,
    actor: Actor,
    app: ApplicationRow,
    to: Status,
    set: Partial<typeof creditApplications.$inferInsert>,
    note: string,
  ): Promise<ApplicationRow> {
    const [moved] = await tx
      .update(creditApplications)
      .set({ ...set, status: to })
      .where(eq(creditApplications.id, app.id))
      .returning();
    if (!moved) throw new Error('credit application move returned nothing');
    await tx.insert(creditApplicationStatusChanges).values({
      creditApplicationId: app.id,
      fromStatus: app.status,
      toStatus: to,
      actorAccountId: actor.accountId,
      note,
    });
    await this.audit.record(
      {
        actor,
        action: 'credit.application_status_changed',
        entityType: 'credit_application',
        entityId: app.id,
        before: { status: app.status },
        after: { status: to },
        reason: note,
      },
      tx,
    );
    return moved;
  }

  private async inCommitteeQueue(tx: Tx, appId: string): Promise<boolean> {
    const [row] = await tx
      .select({ id: creditApplicationAssignments.id })
      .from(creditApplicationAssignments)
      .where(
        and(
          eq(creditApplicationAssignments.creditApplicationId, appId),
          eq(creditApplicationAssignments.queueCode, 'committee'),
        ),
      )
      .limit(1);
    return row !== undefined;
  }

  private async lockApplication(tx: Tx, id: string): Promise<ApplicationRow> {
    const [app] = await tx
      .select()
      .from(creditApplications)
      .where(eq(creditApplications.id, id))
      .for('update');
    if (!app) throw new NotFoundException({ error: 'credit_application_not_found' });
    return app;
  }

  private async lockOpenDecision(tx: Tx, appId: string, decisionId: string) {
    if (!UUID.test(decisionId)) throw decisionNotFound();
    const [decision] = await tx
      .select()
      .from(creditDecisions)
      .where(
        and(eq(creditDecisions.id, decisionId), eq(creditDecisions.creditApplicationId, appId)),
      )
      .for('update');
    if (!decision) throw decisionNotFound();
    if (decision.status !== 'proposed') {
      throw new ConflictException({ error: 'decision_closed', status: decision.status });
    }
    return decision;
  }

  private async decisionRow(appId: string, decisionId: string): Promise<DecisionRow> {
    const [row] = await this.db
      .select()
      .from(creditDecisions)
      .where(
        and(eq(creditDecisions.id, decisionId), eq(creditDecisions.creditApplicationId, appId)),
      );
    if (!row) throw decisionNotFound();
    return row;
  }

  private async decisionView(_access: EffectiveAccess, row: DecisionRow) {
    return decisionView(row, await this.votesOf([row.id]));
  }

  private async votesOf(ids: readonly string[]): Promise<VoteRow[]> {
    if (ids.length === 0) return [];
    return this.db
      .select()
      .from(creditCommitteeVotes)
      .where(inArray(creditCommitteeVotes.creditDecisionId, [...ids]))
      .orderBy(asc(creditCommitteeVotes.createdAt));
  }

  private async publish(
    tx: Tx,
    type: string,
    app: ApplicationRow,
    extra: Readonly<Record<string, string>>,
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
          ...extra,
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

function isUniqueViolation(error: unknown): boolean {
  const e = error as { code?: string; cause?: { code?: string } };
  return e.code === '23505' || e.cause?.code === '23505';
}

/** The preview as stored and shown: amounts as text (JSON has no bigint). */
function quoteJson({ quote: q }: LockedQuote) {
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
    percentRoundingRial: q.percentRoundingRial?.toString() ?? null,
    installments: q.installments.map((i) => ({
      index: i.index,
      dueOn: i.dueOn,
      amountRial: i.amountRial.toString(),
    })),
  };
}

function decisionView(r: DecisionRow, votes: readonly VoteRow[]) {
  return {
    id: r.id,
    outcome: r.outcome,
    status: r.status,
    authority: r.authority as DecisionAuthority,
    outOfMatrix: r.outOfMatrix,
    approvedAmountRial: r.approvedAmountRial?.toString() ?? null,
    quote: (r.quote as ReturnType<typeof quoteJson> | null) ?? null,
    conditions: r.conditions,
    missing: r.missing,
    decisionReasons: { reasonCode: r.reasonCode, reason: r.reason },
    creditScore: { amountLevel: r.amountLevel },
    committee:
      r.minutesNumber !== null && r.meetingAt !== null
        ? {
            minutesNumber: r.minutesNumber,
            meetingAt: r.meetingAt.toISOString(),
            attendeeAccountIds: r.attendeeAccountIds ?? [],
            votes: votes
              .filter((v) => v.creditDecisionId === r.id)
              .map((v) => ({
                accountId: v.accountId,
                unitCode: v.unitCode,
                vote: v.vote,
                at: v.createdAt.toISOString(),
              })),
          }
        : null,
    proposedBy: r.proposedBy,
    checkedBy: r.checkedBy,
    closedBy: r.closedBy,
    createdAt: r.createdAt.toISOString(),
    closedAt: r.closedAt?.toISOString() ?? null,
  };
}

import { FINANCIAL_STEP_UP, type FinancialStepUp } from '../../common/auth/step-up.port';
import {
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { CostSplitState, recordCostSplitReviewSchema } from '@sepehr/contracts';
import { eq } from 'drizzle-orm';
import type { z } from 'zod';
import type { EffectiveAccess } from '../../common/auth/access.port';
import { AUDIT_LOG, type Actor, type AuditLog } from '../../common/audit/audit.port';
import {
  PROFORMA_DIRECTORY,
  type ProformaDirectory,
} from '../../common/proforma/proforma-directory.port';
import { DATABASE, type Database } from '../../db/database.module';
import { creditApplications, creditCostSplitReviews } from './credit.schema';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const REVIEW = 'credit.review_cost_split' as const;
const READ = 'credit.read_applications' as const;
/** Before the decision only: once decided, the split is what the decision was made on. */
const OPEN = ['incomplete', 'ready_for_review', 'scoring', 'manual_review'];

const isUniqueViolation = (error: unknown) => {
  const e = error as { code?: string; cause?: { code?: string } } | null;
  return e?.code === '23505' || e?.cause?.code === '23505';
};

/**
 * ADR-050: a wage-only application's split of wage and materials, checked once by credit or
 * case completion (`credit.review_cost_split`) before its decision, with a note; the decision
 * waits for it (`cost_split_review`). The split itself is the issued proforma's, locked on the
 * application; this only records that someone in finance looked at it. Append-only.
 */
@Injectable()
export class CostSplitReviewService {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(AUDIT_LOG) private readonly audit: AuditLog,
    @Inject(PROFORMA_DIRECTORY) private readonly proformas: ProformaDirectory,
    @Inject(FINANCIAL_STEP_UP) private readonly stepUp: FinancialStepUp,
  ) {}

  async state(access: EffectiveAccess, creditApplicationId: string): Promise<CostSplitState> {
    if (!access.permissions.has(REVIEW) && !access.permissions.has(READ)) {
      throw new ForbiddenException({ error: 'permission_required' });
    }
    const app = await this.reachable(access, creditApplicationId);
    const [review] = await this.db
      .select()
      .from(creditCostSplitReviews)
      .where(eq(creditCostSplitReviews.creditApplicationId, app.id));
    return {
      wageOnly: app.wageRial !== null,
      wageRial: app.wageRial?.toString() ?? null,
      materialCashRial: app.materialCashRial.toString(),
      review: review
        ? {
            reviewedBy: review.reviewedBy,
            note: review.note,
            reviewedAt: review.createdAt.toISOString(),
          }
        : null,
    };
  }

  async record(
    actor: Actor,
    access: EffectiveAccess,
    creditApplicationId: string,
    input: z.output<typeof recordCostSplitReviewSchema>,
  ): Promise<CostSplitState> {
    if (!access.permissions.has(REVIEW)) {
      throw new ForbiddenException({ error: 'permission_required', permission: REVIEW });
    }
    if (actor.accountId === null) throw new ForbiddenException({ error: 'staff_only' });
    const reviewedBy = actor.accountId;
    const app = await this.reachable(access, creditApplicationId);
    if (app.wageRial === null) throw new ConflictException({ error: 'not_wage_only' });
    if (!OPEN.includes(app.status)) {
      throw new ConflictException({ error: 'application_decided', status: app.status });
    }
    // ADR-050 amendment (owner 1405/08/01): whoever drafted or issued the split never checks it.
    const proforma = await this.proformas.proforma(app.proformaId);
    if (proforma && (proforma.issuedBy === reviewedBy || proforma.createdBy === reviewedBy)) {
      throw new ConflictException({ error: 'reviewer_is_issuer' });
    }
    // ADR-052: one person, with their own SMS code: the split sets what may be lent.
    await this.stepUp.assert(actor, {
      type: 'cost_split_review',
      id: app.id,
      amountRial: app.wageRial,
      step: 'approve',
    });
    await this.db
      .transaction(async (tx) => {
        const [made] = await tx
          .insert(creditCostSplitReviews)
          .values({ creditApplicationId: app.id, reviewedBy, note: input.note })
          .returning();
        if (!made) throw new Error('cost split review insert returned nothing');
        await this.audit.record(
          {
            actor,
            action: 'credit.cost_split_reviewed',
            entityType: 'credit_application',
            entityId: app.id,
            before: null,
            after: {
              wageRial: app.wageRial?.toString() ?? null,
              materialCashRial: app.materialCashRial.toString(),
            },
            reason: input.note,
          },
          tx,
        );
      })
      .catch((error: unknown) => {
        if (isUniqueViolation(error)) throw new ConflictException({ error: 'already_reviewed' });
        throw error;
      });
    return this.state(access, app.id);
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
}

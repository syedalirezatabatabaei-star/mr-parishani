import { FINANCIAL_STEP_UP, type FinancialStepUp } from '../../common/auth/step-up.port';
import {
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type {
  PermissionCode,
  proposeVisitTariffSchema,
  VisitTariffProposalStatus,
  VisitTariffProposalView,
} from '@sepehr/contracts';
import { and, desc, eq, isNull } from 'drizzle-orm';
import type { z } from 'zod';
import type { EffectiveAccess } from '../../common/auth/access.port';
import { AUDIT_LOG, type Actor, type AuditLog } from '../../common/audit/audit.port';
import { DATABASE, type Database } from '../../db/database.module';
import { centers, doctors, doctorWorkplaces, visitTariffProposals } from './catalog.schema';
import { TariffService } from './tariff.service';

type Tx = Parameters<Parameters<Database['transaction']>[0]>[0];
type ProposalRow = typeof visitTariffProposals.$inferSelect;

const MANAGE: PermissionCode = 'catalog.manage_visit_tariffs';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const isUniqueViolation = (error: unknown) => {
  const e = error as { code?: string; cause?: { code?: string } } | null;
  return e?.code === '23505' || e?.cause?.code === '23505';
};

interface Place {
  readonly workplaceId: string;
  readonly doctorId: string;
  readonly doctorName: string;
  readonly placeName: string | null;
  readonly cityCode: string;
}

/**
 * A doctor's visit price from the internal panel, by two people (owner 1405/07/29, answer i).
 * One holder of catalog.manage_visit_tariffs proposes it for a workplace their global or city
 * scope covers; another approves it, which writes the visit's tariff version through
 * TariffService.setApprovedVisit in the same transaction, or rejects it. Never the proposer
 * (403 here, a CHECK in the database). No ledger row: the visit is paid at the center.
 */
@Injectable()
export class VisitTariffProposalService {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(AUDIT_LOG) private readonly audit: AuditLog,
    private readonly tariffs: TariffService,
    @Inject(FINANCIAL_STEP_UP) private readonly stepUp: FinancialStepUp,
  ) {}

  async propose(
    actor: Actor,
    access: EffectiveAccess,
    input: z.output<typeof proposeVisitTariffSchema>,
  ): Promise<VisitTariffProposalView> {
    this.require(access);
    const accountId = this.accountOf(actor);
    const place = await this.place(access, input.workplaceId);
    // ADR-052: a visit price is a financial setting; the proposer signs with an SMS code.
    await this.stepUp.assert(actor, {
      type: 'visit_tariff',
      id: place.workplaceId,
      amountRial: input.pricing.kind === 'free' ? null : input.pricing.maxRial,
      step: 'request',
    });
    const row = await this.db
      .transaction(async (tx) => {
        const [made] = await tx
          .insert(visitTariffProposals)
          .values({
            workplaceId: place.workplaceId,
            isFree: input.pricing.kind === 'free',
            minAmountRial: input.pricing.kind === 'free' ? 0n : input.pricing.minRial,
            maxAmountRial: input.pricing.kind === 'free' ? 0n : input.pricing.maxRial,
            effectiveAt: input.effectiveAt === undefined ? null : new Date(input.effectiveAt),
            reason: input.reason,
            requestedBy: accountId,
          })
          .returning();
        if (!made) throw new Error('visit tariff proposal insert returned nothing');
        await this.audit.record(
          {
            actor: { ...actor, onBehalfOfDoctorId: place.doctorId },
            action: 'catalog.visit_tariff_proposed',
            entityType: 'visit_tariff_proposal',
            entityId: made.id,
            before: null,
            after: this.pricingOf(made),
            reason: input.reason,
          },
          tx,
        );
        return made;
      })
      .catch((error: unknown) => {
        if (isUniqueViolation(error)) throw new ConflictException({ error: 'proposal_open' });
        throw error;
      });
    return this.view(row, place, accountId);
  }

  async list(
    actor: Actor,
    access: EffectiveAccess,
    query: { status?: VisitTariffProposalStatus | undefined },
  ): Promise<VisitTariffProposalView[]> {
    this.require(access);
    const rows = await this.db
      .select()
      .from(visitTariffProposals)
      .where(query.status ? eq(visitTariffProposals.status, query.status) : undefined)
      .orderBy(desc(visitTariffProposals.createdAt))
      .limit(500);
    const out: VisitTariffProposalView[] = [];
    for (const row of rows) {
      const place = await this.place(access, row.workplaceId).catch(() => null);
      if (place) out.push(this.view(row, place, actor.accountId));
    }
    return out;
  }

  async approve(
    actor: Actor,
    access: EffectiveAccess,
    id: string,
    reason: string,
  ): Promise<VisitTariffProposalView> {
    return this.decide(actor, access, id, reason, true);
  }

  async reject(
    actor: Actor,
    access: EffectiveAccess,
    id: string,
    reason: string,
  ): Promise<VisitTariffProposalView> {
    return this.decide(actor, access, id, reason, false);
  }

  // --- helpers -------------------------------------------------------------------------

  private async decide(
    actor: Actor,
    access: EffectiveAccess,
    id: string,
    reason: string,
    approve: boolean,
  ): Promise<VisitTariffProposalView> {
    this.require(access);
    const accountId = this.accountOf(actor);
    if (!UUID.test(id)) throw new NotFoundException({ error: 'proposal_not_found' });
    const [found] = await this.db
      .select({ workplaceId: visitTariffProposals.workplaceId })
      .from(visitTariffProposals)
      .where(eq(visitTariffProposals.id, id));
    if (!found) throw new NotFoundException({ error: 'proposal_not_found' });
    if (approve) {
      // ADR-052: the approver's own SMS code for this proposal.
      await this.stepUp.assert(actor, {
        type: 'visit_tariff',
        id,
        amountRial: null,
        step: 'approve',
      });
    }
    const place = await this.place(access, found.workplaceId).catch((error: unknown) => {
      throw error instanceof NotFoundException
        ? new NotFoundException({ error: 'proposal_not_found' })
        : error;
    });
    const row = await this.db.transaction(async (tx) => {
      const proposal = await this.lock(tx, id);
      if (proposal.status !== 'pending') throw new ConflictException({ error: 'already_decided' });
      if (proposal.requestedBy === accountId) {
        throw new ForbiddenException({ error: 'second_person_required' });
      }
      const tariffVersionId = approve
        ? await this.tariffs.setApprovedVisit(tx, actor, {
            workplaceId: proposal.workplaceId,
            pricing: proposal.isFree
              ? { kind: 'free' }
              : {
                  kind: 'range',
                  minRial: proposal.minAmountRial,
                  maxRial: proposal.maxAmountRial,
                },
            effectiveAt: proposal.effectiveAt,
            reason: proposal.reason,
          })
        : null;
      const [after] = await tx
        .update(visitTariffProposals)
        .set({
          status: approve ? 'approved' : 'rejected',
          decidedBy: accountId,
          decidedAt: new Date(),
          decisionReason: reason,
          tariffVersionId,
        })
        .where(eq(visitTariffProposals.id, id))
        .returning();
      if (!after) throw new Error('visit tariff proposal update returned nothing');
      await this.audit.record(
        {
          actor: { ...actor, onBehalfOfDoctorId: place.doctorId },
          action: approve ? 'catalog.visit_tariff_approved' : 'catalog.visit_tariff_rejected',
          entityType: 'visit_tariff_proposal',
          entityId: id,
          before: { status: 'pending' },
          after: { status: after.status, tariffVersionId, ...this.pricingOf(after) },
          reason,
        },
        tx,
      );
      return after;
    });
    return this.view(row, place, accountId);
  }

  private require(access: EffectiveAccess) {
    if (!access.permissions.has(MANAGE)) {
      throw new ForbiddenException({ error: 'permission_required', permission: MANAGE });
    }
  }

  private accountOf(actor: Actor): string {
    if (actor.accountId === null) throw new ForbiddenException({ error: 'staff_only' });
    return actor.accountId;
  }

  private async lock(tx: Tx, id: string): Promise<ProposalRow> {
    const [row] = await tx
      .select()
      .from(visitTariffProposals)
      .where(eq(visitTariffProposals.id, id))
      .for('update');
    if (!row) throw new NotFoundException({ error: 'proposal_not_found' });
    return row;
  }

  /** The workplace if the caller's global or city scope covers it; otherwise 404 (rule 13). */
  private async place(access: EffectiveAccess, workplaceId: string): Promise<Place> {
    const missing = () => new NotFoundException({ error: 'workplace_not_found' });
    if (!UUID.test(workplaceId)) throw missing();
    const [row] = await this.db
      .select({
        workplaceId: doctorWorkplaces.id,
        cityCode: doctorWorkplaces.cityCode,
        doctorId: doctors.id,
        doctorName: doctors.name,
        placeName: centers.name,
      })
      .from(doctorWorkplaces)
      .innerJoin(doctors, eq(doctors.id, doctorWorkplaces.doctorId))
      .leftJoin(centers, eq(centers.id, doctorWorkplaces.centerId))
      .where(
        and(
          eq(doctorWorkplaces.id, workplaceId),
          isNull(doctorWorkplaces.deletedAt),
          isNull(doctors.deletedAt),
        ),
      );
    if (!row) throw missing();
    const covers = access.scopes.some(
      (s) => s.kind === 'global' || (s.kind === 'city' && s.code === row.cityCode),
    );
    if (!covers) throw missing();
    return row;
  }

  private pricingOf(row: ProposalRow) {
    return {
      workplaceId: row.workplaceId,
      isFree: row.isFree,
      minAmountRial: row.minAmountRial.toString(),
      maxAmountRial: row.maxAmountRial.toString(),
      effectiveAt: row.effectiveAt?.toISOString() ?? null,
    };
  }

  private view(row: ProposalRow, place: Place, viewer: string | null): VisitTariffProposalView {
    return {
      id: row.id,
      workplaceId: row.workplaceId,
      doctor: { id: place.doctorId, name: place.doctorName },
      placeName: place.placeName,
      cityCode: place.cityCode,
      isFree: row.isFree,
      minAmountRial: row.minAmountRial.toString(),
      maxAmountRial: row.maxAmountRial.toString(),
      effectiveAt: row.effectiveAt?.toISOString() ?? null,
      reason: row.reason,
      status: row.status,
      requestedAt: row.createdAt.toISOString(),
      requestedByMe: viewer !== null && row.requestedBy === viewer,
      decidedAt: row.decidedAt?.toISOString() ?? null,
      decisionReason: row.decisionReason,
      tariffVersionId: row.tariffVersionId,
    };
  }
}

import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  addJalaliMonths,
  fromJalali,
  normalizeMobile,
  originationReduction,
  type grantOriginationDiscountSchema,
  type OriginationDiscountCandidate,
  type OriginationDiscountReportRow,
  type OriginationDiscountView,
} from '@sepehr/contracts';
import { and, asc, eq, gte, lt, sql } from 'drizzle-orm';
import type { z } from 'zod';
import type { EffectiveAccess } from '../../common/auth/access.port';
import { AUDIT_LOG, type Actor, type AuditLog } from '../../common/audit/audit.port';
import {
  CREDIT_CONTRACT_FACTS,
  type CreditContractFacts,
  type CreditContractFactsPort,
} from '../../common/credit/credit-contract-facts.port';
import { LEAD_CASES, type LeadCases } from '../../common/lead/lead-cases.port';
import { PAYMENT_PROVIDER, type PaymentProvider } from '../../common/payment/payment-provider.port';
import {
  PROFORMA_DIRECTORY,
  type ProformaDirectory,
} from '../../common/proforma/proforma-directory.port';
import { DATABASE, type Database } from '../../db/database.module';
import { caseCompletions, originationDiscounts, originationFeeReductions } from './contract.schema';
import { OriginationFeeService, originationView } from './origination-fee.service';

type Tx = Parameters<Parameters<Database['transaction']>[0]>[0];

const GRANT = 'contract.grant_origination_discount' as const;
const READ = 'contract.read_origination_discounts' as const;
const APPROVED = ['approved', 'conditional'];

const isUniqueViolation = (error: unknown) => {
  const e = error as { code?: string; cause?: { code?: string } } | null;
  return e?.code === '23505' || e?.cause?.code === '23505';
};

/**
 * ADR-048: an officer's discount on an application's origination fee (the annex's note 2): a
 * completion or club officer, under their own signature, with no second person (owner
 * 1405/07/29), at most the locked plan's `originationOfficerDiscountBps`. Once per application,
 * and only while the fee is live: refused once its receipt is uploaded or the application is
 * completed. The signed file is kept like a receipt (private space, real type, ClamAV). The
 * monthly list is for accounting and the CEO.
 */
@Injectable()
export class OriginationDiscountService {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(AUDIT_LOG) private readonly audit: AuditLog,
    @Inject(CREDIT_CONTRACT_FACTS) private readonly credit: CreditContractFactsPort,
    @Inject(PROFORMA_DIRECTORY) private readonly proformas: ProformaDirectory,
    @Inject(PAYMENT_PROVIDER) private readonly payments: PaymentProvider,
    @Inject(LEAD_CASES) private readonly leads: LeadCases,
    private readonly fees: OriginationFeeService,
  ) {}

  /**
   * Owner 1405/08/02 (plan item ب): the club officer, who cannot open the completion page, finds
   * a person's applications by mobile whose fee may still take a discount: approved, not
   * completed, the fee not locked, inside the officer's scope. Only what the discount needs.
   */
  async candidates(
    access: EffectiveAccess,
    mobileInput: string,
  ): Promise<OriginationDiscountCandidate[]> {
    if (!access.permissions.has(GRANT)) {
      throw new ForbiddenException({ error: 'permission_required', permission: GRANT });
    }
    const mobile = normalizeMobile(mobileInput);
    if (mobile === null) throw new BadRequestException({ error: 'invalid_mobile' });
    const personId = await this.leads.personByMobile(mobile);
    if (personId === null) return [];
    const out: OriginationDiscountCandidate[] = [];
    for (const id of await this.credit.applicationsOf([personId])) {
      const facts = await this.reachable(access, id).catch(() => null);
      if (!facts || !APPROVED.includes(facts.status)) continue;
      const owed = await this.fees.now(facts);
      if (!owed || owed.locked) continue;
      const [done] = await this.db
        .select({ id: caseCompletions.creditApplicationId })
        .from(caseCompletions)
        .where(eq(caseCompletions.creditApplicationId, id));
      if (done) continue;
      const discount = owed.discount ? await this.fees.discountView(owed.discount) : null;
      const origination = originationView(owed, discount);
      if (!origination) continue;
      out.push({ creditApplicationId: id, planTitle: facts.planTitle, origination });
    }
    return out;
  }

  async grant(
    actor: Actor,
    access: EffectiveAccess,
    creditApplicationId: string,
    input: z.output<typeof grantOriginationDiscountSchema>,
    file: { buffer: Buffer; size: number } | undefined,
  ): Promise<OriginationDiscountView> {
    if (!access.permissions.has(GRANT)) {
      throw new ForbiddenException({ error: 'permission_required', permission: GRANT });
    }
    if (actor.accountId === null) throw new ForbiddenException({ error: 'staff_only' });
    const grantedBy = actor.accountId;
    if (!file) throw new BadRequestException({ error: 'file_required' });
    const facts = await this.reachable(access, creditApplicationId);
    if (!APPROVED.includes(facts.status)) {
      throw new ConflictException({ error: 'not_approved', status: facts.status });
    }
    this.fees.checkDiscount(facts, input.discountBps);
    await this.assertLive(facts);

    const idRow = await this.db.execute(sql`SELECT uuidv7() AS id`);
    const discountId = idRow.rows[0]?.['id'] as string;
    const evidence = await this.payments.keepEvidence(
      `origination-discounts/${facts.creditApplicationId}/${discountId}`,
      file.buffer,
    );
    const row = await this.db
      .transaction(async (tx) => {
        await this.fees.lock(tx, facts.creditApplicationId);
        await this.assertLive(facts, tx);
        const [made] = await tx
          .insert(originationDiscounts)
          .values({
            id: discountId,
            creditApplicationId: facts.creditApplicationId,
            discountBps: input.discountBps,
            grantedBy,
            reason: input.reason,
            ...evidence,
          })
          .returning();
        if (!made) throw new Error('origination discount insert returned nothing');
        await this.audit.record(
          {
            actor,
            action: 'contract.origination_discount_granted',
            entityType: 'credit_application',
            entityId: facts.creditApplicationId,
            before: null,
            after: { discountId: made.id, discountBps: made.discountBps, sha256: made.sha256 },
            reason: input.reason,
          },
          tx,
        );
        return made;
      })
      .catch((error: unknown) => {
        if (isUniqueViolation(error)) throw new ConflictException({ error: 'discount_exists' });
        throw error;
      });
    return this.fees.discountView(row);
  }

  /** A Jalali month's discounts (`1405-07`), oldest first, with the reduction each made. */
  async month(access: EffectiveAccess, month: string): Promise<OriginationDiscountReportRow[]> {
    if (!access.permissions.has(READ)) {
      throw new ForbiddenException({ error: 'permission_required', permission: READ });
    }
    const [year, m] = month.split('-').map(Number) as [number, number];
    const start = { year, month: m, day: 1 };
    const rows = await this.db
      .select()
      .from(originationDiscounts)
      .where(
        and(
          gte(originationDiscounts.createdAt, fromJalali(start)),
          lt(originationDiscounts.createdAt, fromJalali(addJalaliMonths(start, 1))),
        ),
      )
      .orderBy(asc(originationDiscounts.createdAt));
    const out: OriginationDiscountReportRow[] = [];
    for (const r of rows) {
      const locked = await this.fees.lockedOf(r.creditApplicationId);
      const reduction = locked?.row && locked.row.discountId === r.id ? locked.row : null;
      out.push({
        ...(await this.fees.discountView(r)),
        // The discount's own part: the net with it removed, minus the net with it.
        reductionRial: reduction
          ? ((await this.discountPart(reduction))?.toString() ?? null)
          : null,
      });
    }
    return out;
  }

  // --- helpers -------------------------------------------------------------------------

  /**
   * The discount's own part of what was taken off: the net with the waiver alone, minus the
   * locked net, from the locked plan and the cheque count locked with it (exact, same rounding).
   */
  private async discountPart(
    r: typeof originationFeeReductions.$inferSelect,
  ): Promise<bigint | null> {
    const facts = await this.credit.facts(r.creditApplicationId);
    const plan = facts?.origination?.plan;
    if (!plan) return null;
    const withoutDiscount = originationReduction(plan, {
      feeRial: r.feeRial,
      baseRial: r.baseRial,
      checkedBorrowerCheques: r.chequeCount,
      discountBps: 0,
    }).netRial;
    return withoutDiscount - r.netRial;
  }

  /** Refused once the fee is locked (its receipt uploaded) or the application completed. */
  private async assertLive(facts: CreditContractFacts, ex: Database | Tx = this.db) {
    if (await this.fees.lockedOf(facts.creditApplicationId, ex)) {
      throw new ConflictException({ error: 'origination_already_locked' });
    }
    const [done] = await ex
      .select({ id: caseCompletions.creditApplicationId })
      .from(caseCompletions)
      .where(eq(caseCompletions.creditApplicationId, facts.creditApplicationId));
    if (done) throw new ConflictException({ error: 'already_completed' });
  }

  private async reachable(access: EffectiveAccess, creditApplicationId: string) {
    const facts = await this.credit.facts(creditApplicationId);
    if (!facts) throw new NotFoundException({ error: 'credit_application_not_found' });
    if (access.scopes.some((s) => s.kind === 'global')) return facts;
    const cities = access.scopes.flatMap((s) => (s.kind === 'city' ? [s.code] : []));
    const proforma = await this.proformas.proforma(facts.proformaId);
    if (!proforma || !cities.includes(proforma.cityCode)) {
      throw new NotFoundException({ error: 'credit_application_not_found' });
    }
    return facts;
  }
}

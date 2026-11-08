import { ConflictException, Inject, Injectable } from '@nestjs/common';
import {
  originationReduction,
  QuoteError,
  type OriginationDiscountView,
  type OriginationOwed,
} from '@sepehr/contracts';
import { and, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import { ACCOUNT_DIRECTORY, type AccountDirectory } from '../../common/auth/account-directory.port';
import type { CreditContractFacts } from '../../common/credit/credit-contract-facts.port';
import {
  DELIVERY_STATUS,
  type DeliveryStatusPort,
} from '../../common/instrument/delivery-status.port';
import { DATABASE, type Database } from '../../db/database.module';
import {
  completionReceipts,
  originationDiscounts,
  originationFeeReductions,
} from './contract.schema';

type Tx = Parameters<Parameters<Database['transaction']>[0]>[0];
type Ex = Tx | Database;
type DiscountRow = typeof originationDiscounts.$inferSelect;
type ReductionRow = typeof originationFeeReductions.$inferSelect;

/** What is owed, with what the lock row needs; amounts as bigint. */
export interface OriginationNow {
  readonly feeRial: bigint;
  readonly baseRial: bigint;
  readonly chequeCount: number;
  readonly minCheques: number | null;
  readonly waiverBps: number;
  readonly discountBps: number;
  readonly maxDiscountBps: number;
  readonly netRial: bigint;
  readonly locked: boolean;
  readonly discount: DiscountRow | null;
  readonly plansVersionId: string | null;
}

/**
 * ADR-048: the origination fee an application owes after the cheque waiver and the officer's
 * discount. Live until it is locked: with the receipt uploaded for it (its expected amount), or
 * at completion when nothing is left to pay; then later cheques, bounced or new, change nothing
 * (owner 1405/07/29, answer d). The application's own advisory lock serializes a discount and an
 * upload. No ledger row: the receipt's approval posts the net, as before (doc 02 §4).
 */
@Injectable()
export class OriginationFeeService {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(DELIVERY_STATUS) private readonly deliveries: DeliveryStatusPort,
    @Inject(ACCOUNT_DIRECTORY) private readonly accounts: AccountDirectory,
  ) {}

  /** A discount as staff see it, with the officer's name. */
  async discountView(row: DiscountRow): Promise<OriginationDiscountView> {
    const name = this.accounts.nameOf ? await this.accounts.nameOf(row.grantedBy) : null;
    return {
      id: row.id,
      creditApplicationId: row.creditApplicationId,
      discountBps: row.discountBps,
      grantedBy: row.grantedBy,
      grantedByName: name,
      reason: row.reason,
      createdAt: row.createdAt.toISOString(),
    };
  }

  /** One writer of an application's origination fee at a time, until the transaction ends. */
  async lock(tx: Tx, creditApplicationId: string) {
    const key = `contract.origination:${creditApplicationId}`;
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${key}, 0))`);
  }

  async discountOf(creditApplicationId: string, ex: Ex = this.db): Promise<DiscountRow | null> {
    const [row] = await ex
      .select()
      .from(originationDiscounts)
      .where(eq(originationDiscounts.creditApplicationId, creditApplicationId));
    return row ?? null;
  }

  /**
   * What locked the fee, or null while it is live: the origination receipt pending or approved
   * (with its lock row; a receipt from before ADR-048 has none and keeps its expected amount),
   * else the row made at completion when nothing was left to pay.
   */
  async lockedOf(
    creditApplicationId: string,
    ex: Ex = this.db,
  ): Promise<{ row: ReductionRow | null; expectedRial: bigint } | null> {
    const [open] = await ex
      .select({ id: completionReceipts.id, expectedRial: completionReceipts.expectedRial })
      .from(completionReceipts)
      .where(
        and(
          eq(completionReceipts.creditApplicationId, creditApplicationId),
          eq(completionReceipts.kind, 'origination_fee'),
          inArray(completionReceipts.status, ['pending_approval', 'approved']),
          isNull(completionReceipts.deletedAt),
        ),
      );
    const [row] = await ex
      .select()
      .from(originationFeeReductions)
      .where(
        and(
          eq(originationFeeReductions.creditApplicationId, creditApplicationId),
          open
            ? eq(originationFeeReductions.receiptId, open.id)
            : isNull(originationFeeReductions.receiptId),
        ),
      )
      .orderBy(desc(originationFeeReductions.createdAt))
      .limit(1);
    if (open) return { row: row ?? null, expectedRial: open.expectedRial };
    return row ? { row, expectedRial: row.netRial } : null;
  }

  /** What is owed now; null when the application owes no origination fee at all. */
  async now(facts: CreditContractFacts, ex: Ex = this.db): Promise<OriginationNow | null> {
    const feeRial = facts.originationFeeRial;
    if (feeRial <= 0n) return null;
    const id = facts.creditApplicationId;
    const discount = await this.discountOf(id, ex);
    const locked = await this.lockedOf(id, ex);
    const plan = facts.origination?.plan;
    const minCheques = plan?.originationChequeWaiver?.minCheques ?? null;
    if (locked) {
      const r = locked.row;
      return {
        feeRial: r?.feeRial ?? feeRial,
        baseRial: r?.baseRial ?? facts.origination?.baseRial ?? feeRial,
        chequeCount: r?.chequeCount ?? 0,
        minCheques,
        waiverBps: r?.waiverBps ?? 0,
        discountBps: r?.discountBps ?? 0,
        maxDiscountBps: 0,
        netRial: locked.expectedRial,
        locked: true,
        discount,
        plansVersionId: r?.plansVersionId ?? null,
      };
    }
    const cheques = await this.deliveries.checkedCheques(id);
    const chequeCount = cheques.filter((c) => c.role === 'borrower').length;
    if (!facts.origination || !plan) {
      // No locked plan to read (defensive): the fee as quoted, nothing off.
      return {
        feeRial,
        baseRial: feeRial,
        chequeCount,
        minCheques: null,
        waiverBps: 0,
        discountBps: 0,
        maxDiscountBps: 0,
        netRial: feeRial,
        locked: false,
        discount,
        plansVersionId: null,
      };
    }
    const r = originationReduction(plan, {
      feeRial,
      baseRial: facts.origination.baseRial,
      checkedBorrowerCheques: chequeCount,
      discountBps: discount?.discountBps ?? 0,
    });
    return {
      feeRial,
      baseRial: facts.origination.baseRial,
      chequeCount,
      minCheques,
      waiverBps: r.waiverBps,
      discountBps: r.discountBps,
      maxDiscountBps: discount ? 0 : (plan.originationOfficerDiscountBps ?? 0),
      netRial: r.netRial,
      locked: false,
      discount,
      plansVersionId: facts.origination.plansVersionId,
    };
  }

  /**
   * Locks what is owed, in the caller's transaction (holding {@link lock}): with the receipt
   * uploaded for it, or with none when nothing is left to pay (at completion). Once per receipt;
   * once without one (unique indexes).
   */
  async lockOwed(
    tx: Tx,
    facts: CreditContractFacts,
    owed: OriginationNow,
    receiptId: string | null,
  ): Promise<void> {
    if (owed.locked) return;
    if (owed.plansVersionId === null) return;
    if (receiptId === null && owed.netRial !== 0n) {
      throw new Error('only nothing left to pay is locked without a receipt');
    }
    await tx.insert(originationFeeReductions).values({
      creditApplicationId: facts.creditApplicationId,
      receiptId,
      plansVersionId: owed.plansVersionId,
      feeRial: owed.feeRial,
      baseRial: owed.baseRial,
      chequeCount: owed.chequeCount,
      waiverBps: owed.waiverBps,
      discountId: owed.discountBps > 0 ? (owed.discount?.id ?? null) : null,
      discountBps: owed.discountBps,
      netRial: owed.netRial,
    });
  }

  /** The plan's check of a discount, as the API's refusal. */
  checkDiscount(facts: CreditContractFacts, discountBps: number) {
    const origination = facts.origination;
    if (!origination) throw new ConflictException({ error: 'discount_not_in_plan' });
    try {
      originationReduction(origination.plan, {
        feeRial: facts.originationFeeRial,
        baseRial: origination.baseRial,
        checkedBorrowerCheques: 0,
        discountBps,
      });
    } catch (error) {
      if (error instanceof QuoteError) throw new ConflictException({ error: error.code });
      throw error;
    }
  }
}

/** The breakdown as the API shows it; `staff` adds who granted the discount. */
export function originationView(
  owed: OriginationNow | null,
  discount: OriginationDiscountView | null,
): OriginationOwed | null {
  if (!owed) return null;
  return {
    feeRial: owed.feeRial.toString(),
    baseRial: owed.baseRial.toString(),
    chequeCount: owed.chequeCount,
    minCheques: owed.minCheques,
    waiverBps: owed.waiverBps,
    discountBps: owed.discountBps,
    maxDiscountBps: owed.maxDiscountBps,
    netRial: owed.netRial.toString(),
    locked: owed.locked,
    discount,
  };
}

import { ConflictException } from '@nestjs/common';
import type { SqlExecutor } from '../audit/audit.port';

/**
 * Port to the credit module (ADR-051, ج۶): the cap on a borrower's whole active balance, for the
 * two places a loan becomes the borrower's: its decision (credit) and its funding (wallet). Both
 * lock the borrower's row first, in their own transaction, then check; so two of one borrower's
 * decisions or fundings never pass the cap together. Provided under {@link BORROWER_EXPOSURE}.
 */
export type ExposureStep = 'decision' | 'funding';

export interface ExposureRefusal {
  readonly creditApplicationId: string;
  readonly step: ExposureStep;
  readonly exposureRial: bigint;
  readonly amountRial: bigint;
  readonly capRial: bigint;
  readonly basis: 'obligation' | 'loan';
  readonly includeApprovedUnfunded: boolean;
  readonly configVersionId: string;
}

/** 409 `borrower_exposure_cap_exceeded`; carries what the refusal row records. */
export class BorrowerCapExceeded extends ConflictException {
  constructor(readonly refusal: ExposureRefusal) {
    super({
      error: 'borrower_exposure_cap_exceeded',
      exposureRial: refusal.exposureRial.toString(),
      amountRial: refusal.amountRial.toString(),
      capRial: refusal.capRial.toString(),
    });
  }
}

export interface BorrowerExposurePort {
  /** The borrower's Person row (merged into its canonical one) FOR UPDATE, in `tx`. First. */
  lockBorrower(tx: SqlExecutor, borrowerPersonId: string): Promise<void>;
  /**
   * Under that lock: the borrower's active balance, without this application, plus `amountRial`,
   * must stay within the cap, else {@link BorrowerCapExceeded}. Off (cap 0): nothing is read or
   * written. Within it: the check is recorded in `tx`.
   */
  check(
    tx: SqlExecutor,
    creditApplicationId: string,
    amountRial: bigint,
    step: ExposureStep,
  ): Promise<void>;
  /** A refusal, recorded in a transaction of its own after the caller's has rolled back. */
  recordRefusal(refusal: ExposureRefusal): Promise<void>;
}

export const BORROWER_EXPOSURE = Symbol('BORROWER_EXPOSURE');

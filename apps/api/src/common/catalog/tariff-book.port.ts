import type { SqlExecutor } from '../audit/audit.port';

/**
 * Port to the tariffs of the catalog module (task 2-4, doc 08 §4, ADR-024): what booking
 * (task 2-6) and later modules may know about a price without reading its tables. The
 * catalog module provides it under {@link TARIFF_BOOK}.
 */

/** One version of a tariff: immutable once it has started. Amounts in rials (rule 1). */
export interface TariffQuote {
  readonly tariffVersionId: string;
  readonly tariffId: string;
  /** Whose tariff answered: the workplace's own, or the center's when it has none. */
  readonly source: 'workplace' | 'center';
  readonly serviceId: string;
  readonly serviceCode: string;
  /** ADR-050: the service's cost kind now (the doctor's wage or materials). */
  readonly costKind: 'wage' | 'material';
  readonly isFree: boolean;
  readonly minAmountRial: bigint;
  readonly maxAmountRial: bigint;
  readonly effectiveAt: Date;
}

export interface TariffBook {
  /**
   * The price of a service at a doctor's workplace at `at`: the workplace's own tariff
   * whenever it has a version in force, else its center's (task 2-4 decision: the
   * workplace always wins, even when its version withdraws the service). Null when the
   * service is not offered there at that moment. A booking stores `tariffVersionId`, so a
   * later price change never reaches it. Runs in `tx` when given one.
   */
  quote(
    workplaceId: string,
    serviceCode: string,
    at: Date,
    tx?: SqlExecutor,
  ): Promise<TariffQuote | null>;
  /** One version by id, as it was quoted; null if unknown or not a price. */
  version(tariffVersionId: string): Promise<TariffQuote | null>;
}

export const TARIFF_BOOK = Symbol('TARIFF_BOOK');

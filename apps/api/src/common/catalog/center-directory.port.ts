import type { SqlExecutor } from '../audit/audit.port';

/**
 * Port to the centers of the catalog module (task 2-2): what other modules may know about
 * a center without reading its tables. The catalog module provides it under
 * {@link CENTER_DIRECTORY}.
 */
export interface CenterDirectory {
  /**
   * Whether new appointments may be made at this center or branch node (doc 08 §3): only
   * an active center. Suspended and terminated centers take none; what happens to their
   * existing appointments follows the `catalog.center_suspended` and
   * `catalog.center_terminated` events. Unknown nodes are not bookable.
   */
  isBookable(nodeId: string): Promise<boolean>;

  /**
   * Where a center is paid (task 5-5): its Sheba, decrypted, and the account holder; null
   * when it has none (or there is no such center). Whatever its status: a suspended or
   * terminated center is still paid for what it did before (doc 08 §3). Never logged (rule 30).
   */
  payoutAccount(centerId: string, tx?: SqlExecutor): Promise<PayoutAccount | null>;

  /**
   * Owner 1405/07/27 (ADR-046): who must have a contract term before launch: every active
   * center (its node) and every live workplace (its doctor node) at an active center or in a
   * private practice. Ids only.
   */
  contractParties(): Promise<{
    readonly centers: readonly string[];
    readonly workplaces: readonly { nodeId: string; centerNodeId: string | null }[];
  }>;
}

export interface PayoutAccount {
  readonly sheba: string;
  readonly accountHolder: string | null;
}

export const CENTER_DIRECTORY = Symbol('CENTER_DIRECTORY');

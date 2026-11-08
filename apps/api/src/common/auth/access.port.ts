import type { PermissionCode } from '@sepehr/contracts';
import type { Actor, SqlExecutor } from '../audit/audit.port';

/**
 * Port between the identity module's guard and the access module (the modules never
 * import each other, ADR-002). The access module provides it under {@link ACCESS_PORT}.
 */

/** One resolved scope of a role assignment (doc 04 §1). */
export type ResolvedScope =
  | { readonly kind: 'global' }
  | { readonly kind: 'own' }
  | { readonly kind: 'city'; readonly code: string }
  | { readonly kind: 'queue'; readonly code: string }
  | {
      readonly kind: 'center' | 'branch' | 'doctor';
      readonly nodeId: string;
      /** ltree path of the node; the scope covers the node and all below it. */
      readonly path: string;
      readonly cityCode: string | null;
    };

/** What a caller may do right now, resolved from the database on every request. */
export interface EffectiveAccess {
  readonly accountId: string;
  /** Codes of the roles held, for the audit trail. */
  readonly roles: readonly string[];
  readonly permissions: ReadonlySet<PermissionCode>;
  readonly scopes: readonly ResolvedScope[];
}

export interface AccessPort {
  /** The caller's permissions and scopes; never cached, so role changes apply at once. */
  resolve(accountId: string): Promise<EffectiveAccess>;
  /**
   * Task 7-7: the accounts holding a role now (active, not revoked), for a unit's agent list.
   * Ids only; names come from the account directory.
   */
  holdersOf(roleCode: string): Promise<string[]>;
  /**
   * The accounts holding a permission now through any live role (active, not revoked): the
   * launch check of a two-person permission (owner 1405/07/23). Ids only.
   */
  holdersOfPermission(permission: PermissionCode): Promise<string[]>;
  /**
   * Offboarding (owner 1405/07/23, plan 4): revokes every live role assignment of the
   * account, each audited as `access.role_revoked` with the reason, in the caller's
   * transaction. Returns how many it revoked.
   */
  revokeAllOf(accountId: string, actor: Actor, reason: string, tx: SqlExecutor): Promise<number>;
  /**
   * Owner 1405/08/10: the center manager's role on its own center, for the account made by an
   * approved partnership request (the approver is checked by the catalog module). The account's
   * mobile must be verified, as for every new center manager; audited `access.role_assigned`.
   */
  grantCenterManager(
    actor: Actor,
    input: { accountId: string; centerNodeId: string; reason: string },
  ): Promise<{ id: string }>;
  /** Whether a staff request from `ip` may reach the internal panel (doc 04 §6). */
  isInternalPanelIpAllowed(ip: string | null): Promise<boolean>;
}

export const ACCESS_PORT = Symbol('ACCESS_PORT');

import type { TicketLinkType } from '@sepehr/contracts';
import type { SqlExecutor } from '../audit/audit.port';
import type { EffectiveAccess } from '../auth/access.port';

/**
 * Port from the ticket module (task 7-1; doc 17 §1) to the modules that own what a ticket
 * may point at: whether the requester may reach one record, and a short label for it. Each
 * owning module registers one target per type it owns under {@link TICKET_LINK_TARGETS}, a
 * read-only adapter of its own tables; the ticket module never reads them (CLAUDE.md §5).
 *
 * A record the requester may not reach is reported exactly like one that does not exist
 * (null), so a link never tells whether an id is real (test 2, IDOR).
 */
export type TicketRequester =
  /** A patient or a caller: these person ids (merged persons included) and this account. */
  | {
      readonly kind: 'person';
      readonly personIds: readonly string[];
      readonly accountId: string | null;
    }
  /** A center's user: what their scopes cover (doc 04 §1). */
  | { readonly kind: 'org'; readonly access: EffectiveAccess };

export interface TicketLinkTarget {
  readonly type: TicketLinkType;
  /** The label of `id` if `requester` may reach it, else null. Nothing personal (rule 30). */
  resolve(id: string, requester: TicketRequester, tx?: SqlExecutor): Promise<string | null>;
  /**
   * Task 7-2: the node path of the record's workplace, so a patient's complaint about a doctor
   * reaches that workplace's panel. Only appointments and proformas have one.
   */
  workplaceNodePath?(id: string, tx?: SqlExecutor): Promise<string | null>;
}

export interface TicketLinkTargetRegistry {
  register(target: TicketLinkTarget): void;
}

export const TICKET_LINK_TARGETS = Symbol('TICKET_LINK_TARGETS');

/** Whether an org scope covers a node path (ltree): the node itself or one below it. */
export function scopeCovers(access: EffectiveAccess, nodePath: string): boolean {
  return access.scopes.some(
    (scope) =>
      scope.kind === 'global' ||
      ((scope.kind === 'center' || scope.kind === 'branch' || scope.kind === 'doctor') &&
        (nodePath === scope.path || nodePath.startsWith(`${scope.path}.`))),
  );
}

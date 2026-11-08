import type { SqlExecutor } from '../audit/audit.port';

/**
 * Port to the lead module's assignment engine (doc 05 §6), for the queues of other
 * modules (task 3-5: credit's completion, credit and committee queues; later collection
 * and tickets): the same shares by queue, city and field, versioned; the same smooth
 * weighted round-robin under the version's lock; the same presence and open-item caps.
 * The engine chooses; the caller records what it assigned, in its own tables. The lead
 * module provides it under {@link ASSIGNMENT_ENGINE}.
 */
export interface AssignmentKey {
  readonly queueCode: string;
  readonly cityCode: string | null;
  readonly treatmentFieldCode: string | null;
}

export interface AssignmentPick {
  readonly accountId: string;
  /** The shares version it was chosen by (for the target-versus-actual report). */
  readonly weightVersionId: string;
}

export interface AssignmentEngine {
  /**
   * The agent for one item of `key`'s queue, or null when nobody can take it (no shares
   * in force, everyone away, at their cap or at a zero share). `openOf` counts each
   * agent's open items of this queue, which their cap (agent_caps) applies to. Run inside
   * the caller's transaction (`tx`), which also records the assignment.
   */
  pick(
    tx: SqlExecutor,
    key: AssignmentKey,
    openOf: (accountIds: readonly string[]) => Promise<ReadonlyMap<string, number>>,
    now?: Date,
  ): Promise<AssignmentPick | null>;
}

export const ASSIGNMENT_ENGINE = Symbol('ASSIGNMENT_ENGINE');

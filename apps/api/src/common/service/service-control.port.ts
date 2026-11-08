import type { Actor, SqlExecutor } from '../audit/audit.port';

/**
 * Port to the service module (task 4-8): what the wallet's special operations ask of it in
 * their own transaction. A doctor change (doc 12 §7, §9 test 12) cancels the purse's open
 * authorizations; a recorded service not yet final stops it (owner پ۹), until finance
 * cancels it or it becomes final.
 */
export interface ServiceControl {
  /**
   * Cancels every authorization of the purse still waiting for its code, freeing its
   * reservation; 409 `service_not_final` while one is recorded and not final.
   */
  cancelOpen(
    actor: Actor,
    purseId: string,
    reason: string,
    tx: SqlExecutor,
  ): Promise<{ cancelled: number }>;
}

export const SERVICE_CONTROL = Symbol('SERVICE_CONTROL');

import type { SQL } from 'drizzle-orm';

/**
 * Port to the audit module (rule 9): any module records an important change through it,
 * never by writing audit tables itself. The audit module provides it under
 * {@link AUDIT_LOG}.
 */

/** Who did it and from where. `accountId` is null for a command-line operator. */
export interface Actor {
  readonly accountId: string | null;
  readonly sessionId: string | null;
  readonly ip: string | null;
  /** Role codes held at the time. */
  readonly roles: readonly string[];
  /**
   * The doctor (provider profile id) this was done for, when someone else did it: a
   * secretary or center manager acting for the doctor (doc 08 §2, task 2-3). Recorded as
   * «done by X on behalf of doctor Y».
   */
  readonly onBehalfOfDoctorId?: string | null;
  /**
   * Task 9-3 (R1): when the request's session last gave a TOTP code again, for the
   * sensitive actions that need it (assertFreshMfa). Absent for actors without a session.
   */
  readonly reauthenticatedAt?: Date | null;
  /**
   * ADR-052: the one-time code the request carries for a financial signature (the `X-Step-Up`
   * header: challenge and code). Checked and consumed only by FINANCIAL_STEP_UP.
   */
  readonly stepUp?: { readonly challengeId: string; readonly code: string } | null;
}

export interface AuditEventInput {
  readonly actor: Actor;
  /** `module.what_happened`, e.g. `access.role_assigned`. */
  readonly action: string;
  readonly entityType: string;
  readonly entityId: string | null;
  /** JSON-serializable state before and after; money as strings (no JS bigint). */
  readonly before?: unknown;
  readonly after?: unknown;
  readonly reason?: string | null;
}

/** Anything that runs SQL: the database or an open transaction. */
export interface SqlExecutor {
  execute(query: SQL): Promise<{ rows: Record<string, unknown>[] }>;
}

export interface AuditLog {
  /**
   * Appends an event to the hash chain. Pass the transaction of the change itself, so the
   * change and its record commit or fail together.
   */
  record(event: AuditEventInput, tx?: SqlExecutor): Promise<void>;
  /** Records that `actor` viewed a record or file (doc 04 §7, access log). */
  recordView(actor: Actor, entityType: string, entityId: string): Promise<void>;
}

export const AUDIT_LOG = Symbol('AUDIT_LOG');

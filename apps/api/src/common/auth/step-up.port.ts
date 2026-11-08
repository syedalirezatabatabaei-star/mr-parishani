import { ForbiddenException } from '@nestjs/common';
import type { StepUpOperation } from '@sepehr/contracts';
import type { Actor } from '../audit/audit.port';

/**
 * ADR-052 (owner 1405/08/02): every financial approval, and the request before it, proves the
 * signer is there now with a one-time code bound to that one operation. Today the code comes by
 * SMS; a TOTP provider can take its place behind this port without touching the services.
 */
export const FINANCIAL_STEP_UP = Symbol('FINANCIAL_STEP_UP');

/** What a code was sent for, as the service knows it (the amount in whole rials). */
export interface StepUpTarget {
  readonly type: StepUpOperation['type'];
  readonly id: string;
  readonly amountRial: bigint | null;
  readonly step: StepUpOperation['step'];
}

export interface FinancialStepUp {
  /**
   * Refuses unless the request carries a fresh code for exactly this operation, and consumes
   * it (one use). Call it in the service before anything is written. Actors without a session
   * (scheduled jobs, the command line) sign nothing financial and are not asked.
   */
  assert(actor: Actor, target: StepUpTarget, now?: Date): Promise<void>;
}

/**
 * The worker's (ADR-052): background jobs act without a session and sign nothing; a request with
 * a session never reaches the worker, and if one ever did it is refused, never let through.
 */
export class NoSessionStepUp implements FinancialStepUp {
  assert(actor: Actor): Promise<void> {
    if (actor.sessionId === null) return Promise.resolve();
    return Promise.reject(new ForbiddenException({ error: 'step_up_unavailable' }));
  }
}

import type { Actor } from '../audit/audit.port';

/**
 * Port to the identity module (owner 1405/08/10): a center user's account made for an
 * approved partnership request, with the mobile the applicant proved by a code, and its
 * one-time link sent by SMS. The account has no usable password until its user sets one through
 * the link; the authenticator app is set up at the first sign-in (rule 25). The token leaves
 * the identity module only in that SMS, through the queue that keeps no record of its text
 * (like a login code): it is kept as a hash, never returned, never in sms_dispatches.
 */
export interface CenterAccounts {
  provision(
    actor: Actor,
    input: {
      username: string;
      displayName: string;
      mobile: string;
      /** The center panel's origin, for the link (`<origin>/setup#<token>`). */
      linkOrigin: string;
      /** The request's tracking number, named in the SMS. */
      requestNumber: number;
    },
    now?: Date,
  ): Promise<{ accountId: string; expiresAt: Date }>;
}

export const CENTER_ACCOUNTS = Symbol('CENTER_ACCOUNTS');

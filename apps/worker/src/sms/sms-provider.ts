/**
 * An SMS gateway. Implementations: Kavenegar (production) and a console printer for local
 * development; tests use their own fakes. `signal` aborts the call on timeout.
 */
export interface SmsProvider {
  /** Sends a login code through the provider's OTP template. Throws on failure. */
  sendOtp(mobile: string, code: string, signal: AbortSignal): Promise<void>;
  /**
   * Sends a text as written (appointment SMS, task 2-6). Throws on failure. Task 6-4: the
   * provider's message id when it gives one, for the delivery report.
   */
  sendText(mobile: string, text: string, signal: AbortSignal): Promise<SentText | undefined>;
  /**
   * ADR-052: a financial approval code by its own template: the code, the amount in tomans
   * (or null) and what is approved. Never a patient's name. Throws on failure; absent, the
   * job fails and the approval waits (no other way through).
   */
  sendStepUp?(
    mobile: string,
    message: { code: string; amountToman: string | null; operation: string },
    signal: AbortSignal,
  ): Promise<void>;
  /** Task 6-4: the delivery of sent messages, by message id; absent: never known. */
  status?(messageIds: readonly string[], signal: AbortSignal): Promise<Map<string, Delivery>>;
}

export interface SentText {
  readonly messageId: string | null;
}

/** As the notification module records it (task 6-4). */
export type Delivery = 'delivered' | 'failed' | 'pending';

/** Sends an operational alert to an on-call mobile; `code` names the alert (task 0-7). */
export interface AlertSender {
  sendAlert(mobile: string, code: string, signal: AbortSignal): Promise<void>;
}

/**
 * A failed send. Messages never contain the API key, the URL, the mobile or the code
 * (rule 30): they end up in logs.
 */
export class SmsSendError extends Error {
  override readonly name = 'SmsSendError';
}

/** 9121234567 → 912***4567, for logs. */
export const maskMobile = (mobile: string) => `${mobile.slice(0, 3)}***${mobile.slice(-4)}`;

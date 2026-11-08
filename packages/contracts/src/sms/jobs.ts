import * as z from 'zod';

/** BullMQ queue that carries SMS jobs from the API to the worker. */
export const SMS_QUEUE = 'sms';

/** Sends a login code through the provider's OTP template. */
export const SEND_OTP_JOB = 'send-otp';

export const sendOtpJobSchema = z.object({
  /** Normalized mobile, 9XXXXXXXXX. */
  mobile: z.string().regex(/^9\d{9}$/),
  code: z.string().regex(/^\d{4,8}$/),
  /** The code is useless after this instant, so the worker drops the job instead. */
  expiresAt: z.iso.datetime(),
});

export type SendOtpJob = z.infer<typeof sendOtpJobSchema>;

/**
 * Sends a text (task 2-6: appointment SMS rendered from `booking.sms_templates`). The job
 * id is the notice's own id, so a notice is enqueued at most once.
 */
export const SEND_TEXT_JOB = 'send-text';

export const sendTextJobSchema = z.object({
  /** Normalized mobile, 9XXXXXXXXX. */
  mobile: z.string().regex(/^9\d{9}$/),
  text: z.string().min(1).max(1000),
  /** Not worth sending after this instant (a reminder after the appointment). */
  notAfter: z.iso.datetime(),
  /** Task 6-4: the notification module's record, given the provider's message id once sent. */
  dispatchId: z.uuid().optional(),
});

export type SendTextJob = z.infer<typeof sendTextJobSchema>;

/**
 * ADR-052: the financial approval code, sent with the second Kavenegar template
 * (KAVENEGAR_STEP_UP_TEMPLATE): %token% the code, %token2% the amount in tomans, %token10% what
 * is being approved. Never a patient's name. The worker drops it once the code has expired.
 */
export const SEND_STEP_UP_JOB = 'send-step-up';

export const sendStepUpJobSchema = z.object({
  mobile: z.string().regex(/^9\d{9}$/),
  code: z.string().regex(/^\d{6}$/),
  /** Whole tomans as digits, or null when the action has no amount. */
  amountToman: z
    .string()
    .regex(/^\d{1,17}$/)
    .nullable(),
  /** What is approved, in Persian, a few words (Kavenegar's token10). */
  operation: z.string().min(2).max(60),
  expiresAt: z.iso.datetime(),
});

export type SendStepUpJob = z.infer<typeof sendStepUpJobSchema>;

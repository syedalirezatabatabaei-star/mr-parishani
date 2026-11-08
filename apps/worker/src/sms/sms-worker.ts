import {
  SEND_OTP_JOB,
  SEND_TEXT_JOB,
  SMS_QUEUE,
  sendOtpJobSchema,
  sendStepUpJobSchema,
  SEND_STEP_UP_JOB,
  sendTextJobSchema,
} from '@sepehr/contracts';
import { UnrecoverableError, Worker, type Job } from 'bullmq';
import type { SmsProvider } from './sms-provider.js';

export interface SmsWorkerOptions {
  readonly redisUrl: string;
  readonly provider: SmsProvider;
  /** Each provider call is aborted after this long and retried by the queue. */
  readonly timeoutMs: number;
  readonly now?: () => Date;
  readonly log?: (line: string) => void;
  /**
   * Task 6-4: a notification's SMS taken by the provider, with its message id. A failure
   * here is logged, never thrown: the SMS went, and must not go twice.
   */
  readonly onSent?: (dispatchId: string, messageId: string | null) => Promise<void>;
}

/**
 * Consumes the SMS queue. Retries and backoff come from the job options the API sets;
 * a failed call is simply thrown. Logs carry the job id only, never the mobile or code.
 */
export function createSmsWorker(options: SmsWorkerOptions): Worker {
  const now = options.now ?? (() => new Date());
  const log = options.log ?? console.log;

  const worker = new Worker(
    SMS_QUEUE,
    async (job: Job) => {
      if (job.name === SEND_TEXT_JOB) {
        const text = sendTextJobSchema.safeParse(job.data);
        if (!text.success) throw new UnrecoverableError('malformed send-text job');
        // A reminder after the appointment is noise; stop retrying.
        if (new Date(text.data.notAfter) <= now()) return 'expired';
        const sent = await options.provider.sendText(
          text.data.mobile,
          text.data.text,
          AbortSignal.timeout(options.timeoutMs),
        );
        if (text.data.dispatchId && options.onSent) {
          await options
            .onSent(text.data.dispatchId, sent?.messageId ?? null)
            .catch((error: unknown) => {
              log(`sms job ${job.id ?? '?'} sent, not recorded: ${(error as Error).message}`);
            });
        }
        return 'sent';
      }
      if (job.name === SEND_STEP_UP_JOB) {
        const stepUp = sendStepUpJobSchema.safeParse(job.data);
        if (!stepUp.success) throw new UnrecoverableError('malformed send-step-up job');
        if (new Date(stepUp.data.expiresAt) <= now()) return 'expired';
        if (!options.provider.sendStepUp) {
          throw new UnrecoverableError('this SMS provider sends no step-up codes');
        }
        const { mobile, code, amountToman, operation } = stepUp.data;
        await options.provider.sendStepUp(
          mobile,
          { code, amountToman, operation },
          AbortSignal.timeout(options.timeoutMs),
        );
        return 'sent';
      }
      if (job.name !== SEND_OTP_JOB) throw new UnrecoverableError(`unknown job ${job.name}`);
      const parsed = sendOtpJobSchema.safeParse(job.data);
      if (!parsed.success) throw new UnrecoverableError('malformed send-otp job');
      const { mobile, code, expiresAt } = parsed.data;

      // A code delivered after it expired is useless; stop retrying.
      if (new Date(expiresAt) <= now()) return 'expired';
      await options.provider.sendOtp(mobile, code, AbortSignal.timeout(options.timeoutMs));
      return 'sent';
    },
    { connection: { url: options.redisUrl }, concurrency: 10 },
  );

  worker.on('failed', (job, error) => {
    log(
      `sms job ${job?.id ?? '?'} failed (attempt ${String(job?.attemptsMade ?? 0)}): ${error.message}`,
    );
  });
  return worker;
}

import {
  SEND_OTP_JOB,
  SEND_STEP_UP_JOB,
  SEND_TEXT_JOB,
  SMS_QUEUE,
  sendOtpJobSchema,
  sendStepUpJobSchema,
  sendTextJobSchema,
  type SendOtpJob,
  type SendStepUpJob,
  type SendTextJob,
} from '@sepehr/contracts';
import { Queue } from 'bullmq';

/** Delivers login codes. The API only enqueues; the worker talks to the SMS provider. */
export interface OtpSender {
  sendOtp(job: SendOtpJob): Promise<void>;
}

export interface SmsRetryPolicy {
  readonly attempts: number;
  /** First retry delay; doubles on each attempt. */
  readonly backoffMs: number;
}

/** BullMQ producer; the queue connects on first use. */
export class QueueOtpSender implements OtpSender {
  private queue: Queue | undefined;

  constructor(
    private readonly redisUrl: string,
    private readonly retry: SmsRetryPolicy,
  ) {}

  async sendOtp(job: SendOtpJob): Promise<void> {
    this.queue ??= new Queue(SMS_QUEUE, { connection: { url: this.redisUrl } });
    await this.queue.add(SEND_OTP_JOB, sendOtpJobSchema.parse(job), {
      attempts: this.retry.attempts,
      backoff: { type: 'exponential', delay: this.retry.backoffMs },
      // The job carries a login code: keep it in Redis no longer than needed.
      removeOnComplete: true,
      removeOnFail: true,
    });
  }

  async close(): Promise<void> {
    await this.queue?.close();
  }
}

/** ADR-052: the financial approval code, by the second Kavenegar template. */
export const STEP_UP_SENDER = Symbol('STEP_UP_SENDER');

export interface StepUpSender {
  sendStepUp(job: SendStepUpJob): Promise<void>;
  close?(): Promise<void>;
}

/** BullMQ producer of step-up codes; the queue connects on first use. */
export class QueueStepUpSender implements StepUpSender {
  private queue: Queue | undefined;

  constructor(
    private readonly redisUrl: string,
    private readonly retry: SmsRetryPolicy,
  ) {}

  async sendStepUp(job: SendStepUpJob): Promise<void> {
    this.queue ??= new Queue(SMS_QUEUE, { connection: { url: this.redisUrl } });
    await this.queue.add(SEND_STEP_UP_JOB, sendStepUpJobSchema.parse(job), {
      attempts: this.retry.attempts,
      backoff: { type: 'exponential', delay: this.retry.backoffMs },
      // The job carries a code: kept in Redis no longer than needed.
      removeOnComplete: true,
      removeOnFail: true,
    });
  }

  async close(): Promise<void> {
    await this.queue?.close();
  }
}

/** Delivers a rendered text (appointment SMS, task 2-6); `jobId` makes a send happen once. */
export interface TextSmsSender {
  sendText(job: SendTextJob, jobId: string): Promise<void>;
  close?(): Promise<void>;
}

/** BullMQ producer of text SMS; the queue connects on first use. */
export class QueueTextSmsSender implements TextSmsSender {
  private queue: Queue | undefined;

  constructor(
    private readonly redisUrl: string,
    private readonly retry: SmsRetryPolicy,
  ) {}

  async sendText(job: SendTextJob, jobId: string): Promise<void> {
    this.queue ??= new Queue(SMS_QUEUE, { connection: { url: this.redisUrl } });
    await this.queue.add(SEND_TEXT_JOB, sendTextJobSchema.parse(job), {
      jobId,
      attempts: this.retry.attempts,
      backoff: { type: 'exponential', delay: this.retry.backoffMs },
      // The job carries a mobile: keep it in Redis no longer than needed.
      removeOnComplete: true,
      removeOnFail: true,
    });
  }

  async close(): Promise<void> {
    await this.queue?.close();
  }
}

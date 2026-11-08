import { RedisContainer, type StartedRedisContainer } from '@testcontainers/redis';
import { SEND_OTP_JOB, SEND_TEXT_JOB, SMS_QUEUE, type SendOtpJob } from '@sepehr/contracts';
import { Queue, QueueEvents, type Worker } from 'bullmq';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { SmsProvider } from './sms-provider.js';
import { createSmsWorker } from './sms-worker.js';

const REDIS_IMAGE =
  'redis:8-alpine@sha256:bd999b5cfee25fb24b8320a31fddbd69f462df44c8138c66e369582937beebc0';

/** Fails the first `failures` calls, then records deliveries. */
class FlakyProvider implements SmsProvider {
  calls = 0;
  readonly delivered: { mobile: string; code: string }[] = [];
  readonly texts: { mobile: string; text: string }[] = [];
  constructor(
    private readonly failures: number,
    private readonly hang = false,
  ) {}
  async sendOtp(mobile: string, code: string, signal: AbortSignal): Promise<void> {
    this.calls++;
    if (this.hang) {
      // Never answers; only the timeout ends the call.
      await new Promise((_, reject) => {
        signal.addEventListener('abort', () => {
          reject(new Error('provider timed out'));
        });
      });
    }
    if (this.calls <= this.failures) throw new Error('gateway unavailable');
    this.delivered.push({ mobile, code });
  }
  sendText(mobile: string, text: string): Promise<undefined> {
    this.texts.push({ mobile, text });
    return Promise.resolve(undefined);
  }
}

let redis: StartedRedisContainer;
let queue: Queue;
let events: QueueEvents;
let worker: Worker | undefined;

beforeAll(async () => {
  redis = await new RedisContainer(REDIS_IMAGE).start();
  queue = new Queue(SMS_QUEUE, { connection: { url: redis.getConnectionUrl() } });
  events = new QueueEvents(SMS_QUEUE, { connection: { url: redis.getConnectionUrl() } });
  await events.waitUntilReady();
});

afterEach(async () => {
  await worker?.close();
  worker = undefined;
});

afterAll(async () => {
  await events.close();
  await queue.close();
  await redis.stop();
});

const job = (secondsLeft = 180): SendOtpJob => ({
  mobile: '9121234567',
  code: '482913',
  expiresAt: new Date(Date.now() + secondsLeft * 1000).toISOString(),
});

// The same options the API's QueueOtpSender uses, with a short backoff for the test.
const add = (data: SendOtpJob, attempts = 5) =>
  queue.add(SEND_OTP_JOB, data, {
    attempts,
    backoff: { type: 'exponential', delay: 50 },
    // Kept after they finish: a job removed on completion can be gone before
    // waitUntilFinished() looks it up ("Missing key"), which made these tests flaky.
    removeOnComplete: false,
    removeOnFail: false,
  });

describe('SMS worker', () => {
  it('delivers an appointment text, once per job id, and drops one past its time (task 2-6)', async () => {
    const provider = new FlakyProvider(0);
    worker = createSmsWorker({ redisUrl: redis.getConnectionUrl(), provider, timeoutMs: 1000 });
    const data = (msLeft: number) => ({
      mobile: '9121234567',
      text: 'نوبت شما تأیید شد',
      notAfter: new Date(Date.now() + msLeft).toISOString(),
    });
    const opts = { jobId: 'booking-event-1', removeOnComplete: false };
    const first = await queue.add(SEND_TEXT_JOB, data(60_000), opts);
    await expect(first.waitUntilFinished(events, 10_000)).resolves.toBe('sent');
    // The same job id again (a redelivered event) is not queued twice.
    await queue.add(SEND_TEXT_JOB, data(60_000), opts);
    // Kept after it finishes: a job removed on completion can be gone before
    // waitUntilFinished() looks it up ("Missing key"), which made this test flaky.
    const late = await queue.add(SEND_TEXT_JOB, data(-1000), { removeOnComplete: false });
    await expect(late.waitUntilFinished(events, 10_000)).resolves.toBe('expired');
    expect(provider.texts).toEqual([{ mobile: '9121234567', text: 'نوبت شما تأیید شد' }]);
  });

  it("records a notification's SMS as sent, with its message id; a failure to record never resends (task 6-4)", async () => {
    const provider = new FlakyProvider(0);
    const recorded: [string, string | null][] = [];
    let failRecord = false;
    const log: string[] = [];
    worker = createSmsWorker({
      redisUrl: redis.getConnectionUrl(),
      provider,
      timeoutMs: 1000,
      log: (l) => log.push(l),
      onSent: (dispatchId, messageId) => {
        if (failRecord) return Promise.reject(new Error('database away'));
        recorded.push([dispatchId, messageId]);
        return Promise.resolve();
      },
    });
    const data = (dispatchId?: string) => ({
      mobile: '9121234567',
      text: 'یادآوری قسط',
      notAfter: new Date(Date.now() + 60_000).toISOString(),
      ...(dispatchId ? { dispatchId } : {}),
    });
    const id = '01a11111-1111-7111-8111-111111111111';
    const one = await queue.add(SEND_TEXT_JOB, data(id), { removeOnComplete: false });
    await expect(one.waitUntilFinished(events, 10_000)).resolves.toBe('sent');
    expect(recorded).toEqual([[id, null]]);
    // Without a dispatch id (the other modules' SMS): nothing recorded.
    const other = await queue.add(SEND_TEXT_JOB, data(), { removeOnComplete: false });
    await expect(other.waitUntilFinished(events, 10_000)).resolves.toBe('sent');
    expect(recorded).toHaveLength(1);
    // Recording fails: the job still succeeds (no second send), and the log says so.
    failRecord = true;
    const third = await queue.add(SEND_TEXT_JOB, data('01a11111-1111-7111-8111-222222222222'), {
      removeOnComplete: false,
    });
    await expect(third.waitUntilFinished(events, 10_000)).resolves.toBe('sent');
    expect(provider.texts).toHaveLength(3);
    expect(log.some((l) => l.includes('sent, not recorded'))).toBe(true);
    expect(log.join('\n')).not.toContain('9121234567');
  });

  it('delivers a code', async () => {
    const provider = new FlakyProvider(0);
    worker = createSmsWorker({ redisUrl: redis.getConnectionUrl(), provider, timeoutMs: 1000 });
    const added = await add(job());
    await expect(added.waitUntilFinished(events, 10_000)).resolves.toBe('sent');
    expect(provider.delivered).toEqual([{ mobile: '9121234567', code: '482913' }]);
  });

  it('retries a failing gateway and delivers exactly once', async () => {
    const provider = new FlakyProvider(2);
    const log: string[] = [];
    worker = createSmsWorker({
      redisUrl: redis.getConnectionUrl(),
      provider,
      timeoutMs: 1000,
      log: (l) => log.push(l),
    });
    const added = await add(job());
    await expect(added.waitUntilFinished(events, 10_000)).resolves.toBe('sent');
    expect(provider.calls).toBe(3);
    expect(provider.delivered).toHaveLength(1);
    // Failures are logged without the mobile or the code.
    expect(log).toHaveLength(2);
    for (const line of log) {
      expect(line).not.toContain('9121234567');
      expect(line).not.toContain('482913');
    }
  });

  it('times out a hanging gateway and gives up after the last attempt', async () => {
    const provider = new FlakyProvider(0, true);
    worker = createSmsWorker({ redisUrl: redis.getConnectionUrl(), provider, timeoutMs: 100 });
    const added = await add(job(), 3);
    await expect(added.waitUntilFinished(events, 10_000)).rejects.toThrow('provider timed out');
    expect(provider.calls).toBe(3);
    expect(provider.delivered).toHaveLength(0);
  });

  it('drops a code that has already expired instead of sending it', async () => {
    const provider = new FlakyProvider(0);
    worker = createSmsWorker({ redisUrl: redis.getConnectionUrl(), provider, timeoutMs: 1000 });
    const added = await add(job(-1));
    await expect(added.waitUntilFinished(events, 10_000)).resolves.toBe('expired');
    expect(provider.calls).toBe(0);
  });

  it('does not retry a malformed job', async () => {
    const provider = new FlakyProvider(0);
    worker = createSmsWorker({ redisUrl: redis.getConnectionUrl(), provider, timeoutMs: 1000 });
    const added = await queue.add(SEND_OTP_JOB, { mobile: 'x' }, { attempts: 5 });
    await expect(added.waitUntilFinished(events, 10_000)).rejects.toThrow('malformed');
    expect(provider.calls).toBe(0);
    expect((await queue.getJob(added.id ?? ''))?.attemptsMade).toBe(1);
  });
});

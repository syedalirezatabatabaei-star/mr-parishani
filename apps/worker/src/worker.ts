/**
 * Background worker: SMS delivery, and through the API's own modules (ADR-016) the
 * outbox relay and consumers, scheduled jobs and queue monitoring. Import this only
 * after telemetry has started (see main.ts).
 */
import {
  CONFIG,
  CountingAlertSink,
  createWorkerContext,
  type ConfigPort,
  NOTIFICATIONS,
  type NotificationsPort,
} from '@sepehr/api/worker';
import { alertmanagerReceiverFromEnv, startAlertmanagerReceiver } from './alertmanager.js';
import { alertMobilesFromEnv, SmsAlertSink } from './alerts.js';
import { DevConsoleSmsProvider } from './sms/dev-console.js';
import { KavenegarSmsProvider } from './sms/kavenegar.js';
import type { AlertSender, SmsProvider } from './sms/sms-provider.js';

import { SmsCreditMonitor, type CreditSource } from './sms/credit-monitor.js';
import { createSmsWorker } from './sms/sms-worker.js';

/** Each call to the SMS provider is abandoned after this long, then retried. */
export const SMS_TIMEOUT_MS = 10_000;

export interface Worker {
  stop(): Promise<void>;
}

function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name];
  if (!value) throw new Error(`${name} is not set`);
  return value;
}

/**
 * SMS_PROVIDER: `kavenegar` (default) or `fake` (prints; development only). Kavenegar
 * also needs KAVENEGAR_ALERT_TEMPLATE when on-call mobiles are set, and KAVENEGAR_SENDER
 * (a sender line) for the appointment SMS.
 */
export function smsProviderFromEnv(env: NodeJS.ProcessEnv): SmsProvider & AlertSender {
  const kind = env['SMS_PROVIDER'] ?? 'kavenegar';
  // The tester's staging never sends a real SMS (owner 1405/07/18, task 9-4).
  if (env['DEPLOY_ENV'] === 'staging' && kind !== 'fake') {
    throw new Error('DEPLOY_ENV=staging sends no real SMS: SMS_PROVIDER must be fake');
  }
  if (kind === 'fake')
    return new DevConsoleSmsProvider(env['NODE_ENV'], console.log, env['DEPLOY_ENV']);
  if (kind === 'kavenegar') {
    const alerting = (env['ALERT_SMS_MOBILES'] ?? '').trim() !== '';
    return new KavenegarSmsProvider(
      required(env, 'KAVENEGAR_API_KEY'),
      required(env, 'KAVENEGAR_OTP_TEMPLATE'),
      fetch,
      alerting ? required(env, 'KAVENEGAR_ALERT_TEMPLATE') : null,
      // Appointment SMS (task 2-6); without it those jobs fail and are retried, logins still work.
      env['KAVENEGAR_SENDER']?.trim() || null,
      // ADR-052: financial approval codes; without it they fail and the approval waits.
      env['KAVENEGAR_STEP_UP_TEMPLATE']?.trim() || null,
    );
  }
  throw new Error('SMS_PROVIDER must be kavenegar or fake');
}

/** The providers that can say what is left on the SMS account (Kavenegar; not the fake). */
const hasCredit = (provider: object): provider is CreditSource =>
  typeof (provider as Partial<CreditSource>).remainingCreditRial === 'function';

export async function startWorker(env: NodeJS.ProcessEnv = process.env): Promise<Worker> {
  const redisUrl = required(env, 'REDIS_URL');
  const provider = smsProviderFromEnv(env);
  const onCall = alertMobilesFromEnv(env);
  const receiving = alertmanagerReceiverFromEnv(env);
  // Counted for Prometheus (task 10-3), then logged and texted to the on-call numbers.
  const alertSink = new CountingAlertSink(new SmsAlertSink(provider, onCall));
  // Task 6-4: a notification's SMS recorded as sent, once the context is up.
  let context: Awaited<ReturnType<typeof createWorkerContext>> | undefined;
  const sms = createSmsWorker({
    redisUrl,
    provider,
    timeoutMs: SMS_TIMEOUT_MS,
    onSent: async (dispatchId, messageId) => {
      if (!context) throw new Error('the worker context is not up yet');
      await context.get<NotificationsPort>(NOTIFICATIONS).markSent(dispatchId, messageId);
    },
  });
  // The Prometheus rules' critical alerts, texted to the same numbers (task 10-3); its own
  // cooldown, so a rule firing does not hold back the app's alert of the same moment.
  const receiver = receiving
    ? await startAlertmanagerReceiver({ ...receiving, sink: new SmsAlertSink(provider, onCall) })
    : null;
  const closeReceiver = () =>
    new Promise<void>((resolve) => {
      if (!receiver) {
        resolve();
        return;
      }
      receiver.close(() => {
        resolve();
      });
    });
  try {
    context = await createWorkerContext({
      alertSink,
      ...(provider.status
        ? {
            smsDeliveryStatus: {
              status: (ids: readonly string[]) =>
                provider.status?.(ids, AbortSignal.timeout(SMS_TIMEOUT_MS)) ??
                Promise.resolve(new Map()),
            },
          }
        : {}),
    });
    // ADR-052: every financial signature is an SMS; an empty account would stop them all.
    const ready = context;
    const credit = hasCredit(provider)
      ? new SmsCreditMonitor(
          provider,
          async () =>
            BigInt(
              (await ready.get<ConfigPort>(CONFIG).resolve('notification.sms_credit_alert_rial'))
                .value,
            ),
          alertSink,
        )
      : null;
    credit?.start();
    return {
      stop: async () => {
        credit?.stop();
        await closeReceiver();
        await sms.close();
        await context?.close();
      },
    };
  } catch (error) {
    await closeReceiver();
    await sms.close();
    throw error;
  }
}

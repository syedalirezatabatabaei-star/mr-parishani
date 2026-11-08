import { normalizeMobile } from '@sepehr/contracts';
import type { Alert, AlertSink } from '@sepehr/api/worker';
import { maskMobile, type AlertSender } from './sms/sms-provider.js';

/** The same alert is sent by SMS at most once in this window, per worker process. */
export const ALERT_SMS_COOLDOWN_MS = 30 * 60 * 1000;
const SEND_TIMEOUT_MS = 10_000;

/**
 * On-call mobiles for critical alerts, from ALERT_SMS_MOBILES (comma-separated). An
 * environment setting on purpose, not versioned configuration: it is infrastructure, not
 * business (task 0-7 decision; ADR-016 notes the move to a real on-call rotation later).
 * Required in production, so that alerts cannot silently go nowhere.
 */
export function alertMobilesFromEnv(env: NodeJS.ProcessEnv): string[] {
  const raw = (env['ALERT_SMS_MOBILES'] ?? '')
    .split(',')
    .map((m) => m.trim())
    .filter((m) => m !== '');
  const mobiles = raw.map((m) => normalizeMobile(m));
  if (mobiles.some((m) => m === null)) {
    throw new Error('ALERT_SMS_MOBILES must list valid mobile numbers');
  }
  if (mobiles.length === 0 && env['NODE_ENV'] === 'production') {
    throw new Error('ALERT_SMS_MOBILES is not set');
  }
  return mobiles as string[];
}

/**
 * Logs every alert and texts it to the on-call mobiles, at most once per alert code per
 * cooldown so a lasting problem does not flood them (the metrics keep reporting it to
 * Grafana meanwhile). A failed SMS is logged and never breaks the check that raised it.
 */
export class SmsAlertSink implements AlertSink {
  private readonly lastSent = new Map<string, number>();

  constructor(
    private readonly sender: AlertSender,
    private readonly mobiles: readonly string[],
    private readonly log: (line: string) => void = console.error,
    private readonly now: () => number = Date.now,
    private readonly cooldownMs = ALERT_SMS_COOLDOWN_MS,
  ) {}

  /** The app's own alerts, and the Prometheus rules' names from Alertmanager (task 10-3). */
  async raise(alert: Pick<Alert, 'message'> & { readonly code: string }): Promise<void> {
    this.log(`[alert] ${alert.code}: ${alert.message}`);
    const last = this.lastSent.get(alert.code);
    if (last !== undefined && this.now() - last < this.cooldownMs) return;
    this.lastSent.set(alert.code, this.now());
    for (const mobile of this.mobiles) {
      try {
        await this.sender.sendAlert(mobile, alert.code, AbortSignal.timeout(SEND_TIMEOUT_MS));
      } catch (error) {
        this.log(
          `[alert] SMS to ${maskMobile(mobile)} failed: ${error instanceof Error ? error.message : 'unknown error'}`,
        );
      }
    }
  }
}

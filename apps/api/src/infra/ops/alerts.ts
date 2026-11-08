import { Logger } from '@nestjs/common';
import { metrics } from '@opentelemetry/api';

/**
 * Every alert code, also at run time: the Prometheus rules (ops/alerts) match on them as the
 * `code` label, and a test checks the rules name only these.
 */
export const ALERT_CODES = [
  'outbox_backlog',
  'outbox_stale',
  'queue_backlog',
  'queue_failed',
  // Ledger reconciliation (task 1-4)
  'ledger_mismatch',
  'ledger_invariant',
  'trial_balance_off',
  'ledger_lag',
  // Down payments' reconciliation (task 4-6b): counts only
  'down_payment_mismatch',
  'settlement_mismatch',
  // ADR-052: the SMS account, which every financial signature now needs
  'sms_credit_low',
] as const;

/**
 * An operational alert. `code` is short and stable (it becomes the SMS template token and
 * a metric label); `message` is for logs and never holds personal data (rule 30).
 */
export interface Alert {
  readonly code: (typeof ALERT_CODES)[number];
  readonly message: string;
}

/**
 * Where alerts go. The worker provides one that logs and sends SMS to the on-call
 * numbers (task 0-7 decision); Grafana alerts separately on the exported metrics.
 */
export interface AlertSink {
  raise(alert: Alert): Promise<void>;
}

export const ALERT_SINK = Symbol('ALERT_SINK');

/** Logs only: the default, and what the API process uses. */
export class LogAlertSink implements AlertSink {
  private readonly logger = new Logger('Alert');

  raise(alert: Alert): Promise<void> {
    this.logger.error(`[${alert.code}] ${alert.message}`);
    return Promise.resolve();
  }
}

/**
 * Counts every alert raised, by code, as `sepehr.alerts.raised` (task 10-3), then hands it on.
 * The reconciliations' findings (ledger, settlement, down payments) are raised once a night
 * and are not in the queue monitor's `sepehr.alerts.active`; with this, Prometheus sees them
 * too, a second channel beside the SMS to the on-call numbers.
 */
export class CountingAlertSink implements AlertSink {
  constructor(
    private readonly inner: AlertSink,
    private readonly count: (code: Alert['code']) => void = defaultCounter(),
  ) {}

  raise(alert: Alert): Promise<void> {
    this.count(alert.code);
    return this.inner.raise(alert);
  }
}

function defaultCounter(): (code: Alert['code']) => void {
  const counter = metrics
    .getMeter('sepehr.ops')
    .createCounter('sepehr.alerts.raised', { description: 'Alerts raised, by code' });
  return (code) => {
    counter.add(1, { code });
  };
}

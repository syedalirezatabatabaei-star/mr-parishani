import { metrics } from '@opentelemetry/api';

export interface SmsCreditReading {
  /** Rials left on the SMS account; null until the first reading. */
  readonly remainingRial: bigint | null;
  /** Below the threshold of `notification.sms_credit_alert_rial` (never, while it is 0). */
  readonly low: boolean;
}

/**
 * ADR-052: the worker's hourly reading of the SMS account's credit, as metrics. Prometheus's
 * `SmsCreditLow` watches `sepehr_sms_credit_low`, so the alert fires even if the worker's own
 * SMS to the on-call numbers does not get through.
 */
export function registerSmsCreditMetrics(read: () => SmsCreditReading): void {
  const meter = metrics.getMeter('sepehr.sms');
  meter
    .createObservableGauge('sepehr.sms.credit_remaining_rial', {
      description: 'Rials left on the SMS account',
    })
    .addCallback((result) => {
      const { remainingRial } = read();
      if (remainingRial !== null) result.observe(Number(remainingRial));
    });
  meter
    .createObservableGauge('sepehr.sms.credit_low', {
      description: '1 when the SMS credit is below the configured threshold',
    })
    .addCallback((result) => {
      result.observe(read().low ? 1 : 0);
    });
}

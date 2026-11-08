import { registerSmsCreditMetrics, type AlertSink } from '@sepehr/api/worker';

/** The SMS account's credit is read this often (Kavenegar counts it in rials). */
export const CREDIT_CHECK_INTERVAL_MS = 60 * 60 * 1000;
const CHECK_TIMEOUT_MS = 10_000;

export interface CreditSource {
  /** What is left on the SMS account, in rials. */
  remainingCreditRial(signal: AbortSignal): Promise<bigint>;
}

/**
 * ADR-052: every financial signature is an SMS now, so an empty SMS account stops them all.
 * Once an hour the worker reads the account's credit and, below the owner's threshold
 * (`notification.sms_credit_alert_rial`; "0" = off), texts the on-call numbers. The credit
 * and whether it is low are metrics too: Prometheus raises `SmsCreditLow` on its own, and
 * also when the worker stops reporting. A failed read is logged and tried next hour.
 */
export class SmsCreditMonitor {
  private remaining: bigint | null = null;
  private low = false;
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly source: CreditSource,
    private readonly threshold: () => Promise<bigint>,
    private readonly sink: AlertSink,
    private readonly log: (message: string) => void = console.warn,
  ) {
    registerSmsCreditMetrics(() => ({ remainingRial: this.remaining, low: this.low }));
  }

  /** One reading; true when it is below the threshold. */
  async check(): Promise<boolean> {
    let remaining: bigint;
    try {
      remaining = await this.source.remainingCreditRial(AbortSignal.timeout(CHECK_TIMEOUT_MS));
    } catch (error) {
      this.log(
        `sms credit: could not read it (${error instanceof Error ? error.message : 'unknown'})`,
      );
      return this.low;
    }
    this.remaining = remaining;
    const threshold = await this.threshold();
    this.low = threshold > 0n && remaining < threshold;
    if (this.low) {
      await this.sink.raise({
        code: 'sms_credit_low',
        message: `SMS credit ${remaining.toString()} rials, below ${threshold.toString()}`,
      });
    }
    return this.low;
  }

  start(intervalMs = CREDIT_CHECK_INTERVAL_MS): void {
    void this.check();
    this.timer = setInterval(() => {
      void this.check();
    }, intervalMs);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}

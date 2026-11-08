import type { Alert, AlertSink } from '@sepehr/api/worker';
import { describe, expect, it } from 'vitest';
import { SmsCreditMonitor } from './credit-monitor.js';

class Sink implements AlertSink {
  readonly raised: Alert[] = [];
  raise(alert: Alert): Promise<void> {
    this.raised.push(alert);
    return Promise.resolve();
  }
}

const source = (rial: bigint | Error) => ({
  remainingCreditRial: () => (rial instanceof Error ? Promise.reject(rial) : Promise.resolve(rial)),
});

describe('ADR-052: the SMS credit', () => {
  it('below the threshold texts the on-call numbers; above it, nothing', async () => {
    const sink = new Sink();
    const low = new SmsCreditMonitor(source(400_000n), () => Promise.resolve(500_000n), sink);
    expect(await low.check()).toBe(true);
    expect(sink.raised).toEqual([expect.objectContaining({ code: 'sms_credit_low' })]);
    const fine = new SmsCreditMonitor(source(900_000n), () => Promise.resolve(500_000n), sink);
    expect(await fine.check()).toBe(false);
    expect(sink.raised).toHaveLength(1);
  });

  it('a threshold of 0 is off; a failed read alerts nothing and is tried again', async () => {
    const sink = new Sink();
    const off = new SmsCreditMonitor(source(1n), () => Promise.resolve(0n), sink);
    expect(await off.check()).toBe(false);
    const logged: string[] = [];
    const failing = new SmsCreditMonitor(
      source(new Error('kavenegar request failed: timeout')),
      () => Promise.resolve(500_000n),
      sink,
      (m) => logged.push(m),
    );
    expect(await failing.check()).toBe(false);
    expect(sink.raised).toEqual([]);
    expect(logged).toEqual([expect.stringContaining('could not read it')]);
  });
});

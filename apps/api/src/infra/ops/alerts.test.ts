import { describe, expect, it } from 'vitest';
import { CountingAlertSink, type Alert, type AlertSink } from './alerts';

describe('CountingAlertSink (task 10-3)', () => {
  it('counts every alert by its code, then hands it on unchanged', async () => {
    const counted: string[] = [];
    const handed: Alert[] = [];
    const inner: AlertSink = {
      raise: (alert) => {
        handed.push(alert);
        return Promise.resolve();
      },
    };
    const sink = new CountingAlertSink(inner, (code) => counted.push(code));
    const mismatch: Alert = { code: 'ledger_mismatch', message: '2 accounts differ' };
    await sink.raise(mismatch);
    await sink.raise(mismatch);
    await sink.raise({ code: 'settlement_mismatch', message: '1 statement' });
    expect(counted).toEqual(['ledger_mismatch', 'ledger_mismatch', 'settlement_mismatch']);
    expect(handed[0]).toBe(mismatch);
    expect(handed).toHaveLength(3);
  });

  it('counts an alert even when the sink after it fails', async () => {
    const counted: string[] = [];
    const sink = new CountingAlertSink(
      { raise: () => Promise.reject(new Error('sms down')) },
      (code) => counted.push(code),
    );
    await expect(sink.raise({ code: 'queue_failed', message: 'x' })).rejects.toThrow('sms down');
    expect(counted).toEqual(['queue_failed']);
  });
});

import { describe, expect, it } from 'vitest';
import { alertMobilesFromEnv, SmsAlertSink } from './alerts.js';
import type { AlertSender } from './sms/sms-provider.js';

class RecordingSender implements AlertSender {
  readonly sent: { mobile: string; code: string }[] = [];
  failFor = new Set<string>();
  sendAlert(mobile: string, code: string): Promise<void> {
    if (this.failFor.has(mobile)) return Promise.reject(new Error('gateway unavailable'));
    this.sent.push({ mobile, code });
    return Promise.resolve();
  }
}

const alert = {
  code: 'outbox_stale',
  message: 'oldest unpublished outbox event is 400s old',
} as const;

describe('on-call mobiles (ALERT_SMS_MOBILES)', () => {
  it('are normalized, in any common format', () => {
    expect(alertMobilesFromEnv({ ALERT_SMS_MOBILES: '09121234567, +989351112233' })).toEqual([
      '9121234567',
      '9351112233',
    ]);
  });

  it('refuse an invalid number without echoing it', () => {
    expect(() => alertMobilesFromEnv({ ALERT_SMS_MOBILES: '0912-bad' })).toThrow(
      'ALERT_SMS_MOBILES must list valid mobile numbers',
    );
  });

  it('are required in production, optional elsewhere', () => {
    expect(() => alertMobilesFromEnv({ NODE_ENV: 'production' })).toThrow('ALERT_SMS_MOBILES');
    expect(alertMobilesFromEnv({ NODE_ENV: 'development' })).toEqual([]);
  });
});

describe('SmsAlertSink', () => {
  it('logs every alert and texts every on-call mobile', async () => {
    const sender = new RecordingSender();
    const lines: string[] = [];
    await new SmsAlertSink(sender, ['9121234567', '9351112233'], (l) => lines.push(l)).raise(alert);
    expect(lines).toEqual([`[alert] outbox_stale: ${alert.message}`]);
    expect(sender.sent).toEqual([
      { mobile: '9121234567', code: 'outbox_stale' },
      { mobile: '9351112233', code: 'outbox_stale' },
    ]);
  });

  it('texts the same alert at most once per cooldown, but always logs it', async () => {
    const sender = new RecordingSender();
    const lines: string[] = [];
    let now = 0;
    const sink = new SmsAlertSink(
      sender,
      ['9121234567'],
      (l) => lines.push(l),
      () => now,
      1000,
    );
    await sink.raise(alert);
    now = 500;
    await sink.raise(alert);
    await sink.raise({ code: 'queue_failed', message: 'queue sms has 1 failed jobs' });
    now = 1500;
    await sink.raise(alert);
    expect(sender.sent.map((s) => s.code)).toEqual([
      'outbox_stale',
      'queue_failed',
      'outbox_stale',
    ]);
    expect(lines).toHaveLength(4);
  });

  it('survives a failed SMS, logging the mobile masked', async () => {
    const sender = new RecordingSender();
    sender.failFor.add('9121234567');
    const lines: string[] = [];
    await new SmsAlertSink(sender, ['9121234567', '9351112233'], (l) => lines.push(l)).raise(alert);
    expect(sender.sent).toEqual([{ mobile: '9351112233', code: 'outbox_stale' }]);
    expect(lines[1]).toBe('[alert] SMS to 912***4567 failed: gateway unavailable');
    expect(lines.join('\n')).not.toContain('9121234567');
  });
});

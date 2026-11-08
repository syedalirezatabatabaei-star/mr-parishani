import { describe, expect, it } from 'vitest';
import { DevConsoleSmsProvider } from './sms/dev-console.js';
import { KavenegarSmsProvider } from './sms/kavenegar.js';
import { smsProviderFromEnv, startWorker } from './worker.js';

describe('SMS provider selection', () => {
  it('uses Kavenegar by default', () => {
    const provider = smsProviderFromEnv({
      KAVENEGAR_API_KEY: 'key',
      KAVENEGAR_OTP_TEMPLATE: 'sepehr-otp',
    });
    expect(provider).toBeInstanceOf(KavenegarSmsProvider);
  });

  it('starts without KAVENEGAR_SENDER; only appointment texts are refused (task 2-6)', async () => {
    for (const sender of [undefined, '', '  ']) {
      const provider = smsProviderFromEnv({
        KAVENEGAR_API_KEY: 'key',
        KAVENEGAR_OTP_TEMPLATE: 'sepehr-otp',
        ...(sender === undefined ? {} : { KAVENEGAR_SENDER: sender }),
      });
      expect(provider).toBeInstanceOf(KavenegarSmsProvider);
      await expect(
        provider.sendText('9121234567', 'x', new AbortController().signal),
      ).rejects.toThrow('no Kavenegar sender line configured');
    }
  });

  it('refuses Kavenegar without its settings', () => {
    expect(() => smsProviderFromEnv({ SMS_PROVIDER: 'kavenegar' })).toThrow('KAVENEGAR_API_KEY');
  });

  it('allows the printing fake only in development', () => {
    expect(smsProviderFromEnv({ SMS_PROVIDER: 'fake', NODE_ENV: 'development' })).toBeInstanceOf(
      DevConsoleSmsProvider,
    );
    for (const nodeEnv of ['production', 'test', undefined]) {
      expect(() =>
        smsProviderFromEnv({ SMS_PROVIDER: 'fake', ...(nodeEnv ? { NODE_ENV: nodeEnv } : {}) }),
      ).toThrow('only with NODE_ENV=development');
    }
  });

  it('staging sends no real SMS: only the printing fake, even in production (task 9-4)', () => {
    expect(
      smsProviderFromEnv({ SMS_PROVIDER: 'fake', NODE_ENV: 'production', DEPLOY_ENV: 'staging' }),
    ).toBeInstanceOf(DevConsoleSmsProvider);
    for (const kind of ['kavenegar', undefined]) {
      expect(() =>
        smsProviderFromEnv({
          NODE_ENV: 'production',
          DEPLOY_ENV: 'staging',
          KAVENEGAR_API_KEY: 'k',
          KAVENEGAR_OTP_TEMPLATE: 't',
          ...(kind ? { SMS_PROVIDER: kind } : {}),
        }),
      ).toThrow('DEPLOY_ENV=staging sends no real SMS');
    }
    expect(() =>
      smsProviderFromEnv({ SMS_PROVIDER: 'fake', NODE_ENV: 'production', DEPLOY_ENV: 'prod' }),
    ).toThrow('only with NODE_ENV=development');
  });

  it('rejects an unknown provider', () => {
    expect(() => smsProviderFromEnv({ SMS_PROVIDER: 'other' })).toThrow();
  });

  it('the fake prints the code with the mobile masked', async () => {
    const lines: string[] = [];
    await new DevConsoleSmsProvider('development', (l) => lines.push(l)).sendOtp(
      '9121234567',
      '482913',
    );
    expect(lines).toEqual(['[dev sms] login code for 912***4567: 482913']);
  });
});

describe('startWorker', () => {
  it('needs REDIS_URL', async () => {
    await expect(startWorker({ SMS_PROVIDER: 'fake', NODE_ENV: 'development' })).rejects.toThrow(
      'REDIS_URL',
    );
  });

  it('needs the Kavenegar alert template once on-call mobiles are set', () => {
    const env = {
      KAVENEGAR_API_KEY: 'key',
      KAVENEGAR_OTP_TEMPLATE: 'sepehr-otp',
      ALERT_SMS_MOBILES: '09121234567',
    };
    expect(() => smsProviderFromEnv(env)).toThrow('KAVENEGAR_ALERT_TEMPLATE');
    expect(smsProviderFromEnv({ ...env, KAVENEGAR_ALERT_TEMPLATE: 'sepehr-alert' })).toBeInstanceOf(
      KavenegarSmsProvider,
    );
  });
});

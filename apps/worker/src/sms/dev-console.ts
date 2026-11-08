import { maskMobile, type AlertSender, type SmsProvider } from './sms-provider.js';

/**
 * Local development, and the tester's staging (task 9-4): prints the login code (with the
 * mobile masked) instead of sending an SMS. Refuses to exist unless NODE_ENV is exactly
 * `development` or DEPLOY_ENV is exactly `staging`, so it can never run in production by
 * accident.
 */
export class DevConsoleSmsProvider implements SmsProvider, AlertSender {
  constructor(
    nodeEnv: string | undefined,
    private readonly print: (line: string) => void = console.log,
    deployEnv?: string,
  ) {
    if (nodeEnv !== 'development' && deployEnv !== 'staging') {
      throw new Error(
        'SMS_PROVIDER=fake is allowed only with NODE_ENV=development or DEPLOY_ENV=staging',
      );
    }
  }

  sendOtp(mobile: string, code: string): Promise<void> {
    this.print(`[dev sms] login code for ${maskMobile(mobile)}: ${code}`);
    return Promise.resolve();
  }

  sendStepUp(
    mobile: string,
    message: { code: string; amountToman: string | null; operation: string },
  ): Promise<void> {
    this.print(
      `[dev sms] step-up code for ${maskMobile(mobile)}: ${message.code} (${message.operation}, ${message.amountToman ?? '-'} toman)`,
    );
    return Promise.resolve();
  }

  sendText(mobile: string, text: string): Promise<undefined> {
    this.print(`[dev sms] text for ${maskMobile(mobile)}: ${text}`);
    return Promise.resolve(undefined);
  }

  sendAlert(mobile: string, code: string): Promise<void> {
    this.print(`[dev sms] alert for ${maskMobile(mobile)}: ${code}`);
    return Promise.resolve();
  }
}

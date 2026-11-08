/**
 * `pnpm identity:first-approver-mobile` (ADR-052, owner 1405/08/03): the first verified mobile
 * of an approver of signers' mobiles (the CEO, the system administrator, the third approver),
 * on the server only. The system administrator runs it with the owner present; both are named
 * in the audit trail. It never replaces a verified number: that takes two people in the panel.
 *
 *   ACCOUNT_USERNAME=... MOBILE=09... OPERATOR=<admin username> WITNESS=<owner> \
 *   REASON='...' pnpm identity:first-approver-mobile
 */
import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../../../app.module';
import { FirstApproverMobile } from '../first-approver-mobile';

async function main(): Promise<void> {
  const env = (name: string) => {
    const value = process.env[name]?.trim();
    if (!value) throw new Error(`${name} is required`);
    return value;
  };
  const input = {
    username: env('ACCOUNT_USERNAME'),
    mobile: env('MOBILE'),
    operator: env('OPERATOR'),
    witness: env('WITNESS'),
    reason: env('REASON'),
  };
  const app = await NestFactory.createApplicationContext(AppModule, { logger: ['error'] });
  try {
    const done = await app.get(FirstApproverMobile).set(input);
    console.log(`first mobile set for ${done.accountId}: …${done.mobileLastFour}`);
  } finally {
    await app.close();
  }
}

main().catch((error: unknown) => {
  const response = (error as { getResponse?: () => unknown }).getResponse?.();
  const code = (response as { error?: string } | undefined)?.error;
  console.error(
    'first approver mobile failed:',
    code ?? (error instanceof Error ? error.message : 'unknown error'),
  );
  process.exitCode = 1;
});

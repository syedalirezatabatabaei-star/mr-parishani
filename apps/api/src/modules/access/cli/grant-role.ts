/**
 * `pnpm access:grant`: gives an account a role with global scope from the command line,
 * e.g. `system_admin` to the first administrator before anyone can do it from the panel.
 * Recorded in the audit trail with the actor `cli`.
 *
 *   ACCOUNT_ID=<uuid> ROLE_CODE=system_admin GRANT_REASON="..." pnpm access:grant
 */
import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { assignRoleSchema } from '@sepehr/contracts';
import { AppModule } from '../../../app.module';
import { CLI_ACTOR } from '../../../common/auth/actor';
import { AccessService } from '../access.service';

async function main(): Promise<void> {
  const input = assignRoleSchema.parse({
    accountId: process.env['ACCOUNT_ID'],
    roleCode: process.env['ROLE_CODE'],
    scope: { kind: 'global' },
    reason: process.env['GRANT_REASON'],
  });
  const app = await NestFactory.createApplicationContext(AppModule, { logger: ['error'] });
  try {
    const { id } = await app.get(AccessService).assignRole(CLI_ACTOR, input);
    console.log(`role assigned: ${id}`);
  } finally {
    await app.close();
  }
}

main().catch((error: unknown) => {
  console.error(
    'granting the role failed:',
    error instanceof Error ? error.message : 'unknown error',
  );
  process.exitCode = 1;
});

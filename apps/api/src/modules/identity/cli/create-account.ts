/**
 * `pnpm account:create`: creates a staff or center account, e.g. the first administrator
 * before the admin panel exists. The password is read from ACCOUNT_PASSWORD, never from
 * the command line (visible in the process list); TOTP enrollment happens at first login.
 *
 *   ACCOUNT_KIND=staff ACCOUNT_USERNAME=admin ACCOUNT_PASSWORD=... pnpm account:create
 */
import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../../../app.module';
import { StaffAuthService } from '../staff-auth.service';

async function main(): Promise<void> {
  const kind = process.env['ACCOUNT_KIND'] ?? 'staff';
  const username = process.env['ACCOUNT_USERNAME'];
  const password = process.env['ACCOUNT_PASSWORD'];
  if (kind !== 'staff' && kind !== 'center')
    throw new Error('ACCOUNT_KIND must be staff or center');
  if (!username || !password) throw new Error('ACCOUNT_USERNAME and ACCOUNT_PASSWORD are required');

  const app = await NestFactory.createApplicationContext(AppModule, { logger: ['error'] });
  try {
    const id = await app.get(StaffAuthService).createAccount({ kind, username, password });
    console.log(`account created: ${id}`);
  } finally {
    await app.close();
  }
}

main().catch((error: unknown) => {
  console.error(
    'account creation failed:',
    error instanceof Error ? error.message : 'unknown error',
  );
  process.exitCode = 1;
});

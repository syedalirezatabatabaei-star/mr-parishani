/**
 * `pnpm ops:launch-check`: the launch checklist of docs/ops/RESUME.md as far as the database
 * can tell (owner 1405/07/23). Read only. Connects as the application role (DATABASE_URL), as
 * production does; the applied migrations as the migration role (MIGRATION_DATABASE_URL), when
 * set. Exits 1 if any check fails.
 */
import 'reflect-metadata';
import { Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { drizzle } from 'drizzle-orm/node-postgres';
import { AppModule } from '../../../app.module';
import type { Database } from '../../../db/database.module';
import { createPool, databaseUrlFromEnv } from '../../../db/pool';
import { LaunchChecks } from '../launch-check';

// The API's modules, as `access:grant` loads them: the access port needs the account directory.
@Module({
  imports: [AppModule],
  providers: [LaunchChecks],
})
class LaunchCheckCliModule {}

async function main(): Promise<void> {
  const app = await NestFactory.createApplicationContext(LaunchCheckCliModule, {
    logger: ['error'],
  });
  // The applied migrations are read as the migration role when it is configured: the
  // application role may not read the drizzle schema (owner 1405/07/23).
  const migrationPool = process.env['MIGRATION_DATABASE_URL']
    ? createPool(databaseUrlFromEnv('MIGRATION_DATABASE_URL'), 'sepehr-launch-check')
    : null;
  try {
    const checks = await app
      .get(LaunchChecks)
      .run(new Date(), migrationPool ? (drizzle(migrationPool) as unknown as Database) : undefined);
    for (const c of checks) {
      console.log(`${c.status.toUpperCase().padEnd(4)} [${String(c.item)}] ${c.code}: ${c.detail}`);
    }
    if (checks.some((c) => c.status === 'fail')) process.exitCode = 1;
  } finally {
    await migrationPool?.end();
    await app.close();
  }
}

main().catch((error: unknown) => {
  console.error('launch check failed:', error instanceof Error ? error.message : 'unknown error');
  process.exitCode = 1;
});

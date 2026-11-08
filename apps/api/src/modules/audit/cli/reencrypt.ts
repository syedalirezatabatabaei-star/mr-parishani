/**
 * `pnpm security:reencrypt` (R4, task 9-3; owner 1405/07/18: by hand only, two people, a
 * pg_dump first, audited). The encrypted fields of the non-financial tables under the active
 * key (`*_ACTIVE`; docs/security/key-rotation-and-backup.md §2).
 *
 *   pnpm security:reencrypt --dry-run     read only: counts, and every value decrypts
 *   pnpm security:reencrypt --run         needs an approved `audit.field_reencryption`
 *
 * `--run` only from a terminal, never a scheduler: it shows the dry run, then asks for the
 * approval's version id typed back, then takes the backup (PgDumpBackup) and writes.
 *
 * It connects as the schema owner (MIGRATION_DATABASE_URL), as a migration does: the
 * application role never gets the right to rewrite these columns.
 */
import 'reflect-metadata';
import { createInterface } from 'node:readline/promises';
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../../../app.module';
import { FieldReencryptionService, type ReencryptionReport } from '../field-reencryption.service';
import { PgDumpBackup } from '../pg-dump-backup';

const print = (report: ReencryptionReport) => {
  for (const t of report.tables) {
    console.log(`  ${t.table}: ${String(t.seen)} rows, ${String(t.rewritten)} to rewrite`);
  }
  for (const c of report.blockedBy)
    console.log(`  blocked by ${c} (proposed migration 0079 waits for the owner)`);
};

async function main(): Promise<void> {
  const mode = process.argv.includes('--run')
    ? 'run'
    : process.argv.includes('--dry-run')
      ? 'dry-run'
      : null;
  if (mode === null) throw new Error('say --dry-run or --run');
  if (mode === 'run' && !(process.stdin.isTTY && process.stdout.isTTY)) {
    throw new Error('--run is by hand only: start it from a terminal');
  }
  const owner = process.env['MIGRATION_DATABASE_URL'];
  if (!owner) throw new Error('MIGRATION_DATABASE_URL (the schema owner) is required');
  process.env['DATABASE_URL'] = owner;
  process.env['REENCRYPT_BACKUP_DATABASE_URL'] ??= owner;
  const app = await NestFactory.createApplicationContext(AppModule, { logger: ['error'] });
  try {
    const tool = app.get(FieldReencryptionService);
    console.log('dry run:');
    print(await tool.dryRun());
    if (mode === 'dry-run') return;

    const versionId = await tool.authorization();
    const prompt = createInterface({ input: process.stdin, output: process.stdout });
    const typed = await prompt.question(
      `approved by two people as version ${versionId}. Type that id to back up and run: `,
    );
    prompt.close();
    if (typed.trim() !== versionId) throw new Error('not confirmed: nothing was written');
    const done = await tool.run(new PgDumpBackup());
    console.log(`run ${done.runId} completed; backup ${done.backupFile}`);
    print(done);
  } finally {
    await app.close();
  }
}

main().catch((error: unknown) => {
  console.error('re-encryption failed:', error instanceof Error ? error.message : 'unknown error');
  process.exitCode = 1;
});

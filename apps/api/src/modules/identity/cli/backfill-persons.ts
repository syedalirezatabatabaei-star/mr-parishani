/**
 * `pnpm lead:backfill-persons`: links the patient accounts made before the lead module to
 * their Person (task 2-5b decision 1). A dry run by default; the real run only with
 * `--apply`, and on a real database only with the owner's permission, like db:migrate.
 * Prints the report and records it in person_backfill_runs; account ids only, never a
 * mobile (rule 30).
 *
 *   pnpm lead:backfill-persons              # dry run
 *   pnpm lead:backfill-persons -- --apply   # links
 */
import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../../../app.module';
import { parseBackfillArgs, PersonBackfill } from '../person-backfill';

async function main(): Promise<void> {
  // Before the app starts: a wrong command line touches nothing.
  const mode = parseBackfillArgs(process.argv.slice(2));
  const app = await NestFactory.createApplicationContext(AppModule, { logger: ['error'] });
  try {
    const report = await app.get(PersonBackfill).run(mode);
    console.log(`backfill ${report.mode} (run ${report.runId})`);
    console.log(`  patient accounts without a person: ${String(report.candidates)}`);
    console.log(`  ${mode === 'apply' ? 'linked' : 'would link'}: ${String(report.filled)}`);
    console.log(`  for manual review: ${String(report.manualReview.length)}`);
    for (const item of report.manualReview) console.log(`    ${item.accountId}  ${item.reason}`);
  } finally {
    await app.close();
  }
}

main().catch((error: unknown) => {
  console.error('backfill failed:', error instanceof Error ? error.message : 'unknown error');
  process.exitCode = 1;
});

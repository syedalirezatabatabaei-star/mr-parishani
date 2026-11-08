/**
 * `pnpm catalog:rebuild-search`: rebuilds the public search index from the catalog, the
 * prices and the free times (task 2-7 decision 1). A dry run by default, which only
 * compares and reports; the real run only with `--apply`, and on a real database only with
 * the owner's permission, like db:migrate. Idempotent. Prints the report and records it in
 * search_rebuild_runs; counts only, never a name (rule 30).
 *
 *   pnpm catalog:rebuild-search              # dry run
 *   pnpm catalog:rebuild-search -- --apply   # rebuilds
 */
import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../../../app.module';
import { parseRebuildArgs, SearchIndex } from '../search-index';

async function main(): Promise<void> {
  // Before the app starts: a wrong command line touches nothing.
  const mode = parseRebuildArgs(process.argv.slice(2));
  const app = await NestFactory.createApplicationContext(AppModule, { logger: ['error'] });
  try {
    const report = await app.get(SearchIndex).rebuild(mode);
    const verb = (done: string, would: string) => (mode === 'apply' ? done : would);
    console.log(`search rebuild ${report.mode} (run ${report.runId})`);
    console.log(`  workplaces: ${String(report.workplaces)}`);
    console.log(`  ${verb('inserted', 'would insert')}: ${String(report.inserted)}`);
    console.log(`  ${verb('updated', 'would update')}: ${String(report.updated)}`);
    console.log(`  unchanged: ${String(report.unchanged)}`);
    console.log(`  listed: ${String(report.listed)}, not listed: ${String(report.unlisted)}`);
  } finally {
    await app.close();
  }
}

main().catch((error: unknown) => {
  console.error('rebuild failed:', error instanceof Error ? error.message : 'unknown error');
  process.exitCode = 1;
});

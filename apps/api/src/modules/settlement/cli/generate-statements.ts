/**
 * `pnpm settlement:generate-statements --month=YYYY-MM` (Jalali): task 5-4's drafts of one
 * closed month, for every doctor who has none yet; what the daily job does for the last
 * month. Running it again makes nothing. Counts only (rule 30).
 */
import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../../../app.module';
import { CLI_ACTOR } from '../../../common/auth/actor';
import { StatementService } from '../statement.service';

async function main(): Promise<void> {
  const arg = process.argv.find((a) => a.startsWith('--month='))?.slice('--month='.length);
  const match = /^(\d{4})-(\d{2})$/.exec(arg ?? '');
  if (!match) {
    console.error('usage: settlement:generate-statements --month=YYYY-MM (Jalali)');
    process.exitCode = 2;
    return;
  }
  const app = await NestFactory.createApplicationContext(AppModule, { logger: ['error'] });
  try {
    const result = await app
      .get(StatementService)
      .generateMonth(CLI_ACTOR, Number(match[1]), Number(match[2]));
    console.log(
      `statements made: ${String(result.made)}; existing: ${String(result.existing)}; skipped: ${String(result.skipped)}; failed: ${String(result.failed)}`,
    );
    if (result.failed > 0) process.exitCode = 1;
  } finally {
    await app.close();
  }
}

main().catch((error: unknown) => {
  console.error('statements failed:', error instanceof Error ? error.message : 'unknown error');
  process.exitCode = 1;
});

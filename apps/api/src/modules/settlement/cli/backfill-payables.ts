/**
 * `pnpm settlement:backfill-payables`: task 5-1's backfill. Every service that became final
 * before it gets its doctor's payable and fee, once, each in its own transaction; running it
 * again makes nothing. On a real database only with the owner's permission, like db:migrate.
 * Counts only (rule 30).
 */
import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../../../app.module';
import { CLI_ACTOR } from '../../../common/auth/actor';
import { SettlementService } from '../settlement.service';

async function main(): Promise<void> {
  const app = await NestFactory.createApplicationContext(AppModule, { logger: ['error'] });
  try {
    const { seen, made, failed } = await app.get(SettlementService).backfill(CLI_ACTOR);
    console.log(
      `final services: ${String(seen)}; payables made now: ${String(made)}; failed: ${String(failed)}`,
    );
    if (failed > 0) process.exitCode = 1;
  } finally {
    await app.close();
  }
}

main().catch((error: unknown) => {
  console.error('backfill failed:', error instanceof Error ? error.message : 'unknown error');
  process.exitCode = 1;
});

/**
 * `pnpm collection:run-cycle` (task 6-9): the collection unit's nightly cycle (task 6-7) run
 * once now, what the worker does at 00:20 Tehran. With `--at=<ISO instant>` it runs as of that
 * moment: for the end-to-end stack and local trials only, refused in production, where the
 * cycle only ever runs as of now. Counts only (rule 30).
 */
import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../../../app.module';
import { CLI_ACTOR } from '../../../common/auth/actor';
import { CollectionService } from '../collection.service';

async function main(): Promise<void> {
  const arg = process.argv.find((a) => a.startsWith('--at='))?.slice('--at='.length);
  const at = arg ? new Date(arg) : new Date();
  if (Number.isNaN(at.getTime())) {
    console.error('usage: collection:run-cycle [--at=<ISO instant>]');
    process.exitCode = 2;
    return;
  }
  if (arg && process.env['NODE_ENV'] === 'production') {
    console.error('--at is for test stacks only: in production the cycle runs as of now');
    process.exitCode = 2;
    return;
  }
  const app = await NestFactory.createApplicationContext(AppModule, { logger: ['error'] });
  try {
    const result = await app.get(CollectionService).runCycle(CLI_ACTOR, at);
    console.log(`collection cycle: ${JSON.stringify(result)}`);
  } finally {
    await app.close();
  }
}

main().catch((error: unknown) => {
  console.error(
    'collection cycle failed:',
    error instanceof Error ? error.message : 'unknown error',
  );
  process.exitCode = 1;
});

/**
 * `pnpm ops:outbox-requeue --since <time> [--dry-run]`: after Redis was lost, the events
 * published since `<time>` (the Redis snapshot's time, ISO 8601) that a consumer has not
 * done and whose job is gone go back on the queue (task 10-2 plan §4). Postgres is only
 * read. Loads the worker's modules, so every consumer is known, without starting it.
 * Prints counts only: no payload reaches the output (rule 30).
 */
import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { DATABASE, type Database } from '../../../db/database.module';
import { WorkerModule } from '../../../worker.module';
import { EventDispatcher } from '../../outbox/event-dispatcher';
import { requeueOutbox } from '../../outbox/outbox-requeue';
import { WorkerRuntime } from '../../outbox/worker-runtime';

function sinceArg(argv: readonly string[]): Date {
  const at = argv.indexOf('--since');
  const value = at >= 0 ? argv[at + 1] : undefined;
  if (!value) throw new Error('usage: ops:outbox-requeue --since <ISO time> [--dry-run]');
  return new Date(value);
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const since = sinceArg(argv);
  const dryRun = argv.includes('--dry-run');
  const app = await NestFactory.createApplicationContext(
    WorkerModule.forRoot({ relayLoop: false }),
    { logger: ['error'] },
  );
  try {
    const dispatcher = app.get(EventDispatcher);
    const result = await requeueOutbox(
      app.get<Database>(DATABASE),
      app.get(WorkerRuntime).outboxQueue,
      (type) => dispatcher.subscribersOf(type),
      since,
      { dryRun },
    );
    console.log(
      `${dryRun ? 'dry run: ' : ''}examined ${String(result.examined)}, done ${String(result.done)}, ` +
        `still queued ${String(result.stillQueued)}, ` +
        `${dryRun ? 'would requeue' : 'requeued'} ${String(result.requeued)}`,
    );
  } finally {
    await app.close();
  }
}

main().catch((error: unknown) => {
  console.error('outbox requeue failed:', error instanceof Error ? error.message : 'unknown error');
  process.exitCode = 1;
});

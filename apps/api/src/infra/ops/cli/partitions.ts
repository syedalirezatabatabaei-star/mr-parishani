/**
 * `pnpm ops:partitions`: one run of the partition maintenance the worker's scheduler does
 * daily (audit, access log, outbox, processed events). For a manual catch-up, e.g. after
 * the worker was down for a long time. Connects as the application role.
 */
import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { PartitionMaintenance } from '../partition-maintenance';
import { PartitionsCliModule } from './partitions-cli.module';

async function main(): Promise<void> {
  const app = await NestFactory.createApplicationContext(PartitionsCliModule, {
    logger: ['error'],
  });
  try {
    const result = await app.get(PartitionMaintenance).run();
    console.log(
      `partitions created: ${String(result.created)}, archived: ${result.detached.join(', ') || 'none'}`,
    );
  } finally {
    await app.close();
  }
}

main().catch((error: unknown) => {
  console.error(
    'partition maintenance failed:',
    error instanceof Error ? error.message : 'unknown error',
  );
  process.exitCode = 1;
});

import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PartitionsCliModule } from '../../src/infra/ops/cli/partitions-cli.module';
import { PartitionMaintenance } from '../../src/infra/ops/partition-maintenance';
import { startMigratedDatabase, type MigratedDatabase } from '../support/postgres';

/**
 * `pnpm ops:partitions` (found 1405/08/02): the command's module did not start, as
 * ConfigModule's HolidayService needs the outbox. It starts now as the application role and
 * runs one pass, the same the worker's daily job does.
 */

let db: MigratedDatabase;
const before = process.env['DATABASE_URL'];

beforeAll(async () => {
  db = await startMigratedDatabase();
  process.env['DATABASE_URL'] = db.appUrl;
});

afterAll(async () => {
  if (before === undefined) delete process.env['DATABASE_URL'];
  else process.env['DATABASE_URL'] = before;
  await db.container.stop();
});

const partitionsOf = async (parent: string) => {
  const client = new Client({ connectionString: db.ownerUrl });
  await client.connect();
  try {
    const { rows } = await client.query<{ n: string }>(
      `SELECT count(*) AS n FROM pg_inherits WHERE inhparent = $1::regclass`,
      [parent],
    );
    return Number(rows[0]?.n ?? 0);
  } finally {
    await client.end();
  }
};

describe('pnpm ops:partitions', () => {
  it('starts as the application role and runs one maintenance pass', async () => {
    const app = await NestFactory.createApplicationContext(PartitionsCliModule, {
      logger: ['error'],
    });
    try {
      const result = await app.get(PartitionMaintenance).run();
      expect(result.created).toBeGreaterThanOrEqual(0);
      expect(result.detached).toEqual([]);
      // Twelve months ahead of this one, at least, for every partitioned table.
      for (const parent of ['audit_events', 'outbox_events', 'ledger_entries']) {
        expect(await partitionsOf(parent), parent).toBeGreaterThanOrEqual(13);
      }
      // A second pass finds nothing left to create.
      expect((await app.get(PartitionMaintenance).run()).created).toBe(0);
    } finally {
      await app.close();
    }
  });
});

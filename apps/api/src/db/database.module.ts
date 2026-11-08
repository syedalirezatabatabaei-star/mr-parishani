import { Global, Inject, Injectable, Module, type OnApplicationShutdown } from '@nestjs/common';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import type { Pool } from 'pg';
import { createPool, databaseUrlFromEnv } from './pool';
import * as schema from './schema';

/** Injection token of the Drizzle database, connected as the least-privilege app role. */
export const DATABASE = Symbol('DATABASE');
export type Database = NodePgDatabase<typeof schema>;

const PG_POOL = Symbol('PG_POOL');

@Injectable()
class PoolShutdown implements OnApplicationShutdown {
  constructor(@Inject(PG_POOL) private readonly pool: Pool) {}

  async onApplicationShutdown(): Promise<void> {
    await this.pool.end();
  }
}

/**
 * Connection to Postgres from DATABASE_URL. The pool connects lazily, on the first query.
 */
@Global()
@Module({
  providers: [
    {
      provide: PG_POOL,
      useFactory: (): Pool => createPool(databaseUrlFromEnv('DATABASE_URL'), 'sepehr-api'),
    },
    {
      provide: DATABASE,
      useFactory: (pool: Pool): Database => drizzle(pool, { schema }),
      inject: [PG_POOL],
    },
    PoolShutdown,
  ],
  exports: [DATABASE],
})
export class DatabaseModule {}

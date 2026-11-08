import {
  Global,
  Inject,
  Injectable,
  Logger,
  Module,
  type OnApplicationShutdown,
} from '@nestjs/common';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import type { Pool } from 'pg';
import { createPool, databaseUrlFromEnv } from './pool';

/**
 * The read-only connection reports and reconciliation read through (ADR-012, ADR-020): the
 * `sepehr_report` role on the replica. It never writes; results are written through the
 * primary DATABASE.
 */
export const REPORTING_DATABASE = Symbol('REPORTING_DATABASE');
export type ReportingDatabase = NodePgDatabase;

const REPORTING_POOL = Symbol('REPORTING_POOL');

/**
 * REPORTING_DATABASE_URL is required in production. Elsewhere, without it, the primary
 * DATABASE_URL is used and a warning says so (task 1-4 decision: no replica in
 * development; the real replica comes with the deployment phase).
 */
export function reportingUrlFromEnv(env: NodeJS.ProcessEnv = process.env): {
  url: string;
  fallback: boolean;
} {
  if (env['REPORTING_DATABASE_URL']) {
    return { url: databaseUrlFromEnv('REPORTING_DATABASE_URL', env), fallback: false };
  }
  if (env['NODE_ENV'] === 'production') {
    throw new Error('REPORTING_DATABASE_URL is not set (the read-only replica, ADR-012)');
  }
  return { url: databaseUrlFromEnv('DATABASE_URL', env), fallback: true };
}

@Injectable()
class ReportingPoolShutdown implements OnApplicationShutdown {
  constructor(@Inject(REPORTING_POOL) private readonly pool: Pool) {}

  async onApplicationShutdown(): Promise<void> {
    await this.pool.end();
  }
}

@Global()
@Module({
  providers: [
    {
      provide: REPORTING_POOL,
      useFactory: (): Pool => {
        const { url, fallback } = reportingUrlFromEnv();
        if (fallback) {
          new Logger('ReportingDatabase').warn(
            'REPORTING_DATABASE_URL is not set: reports read the primary database (development only)',
          );
        }
        return createPool(url, 'sepehr-reporting');
      },
    },
    {
      provide: REPORTING_DATABASE,
      useFactory: (pool: Pool): ReportingDatabase => drizzle(pool),
      inject: [REPORTING_POOL],
    },
    ReportingPoolShutdown,
  ],
  exports: [REPORTING_DATABASE],
})
export class ReportingDatabaseModule {}

import { Pool } from 'pg';
import { z } from 'zod';

const postgresUrl = z.url({ protocol: /^postgres(?:ql)?$/ });

/**
 * Reads a Postgres connection URL from the environment. The error names the variable but
 * never echoes its value: it holds a password (rule 30).
 */
export function databaseUrlFromEnv(
  name: 'DATABASE_URL' | 'MIGRATION_DATABASE_URL' | 'DB_ADMIN_URL' | 'REPORTING_DATABASE_URL',
  env: NodeJS.ProcessEnv = process.env,
): string {
  const parsed = postgresUrl.safeParse(env[name]);
  if (!parsed.success) throw new Error(`${name} is missing or is not a postgres:// URL`);
  return parsed.data;
}

/**
 * A connection pool whose sessions run in UTC (rule 21), so `now()` and timestamp
 * arithmetic in SQL never depend on the server's time zone.
 */
export function createPool(connectionString: string, applicationName: string): Pool {
  return new Pool({
    connectionString,
    application_name: applicationName,
    options: '-c TimeZone=UTC',
  });
}

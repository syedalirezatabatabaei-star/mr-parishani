import { randomBytes } from 'node:crypto';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { APP_ROLE, OWNER_ROLE, REPORT_ROLE, bootstrapDatabase } from '../../src/db/bootstrap';
import { runMigrations } from '../../src/db/migrate';

/**
 * Same major version as production and `docker-compose.yml`. Pinned by digest so every
 * run tests against the same server build.
 */
export const POSTGRES_IMAGE =
  'postgres:17-alpine@sha256:f02121de6f74d30d8a94cd1d9584125e2178d7e6c377d8130112d4e52d867995';

/**
 * Starts a throwaway Postgres for one test file. The container publishes on a random
 * free host port; callers must read the connection from the returned container
 * (`getConnectionUri()`, `getHost()`, `getPort()`) and never assume a port.
 */
export function startPostgres(): Promise<StartedPostgreSqlContainer> {
  return new PostgreSqlContainer(POSTGRES_IMAGE).start();
}

export interface MigratedDatabase {
  readonly container: StartedPostgreSqlContainer;
  /** Superuser (the container's own user). */
  readonly adminUrl: string;
  /** sepehr_owner: owns the schema, runs migrations. */
  readonly ownerUrl: string;
  /** sepehr_app: what the application connects as. */
  readonly appUrl: string;
  /** sepehr_report: read-only, what reports and reconciliation read through. */
  readonly reportUrl: string;
  readonly ownerPassword: string;
  readonly appPassword: string;
  readonly reportPassword: string;
}

function withUser(url: string, user: string, password: string): string {
  const u = new URL(url);
  u.username = user;
  u.password = password;
  return u.toString();
}

/** A Postgres prepared exactly like a real environment: bootstrap, then migrations. */
export async function startMigratedDatabase(): Promise<MigratedDatabase> {
  const container = await startPostgres();
  const adminUrl = container.getConnectionUri();
  const ownerPassword = randomBytes(18).toString('base64url');
  const appPassword = randomBytes(18).toString('base64url');
  const reportPassword = randomBytes(18).toString('base64url');
  await bootstrapDatabase({ adminUrl, ownerPassword, appPassword, reportPassword });
  const ownerUrl = withUser(adminUrl, OWNER_ROLE, ownerPassword);
  await runMigrations(ownerUrl);
  return {
    container,
    adminUrl,
    ownerUrl,
    appUrl: withUser(adminUrl, APP_ROLE, appPassword),
    // No replica in tests (ADR-020): the read-only role on the same database.
    reportUrl: withUser(adminUrl, REPORT_ROLE, reportPassword),
    ownerPassword,
    appPassword,
    reportPassword,
  };
}

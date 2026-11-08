import { escapeIdentifier, escapeLiteral, type PoolClient } from 'pg';
import { createPool } from './pool';

export const OWNER_ROLE = 'sepehr_owner';
export const APP_ROLE = 'sepehr_app';
/** Read-only, for reports and reconciliation (ADR-012, ADR-020). */
export const REPORT_ROLE = 'sepehr_report';

export interface BootstrapOptions {
  /** A superuser connection to the application database. */
  readonly adminUrl: string;
  readonly ownerPassword: string;
  readonly appPassword: string;
  readonly reportPassword: string;
}

async function upsertLoginRole(client: PoolClient, role: string, password: string) {
  const exists = await client.query('SELECT 1 FROM pg_roles WHERE rolname = $1', [role]);
  // CREATE/ALTER ROLE take no bind parameters; the password is escaped as a literal.
  const verb = exists.rowCount === 0 ? 'CREATE' : 'ALTER';
  await client.query(
    `${verb} ROLE ${escapeIdentifier(role)} WITH LOGIN NOINHERIT NOCREATEDB NOCREATEROLE ` +
      `PASSWORD ${escapeLiteral(password)}`,
  );
}

/**
 * Creates or updates the three database roles and hands the public schema to the owner.
 * Idempotent; run before `db:migrate` and again to rotate passwords.
 *
 * - sepehr_owner owns the schema and runs migrations.
 * - sepehr_app is what the application connects as; its table privileges come from
 *   migration 0000 (no DELETE, TRUNCATE or DDL).
 * - sepehr_report reads only, for reports and reconciliation; its SELECT grants come from
 *   the migrations (0008 onwards). In production it connects to the read-only replica.
 * - Nobody else may connect.
 */
export async function bootstrapDatabase(options: BootstrapOptions): Promise<void> {
  if (
    options.ownerPassword.length < 16 ||
    options.appPassword.length < 16 ||
    options.reportPassword.length < 16
  ) {
    throw new Error('Database role passwords must be at least 16 characters');
  }
  const pool = createPool(options.adminUrl, 'sepehr-bootstrap');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await upsertLoginRole(client, OWNER_ROLE, options.ownerPassword);
    await upsertLoginRole(client, APP_ROLE, options.appPassword);
    await upsertLoginRole(client, REPORT_ROLE, options.reportPassword);

    const { rows } = await client.query<{ db: string }>('SELECT current_database() AS db');
    const database = escapeIdentifier(rows[0]?.db ?? '');
    const owner = escapeIdentifier(OWNER_ROLE);
    const app = escapeIdentifier(APP_ROLE);
    const report = escapeIdentifier(REPORT_ROLE);
    for (const statement of [
      `REVOKE ALL ON DATABASE ${database} FROM PUBLIC`,
      // CREATE lets the owner make the drizzle schema that records applied migrations.
      `GRANT CONNECT, CREATE, TEMPORARY ON DATABASE ${database} TO ${owner}`,
      `GRANT CONNECT ON DATABASE ${database} TO ${app}`,
      `GRANT CONNECT ON DATABASE ${database} TO ${report}`,
      `ALTER SCHEMA public OWNER TO ${owner}`,
      `REVOKE ALL ON SCHEMA public FROM PUBLIC`,
    ]) {
      await client.query(statement);
    }
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
    await pool.end();
  }
}

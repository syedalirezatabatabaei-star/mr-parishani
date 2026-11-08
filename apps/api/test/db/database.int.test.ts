import 'reflect-metadata';
import { Test } from '@nestjs/testing';
import { sql } from 'drizzle-orm';
import type { Pool } from 'pg';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { APP_ROLE, bootstrapDatabase } from '../../src/db/bootstrap';
import { DATABASE, DatabaseModule, type Database } from '../../src/db/database.module';
import { MIGRATIONS_FOLDER, runMigrations } from '../../src/db/migrate';
import { createPool } from '../../src/db/pool';
import { startMigratedDatabase, type MigratedDatabase } from '../support/postgres';

const INSUFFICIENT_PRIVILEGE = '42501';

let db: MigratedDatabase;
let owner: Pool;
let app: Pool;

/** Rejects with a Postgres "insufficient privilege" error. */
async function expectDenied(query: Promise<unknown>): Promise<void> {
  await expect(query).rejects.toMatchObject({ code: INSUFFICIENT_PRIVILEGE });
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

beforeAll(async () => {
  db = await startMigratedDatabase();
  owner = createPool(db.ownerUrl, 'test-owner');
  app = createPool(db.appUrl, 'test-app');

  // What a module migration looks like: a table from the base columns plus the trigger,
  // and an append-only table that also revokes UPDATE (ADR-004).
  await owner.query(`
    CREATE TABLE probe_items (
      id uuid PRIMARY KEY DEFAULT uuidv7(),
      name text NOT NULL,
      amount_rial bigint NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      deleted_at timestamptz
    );
    CREATE TRIGGER probe_items_set_updated_at BEFORE UPDATE ON probe_items
      FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

    CREATE TABLE probe_entries (
      id uuid PRIMARY KEY DEFAULT uuidv7(),
      amount_rial bigint NOT NULL CHECK (amount_rial > 0),
      created_at timestamptz NOT NULL DEFAULT now()
    );
    REVOKE UPDATE ON probe_entries FROM ${APP_ROLE};
  `);
});

afterAll(async () => {
  await owner.end();
  await app.end();
  await db.container.stop();
});

describe('migrations', () => {
  it('are applied once and are safe to run again', async () => {
    await runMigrations(db.ownerUrl);
    const { rows } = await owner.query<{ n: string }>(
      'SELECT count(*) AS n FROM drizzle.__drizzle_migrations',
    );
    const journal = JSON.parse(
      readFileSync(join(MIGRATIONS_FOLDER, 'meta', '_journal.json'), 'utf8'),
    ) as { entries: unknown[] };
    expect(Number(rows[0]?.n)).toBe(journal.entries.length);
  });
});

describe('uuidv7()', () => {
  it('produces RFC 9562 version 7 UUIDs carrying the current time', async () => {
    const before = Date.now();
    const { rows } = await app.query<{ id: string }>('SELECT uuidv7() AS id');
    const after = Date.now();
    const id = rows[0]?.id ?? '';
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    const ms = parseInt(id.replace(/-/g, '').slice(0, 12), 16);
    expect(ms).toBeGreaterThanOrEqual(before - 1000);
    expect(ms).toBeLessThanOrEqual(after + 1000);
  });

  it('sorts by creation time', async () => {
    const ids: string[] = [];
    for (let i = 0; i < 20; i++) {
      const { rows } = await app.query<{ id: string }>('SELECT uuidv7() AS id');
      ids.push(rows[0]?.id ?? '');
      await sleep(2);
    }
    expect([...ids].sort()).toEqual(ids);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe('the application role', () => {
  it('runs its sessions in UTC', async () => {
    const { rows } = await app.query<{ tz: string }>("SELECT current_setting('TimeZone') AS tz");
    expect(rows[0]?.tz).toBe('UTC');
  });

  it('can insert, read and update; ids and timestamps come from the database', async () => {
    const inserted = await app.query<{ id: string; amount_rial: string; created_at: Date }>(
      "INSERT INTO probe_items (name, amount_rial) VALUES ('first', 12000000000) RETURNING *",
    );
    const row = inserted.rows[0];
    expect(row?.id).toMatch(/^[0-9a-f-]{14}7/);
    expect(row?.amount_rial).toBe('12000000000');

    await sleep(20);
    const updated = await app.query<{ created_at: Date; updated_at: Date }>(
      "UPDATE probe_items SET name = 'renamed' WHERE id = $1 RETURNING created_at, updated_at",
      [row?.id],
    );
    const after = updated.rows[0];
    expect(after?.updated_at.getTime()).toBeGreaterThan(after?.created_at.getTime() ?? Infinity);
  });

  it('keeps soft-deleted rows', async () => {
    const { rows } = await app.query<{ id: string }>(
      "INSERT INTO probe_items (name, amount_rial) VALUES ('to hide', 1) RETURNING id",
    );
    await app.query('UPDATE probe_items SET deleted_at = now() WHERE id = $1', [rows[0]?.id]);
    const found = await app.query('SELECT 1 FROM probe_items WHERE id = $1', [rows[0]?.id]);
    expect(found.rowCount).toBe(1);
  });

  it('cannot delete or truncate anything (no physical deletes)', async () => {
    await expectDenied(app.query('DELETE FROM probe_items'));
    await expectDenied(app.query('TRUNCATE probe_items'));
    await expectDenied(app.query('DELETE FROM probe_entries'));
  });

  it('may delete from no table of any migration: the default privileges never grant it', async () => {
    // Round 33: migrations rely on 0000's default privileges (SELECT, INSERT, UPDATE only) and
    // need no REVOKE DELETE of their own; this keeps that true for every table, old or new.
    await runMigrations(db.ownerUrl);
    const { rows } = await owner.query<{ name: string }>(
      `SELECT c.relname AS name FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p')
         AND (has_table_privilege('sepehr_app', c.oid, 'DELETE')
              OR has_table_privilege('sepehr_app', c.oid, 'TRUNCATE'))`,
    );
    expect(rows).toEqual([]);
    const { rows: tables } = await owner.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM pg_tables
       WHERE schemaname = 'public'
         AND tablename IN ('credit_formation_deposits', 'visit_tariff_proposals')`,
    );
    expect(tables[0]?.n).toBe(2);
    const { rows: defaults } = await owner.query<{ acl: string }>(
      `SELECT defaclacl::text AS acl FROM pg_default_acl WHERE defaclobjtype = 'r'`,
    );
    expect(defaults.length).toBeGreaterThan(0);
    for (const d of defaults) expect(d.acl).toMatch(/sepehr_app=arw\//);
  });

  it('cannot update a table whose migration revoked UPDATE (append-only ledger)', async () => {
    await app.query('INSERT INTO probe_entries (amount_rial) VALUES (5000)');
    await expectDenied(app.query('UPDATE probe_entries SET amount_rial = 1'));
  });

  it('cannot change the schema', async () => {
    await expectDenied(app.query('CREATE TABLE sneaky (id int)'));
    await expectDenied(app.query('CREATE SCHEMA sneaky'));
    await expect(app.query('DROP TABLE probe_items')).rejects.toMatchObject({ code: '42501' });
    await expect(app.query('ALTER TABLE probe_items ADD COLUMN x int')).rejects.toMatchObject({
      code: '42501',
    });
    // Without the grant option, GRANT only warns and grants nothing.
    await app.query('GRANT DELETE ON probe_items TO PUBLIC');
    await expectDenied(app.query('DELETE FROM probe_items'));
  });

  it('cannot read the migrations table', async () => {
    await expectDenied(app.query('SELECT * FROM drizzle.__drizzle_migrations'));
  });
});

describe('bootstrap', () => {
  it('is idempotent and rotates passwords', async () => {
    const newAppPassword = `${db.appPassword}-rotated`;
    await bootstrapDatabase({
      adminUrl: db.adminUrl,
      ownerPassword: db.ownerPassword,
      appPassword: newAppPassword,
      reportPassword: db.reportPassword,
    });
    const url = new URL(db.appUrl);
    url.password = newAppPassword;
    const rotated = createPool(url.toString(), 'test-rotated');
    try {
      const { rows } = await rotated.query<{ user: string }>('SELECT current_user AS user');
      expect(rows[0]?.user).toBe(APP_ROLE);
    } finally {
      await rotated.end();
    }
    // Put the original password back for the rest of the file.
    await bootstrapDatabase({
      adminUrl: db.adminUrl,
      ownerPassword: db.ownerPassword,
      appPassword: db.appPassword,
      reportPassword: db.reportPassword,
    });
  });

  it('refuses short passwords', async () => {
    await expect(
      bootstrapDatabase({
        adminUrl: db.adminUrl,
        ownerPassword: 'short',
        appPassword: 'short',
        reportPassword: 'short',
      }),
    ).rejects.toThrow('at least 16');
  });
});

/**
 * Base-rule violations in the tables whose names match `tables` (a LIKE pattern). Checks
 * the database itself, so it also covers hand-written SQL that Drizzle never sees.
 */
async function invariantProblems(tables: string): Promise<string[]> {
  const { rows } = await owner.query<{ problem: string }>(
    `
      WITH cols AS (
        SELECT c.table_name, c.column_name, c.data_type, c.column_default
        FROM information_schema.columns c
        JOIN information_schema.tables t USING (table_schema, table_name)
        WHERE c.table_schema = 'public' AND t.table_type = 'BASE TABLE'
          AND c.table_name LIKE $1
      )
      SELECT table_name || '.' || column_name || ': ' || data_type AS problem FROM cols
        WHERE data_type IN ('real', 'double precision', 'numeric', 'money')
           OR (column_name LIKE '%\\_rial' AND data_type <> 'bigint')
           OR (column_name LIKE '%\\_at' AND data_type <> 'timestamp with time zone')
           OR (data_type = 'timestamp without time zone')
      UNION ALL
      SELECT table_name || ': id is not uuid DEFAULT uuidv7()' FROM cols
        WHERE column_name = 'id' AND (data_type <> 'uuid' OR column_default IS DISTINCT FROM 'uuidv7()')
      UNION ALL
      SELECT table_name || ': updated_at without the set_updated_at trigger' FROM cols
        WHERE column_name = 'updated_at' AND NOT EXISTS (
          SELECT 1 FROM pg_trigger tg
          JOIN pg_proc p ON p.oid = tg.tgfoid
          WHERE tg.tgrelid = ('public.' || quote_ident(cols.table_name))::regclass
            AND p.proname = 'set_updated_at' AND NOT tg.tgisinternal
        )
      UNION ALL
      SELECT table_name || ': sepehr_app has ' || privilege_type
        FROM information_schema.role_table_grants
        WHERE grantee = '${APP_ROLE}' AND table_schema = 'public' AND table_name LIKE $1
          AND privilege_type NOT IN ('SELECT', 'INSERT', 'UPDATE')
      ORDER BY 1
    `,
    [tables],
  );
  return rows.map((r) => r.problem);
}

describe('database invariants', () => {
  it('hold for every table the migrations created', async () => {
    const all = await invariantProblems('%');
    // The probe tables are test fixtures, not migration output; they are checked below.
    expect(all.filter((p) => !p.startsWith('probe_'))).toEqual([]);
  });

  it('hold for the probe tables, which follow the rules', async () => {
    expect(await invariantProblems('probe\\_%')).toEqual([]);
  });

  it('catch every kind of violation', async () => {
    await owner.query(`
      CREATE TABLE bad_table (
        id integer PRIMARY KEY,
        price numeric,
        fee_rial integer,
        paid_at timestamp,
        closed_at date,
        updated_at timestamptz NOT NULL DEFAULT now()
      );
      GRANT DELETE ON bad_table TO ${APP_ROLE};
    `);
    try {
      expect(await invariantProblems('bad\\_table')).toEqual([
        'bad_table.closed_at: date',
        'bad_table.fee_rial: integer',
        'bad_table.paid_at: timestamp without time zone',
        'bad_table.price: numeric',
        'bad_table: id is not uuid DEFAULT uuidv7()',
        'bad_table: sepehr_app has DELETE',
        'bad_table: updated_at without the set_updated_at trigger',
      ]);
    } finally {
      await owner.query('DROP TABLE bad_table');
    }
  });
});

describe('DatabaseModule', () => {
  it('connects through DATABASE_URL as the app role', async () => {
    process.env['DATABASE_URL'] = db.appUrl;
    const moduleRef = await Test.createTestingModule({ imports: [DatabaseModule] }).compile();
    const app = moduleRef.createNestApplication();
    await app.init();
    try {
      const database = moduleRef.get<Database>(DATABASE);
      const result = await database.execute<{ user: string }>(sql`SELECT current_user AS user`);
      expect(result.rows[0]?.user).toBe(APP_ROLE);
    } finally {
      await app.close();
    }
  });
});

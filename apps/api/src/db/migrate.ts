import { join } from 'node:path';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { createPool } from './pool';

/** apps/api/drizzle, from both src/db (tests) and dist/db (production image). */
export const MIGRATIONS_FOLDER = join(__dirname, '..', '..', 'drizzle');

/** Applies pending migrations as the schema owner. Never called at application start. */
export async function runMigrations(ownerUrl: string): Promise<void> {
  const pool = createPool(ownerUrl, 'sepehr-migrate');
  try {
    await migrate(drizzle(pool), { migrationsFolder: MIGRATIONS_FOLDER });
  } finally {
    await pool.end();
  }
}

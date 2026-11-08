import { defineConfig } from 'drizzle-kit';

/**
 * drizzle-kit only drafts migrations (`db:generate`); each draft is reviewed and edited by
 * hand before it is committed (ADR-003). Migrations are applied by `db:migrate`, never by
 * drizzle-kit and never at application start.
 */
export default defineConfig({
  dialect: 'postgresql',
  schema: './src/db/schema.ts',
  out: './drizzle',
  strict: true,
  verbose: true,
});

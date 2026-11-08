/** `pnpm db:migrate`: applies pending migrations as sepehr_owner (MIGRATION_DATABASE_URL). */
import { runMigrations } from '../migrate';
import { databaseUrlFromEnv } from '../pool';

runMigrations(databaseUrlFromEnv('MIGRATION_DATABASE_URL')).then(
  () => {
    console.log('migrations applied');
  },
  (error: unknown) => {
    // The message only: a driver error can carry connection details.
    console.error('migration failed:', error instanceof Error ? error.message : 'unknown error');
    process.exitCode = 1;
  },
);

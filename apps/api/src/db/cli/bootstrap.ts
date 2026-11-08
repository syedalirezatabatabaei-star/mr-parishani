/**
 * `pnpm db:bootstrap`: creates or updates the database roles as a superuser
 * (DB_ADMIN_URL), with passwords from DB_OWNER_PASSWORD, DB_APP_PASSWORD and
 * DB_REPORT_PASSWORD.
 */
import { bootstrapDatabase } from '../bootstrap';
import { databaseUrlFromEnv } from '../pool';

function requiredSecret(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set`);
  return value;
}

Promise.resolve()
  .then(() =>
    bootstrapDatabase({
      adminUrl: databaseUrlFromEnv('DB_ADMIN_URL'),
      ownerPassword: requiredSecret('DB_OWNER_PASSWORD'),
      appPassword: requiredSecret('DB_APP_PASSWORD'),
      reportPassword: requiredSecret('DB_REPORT_PASSWORD'),
    }),
  )
  .then(
    () => {
      console.log('database roles ready');
    },
    (error: unknown) => {
      console.error('bootstrap failed:', error instanceof Error ? error.message : 'unknown error');
      process.exitCode = 1;
    },
  );

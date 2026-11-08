/**
 * The demo seed's accounts in one go (docs/decisions/demo-mode-decisions.md): what
 * `pnpm account:create` does for one account (StaffAuthService.createAccount), for a list read
 * from stdin as JSON [{ "kind": "staff" | "center", "username": "…" }], with the one password
 * of ACCOUNT_PASSWORD. Prints {"username": "accountId", …}. Run with cwd apps/api.
 */
const { createRequire } = require('node:module');
const { resolve } = require('node:path');

const api = createRequire(resolve(process.cwd(), 'package.json'));
api('reflect-metadata');
const { NestFactory } = api('@nestjs/core');
const { AppModule } = api('./dist/app.module');
const { StaffAuthService } = api('./dist/modules/identity/staff-auth.service');

async function main() {
  const password = process.env.ACCOUNT_PASSWORD;
  if (!password) throw new Error('ACCOUNT_PASSWORD is required');
  let input = '';
  for await (const chunk of process.stdin) input += chunk;
  const list = JSON.parse(input);
  const app = await NestFactory.createApplicationContext(AppModule, { logger: ['error'] });
  const ids = {};
  try {
    const auth = app.get(StaffAuthService);
    for (const { kind, username } of list) {
      ids[username] = await auth.createAccount({ kind, username, password });
    }
  } finally {
    await app.close();
  }
  process.stdout.write(JSON.stringify(ids));
}

main().catch((error) => {
  console.error(
    'account creation failed:',
    error instanceof Error ? error.message : 'unknown error',
  );
  process.exitCode = 1;
});

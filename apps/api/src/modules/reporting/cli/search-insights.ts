/**
 * `pnpm reporting:search-insights` (task 7-6; doc 17 §6): the search log's index suggestions as
 * Markdown on stdout, for a reviewed migration. Read only; it never creates an index.
 */
import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import type { EffectiveAccess } from '../../../common/auth/access.port';
import { AppModule } from '../../../app.module';
import { SearchInsightsService } from '../search-insights.service';

async function main(): Promise<void> {
  const app = await NestFactory.createApplicationContext(AppModule, { logger: ['error'] });
  try {
    // The operator at the console holds the database itself; only the permission is checked.
    const access = {
      permissions: new Set(['reporting.read_search']),
    } as unknown as EffectiveAccess;
    process.stdout.write(await app.get(SearchInsightsService).markdown(access));
  } finally {
    await app.close();
  }
}

main().catch((error: unknown) => {
  console.error(
    'search insights failed:',
    error instanceof Error ? error.message : 'unknown error',
  );
  process.exitCode = 1;
});

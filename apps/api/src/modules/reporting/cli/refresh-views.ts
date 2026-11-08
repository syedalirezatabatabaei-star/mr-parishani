/**
 * `pnpm reporting:refresh-views` (task 7-5): the reports' materialized views refreshed once now,
 * what the worker does every fifteen minutes (task 7-4), each refresh recorded. For an operator
 * who needs the dashboards fresh at once, and for the end-to-end stack. View names only.
 */
import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../../../app.module';
import { ReportService } from '../report.service';

async function main(): Promise<void> {
  const app = await NestFactory.createApplicationContext(AppModule, { logger: ['error'] });
  try {
    const done = await app.get(ReportService).refreshViews();
    console.log(`refreshed: ${done.join(', ')}`);
  } finally {
    await app.close();
  }
}

main().catch((error: unknown) => {
  console.error('refresh failed:', error instanceof Error ? error.message : 'unknown error');
  process.exitCode = 1;
});

/**
 * Entry point for apps/worker (ADR-016): builds the API's modules as an application
 * context without HTTP and starts the background runtime. Import it only after
 * startTelemetry() (`@sepehr/api/telemetry`), so that instrumentation is in place first.
 */
import 'reflect-metadata';
import type { INestApplicationContext } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { WorkerRuntime } from './infra/outbox/worker-runtime';
import { WorkerModule, type WorkerModuleOptions } from './worker.module';

export type { Alert, AlertSink } from './infra/ops/alerts';
export { CountingAlertSink } from './infra/ops/alerts';
export type { WorkerModuleOptions } from './worker.module';

export async function createWorkerContext(
  options: WorkerModuleOptions = {},
): Promise<INestApplicationContext> {
  const context = await NestFactory.createApplicationContext(WorkerModule.forRoot(options), {
    logger: ['error', 'warn', 'log'],
  });
  context.enableShutdownHooks();
  await context.get(WorkerRuntime).start();
  return context;
}

/** Task 6-4: the worker app records a notification's SMS as sent through this port. */
export { NOTIFICATIONS, type NotificationsPort } from './common/notification/notifications.port';

/** ADR-052: the SMS credit's metrics, and the configuration its threshold is read from. */
export { registerSmsCreditMetrics, type SmsCreditReading } from './infra/ops/sms-credit';
export { CONFIG, type ConfigPort } from './common/config/config.port';

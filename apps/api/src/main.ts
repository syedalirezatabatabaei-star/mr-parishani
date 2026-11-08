// First: instrumentation must be in place before pg, ioredis and Nest are loaded.
import './infra/telemetry-bootstrap';
import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { configureApp } from './configure-app';

async function bootstrap(): Promise<void> {
  // The raw body stays next to the parsed one: the lead webhook checks its HMAC over it.
  const app = await NestFactory.create(AppModule, { rawBody: true });
  configureApp(app);
  // HOST: this machine only unless set (owner 1405/08/09); the API image sets 0.0.0.0, since there
  // the port is published by Docker on the host's 127.0.0.1 (Dockerfile, stage api).
  await app.listen(process.env['PORT'] ?? 3000, process.env['HOST'] ?? '127.0.0.1');
}

void bootstrap();

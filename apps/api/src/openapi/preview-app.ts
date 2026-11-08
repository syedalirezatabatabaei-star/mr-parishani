import { NestFactory } from '@nestjs/core';
import { AppModule } from '../app.module';

/**
 * The API's module graph without starting anything (Nest preview mode): enough to read the
 * routes for the OpenAPI document, with the same global prefix as configureApp.
 */
export async function openApiApp() {
  const app = await NestFactory.create(AppModule, { preview: true, logger: false });
  app.setGlobalPrefix('api/v1');
  return app;
}

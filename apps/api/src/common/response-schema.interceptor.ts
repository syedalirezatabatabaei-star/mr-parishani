import {
  Injectable,
  type CallHandler,
  type ExecutionContext,
  type NestInterceptor,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { map, type Observable } from 'rxjs';
import type { z } from 'zod';
import { ZOD_RESPONSE } from './zod-response';

/**
 * Tests only (SEPEHR_CHECK_RESPONSES=1, set by the integration harness): every answer of a
 * route with `@ZodResponse` must match that schema, as JSON on the wire. So the OpenAPI
 * document, and the client generated from it, cannot promise what the API does not send.
 */
@Injectable()
export class ResponseSchemaInterceptor implements NestInterceptor {
  constructor(private readonly reflector: Reflector) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const schema = this.reflector.get<z.ZodType | undefined>(ZOD_RESPONSE, context.getHandler());
    if (!schema) return next.handle();
    const route = `${context.getClass().name}.${context.getHandler().name}`;
    return next.handle().pipe(
      map((body: unknown) => {
        if (body === undefined) return body;
        const wire: unknown = JSON.parse(JSON.stringify(body));
        const result = schema.safeParse(wire);
        if (!result.success) {
          const issues = result.error.issues
            .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
            .join('; ');
          throw new Error(`${route} answered outside its @ZodResponse schema: ${issues}`);
        }
        return body;
      }),
    );
  }
}

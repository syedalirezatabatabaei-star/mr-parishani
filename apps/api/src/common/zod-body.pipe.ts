import { BadRequestException, type PipeTransform } from '@nestjs/common';
import type { z } from 'zod';

/**
 * Validates and transforms a request body with a Zod schema from @sepehr/contracts.
 * The error lists field paths and messages only, never the submitted values.
 */
export class ZodBody<T extends z.ZodType> implements PipeTransform<unknown, z.output<T>> {
  /** Public: the OpenAPI document reads it (src/openapi). */
  constructor(readonly schema: T) {}

  transform(value: unknown): z.output<T> {
    const result = this.schema.safeParse(value);
    if (!result.success) {
      throw new BadRequestException({
        error: 'invalid_request',
        issues: result.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      });
    }
    return result.data;
  }
}

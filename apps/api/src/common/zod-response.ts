import { SetMetadata } from '@nestjs/common';
import type { z } from 'zod';

export const ZOD_RESPONSE = 'sepehr:zod-response';

/**
 * The schema of a route's success body, from @sepehr/contracts. It only describes: the
 * OpenAPI document (src/openapi) and the client generated from it read it (CLAUDE.md §5).
 */
export const ZodResponse = (schema: z.ZodType) => SetMetadata(ZOD_RESPONSE, schema);

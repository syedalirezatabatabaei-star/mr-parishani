import { Controller, Get, Query, Req } from '@nestjs/common';
import { searchQuerySchema, searchResponseSchema, type SearchQuery } from '@sepehr/contracts';
import type { Request } from 'express';
import { Public } from '../../common/auth/auth.decorators';
import { ZodBody } from '../../common/zod-body.pipe';
import { ZodResponse } from '../../common/zod-response';
import { SearchService } from './search.service';

/**
 * The public search of doctors and centers (task 2-7, doc 08 §9): no session, like the
 * treatment fields; the service applies the feature flag and the per-IP rate limit.
 */
@Controller('search')
export class SearchController {
  constructor(private readonly search: SearchService) {}

  @Public()
  @Get('doctors')
  @ZodResponse(searchResponseSchema)
  doctors(@Query(new ZodBody(searchQuerySchema)) query: SearchQuery, @Req() req: Request) {
    return this.search.search(query, req.ip ?? null);
  }
}

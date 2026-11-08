import { Injectable } from '@nestjs/common';
import { SEARCH_REPORTS } from './definitions/search.reports';
import { ticketsReport } from './definitions/tickets.report';
import { V1_REPORTS } from './definitions/v1.reports';
import type { ReportDefinition } from './report-definition';

/**
 * The reports defined in code (doc 17 §2 principle 2), by code. Task 7-4 adds the version-one
 * reports here, task 7-6 the search log's.
 */
@Injectable()
export class ReportRegistry {
  private readonly definitions = new Map<string, ReportDefinition>();

  constructor() {
    this.register(ticketsReport);
    for (const definition of V1_REPORTS) this.register(definition);
    for (const definition of SEARCH_REPORTS) this.register(definition);
  }

  register(definition: ReportDefinition): void {
    if (this.definitions.has(definition.code)) {
      throw new Error(`report ${definition.code} is defined twice`);
    }
    this.definitions.set(definition.code, definition);
  }

  get(code: string): ReportDefinition | undefined {
    return this.definitions.get(code);
  }

  all(): ReportDefinition[] {
    return [...this.definitions.values()];
  }
}

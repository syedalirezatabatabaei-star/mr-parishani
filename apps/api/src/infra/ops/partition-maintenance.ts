import { Inject, Injectable, Logger } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { CONFIG, type ConfigPort } from '../../common/config/config.port';
import { DATABASE, type Database } from '../../db/database.module';

/** Months of partitions created ahead of the current one. */
export const MONTHS_AHEAD = 12;

/** First day of the UTC month `offset` months from `date`'s month, as YYYY-MM-DD. */
export function utcMonthStart(date: Date, offset = 0): string {
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + offset, 1));
  return d.toISOString().slice(0, 10);
}

export interface MaintenanceResult {
  readonly created: number;
  readonly detached: readonly string[];
  /** Outbox months past the retention that still hold unpublished events. */
  readonly keptPending: readonly string[];
}

/** The partitioned tables, and the configuration that sets how long each stays attached. */
const GROUPS = [
  { parents: ['audit_events', 'access_logs'], retention: 'audit.retention' },
  { parents: ['outbox_events', 'processed_events'], retention: 'ops.outbox_retention' },
  // Ledger months are created ahead and never archived: balances sum every entry.
  { parents: ['ledger_entries'], retention: null },
] as const;

/**
 * Creates the coming months' partitions and archives (detaches, never drops) those past
 * their retention, for every monthly-partitioned table. Runs daily from the worker's
 * scheduler, as the application role, through the SECURITY DEFINER function
 * maintain_monthly_partitions (migration 0004).
 */
@Injectable()
export class PartitionMaintenance {
  private readonly logger = new Logger(PartitionMaintenance.name);

  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(CONFIG) private readonly config: ConfigPort,
  ) {}

  async run(now = new Date()): Promise<MaintenanceResult> {
    let created = 0;
    const detached: string[] = [];
    const keptPending: string[] = [];
    for (const group of GROUPS) {
      const cutoff =
        group.retention === null
          ? '1970-01-01'
          : utcMonthStart(now, -(await this.config.resolve(group.retention, {}, now)).value.months);
      const result = await this.db.execute<{ result: MaintenanceResult }>(sql`
        SELECT public.maintain_monthly_partitions(
          ${sql.param([...group.parents])}::text[], ${utcMonthStart(now)}::date,
          ${MONTHS_AHEAD + 1}, ${cutoff}::date
        ) AS result
      `);
      const outcome = result.rows[0]?.result;
      created += outcome?.created ?? 0;
      detached.push(...(outcome?.detached ?? []));
      keptPending.push(...(outcome?.keptPending ?? []));
    }
    if (keptPending.length > 0) {
      this.logger.error(
        `partitions past retention kept for unpublished events: ${keptPending.join(', ')}`,
      );
    }
    return { created, detached, keptPending };
  }
}

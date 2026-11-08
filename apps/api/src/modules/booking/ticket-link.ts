import { Inject, Injectable, Optional, type OnModuleInit } from '@nestjs/common';
import { formatJalaliDateTime } from '@sepehr/contracts';
import { sql } from 'drizzle-orm';
import type { SqlExecutor } from '../../common/audit/audit.port';
import {
  WORKPLACE_DIRECTORY,
  type WorkplaceDirectory,
} from '../../common/catalog/workplace-directory.port';
import {
  scopeCovers,
  TICKET_LINK_TARGETS,
  type TicketLinkTarget,
  type TicketLinkTargetRegistry,
  type TicketRequester,
} from '../../common/ticket/ticket-link-targets.port';
import { DATABASE, type Database } from '../../db/database.module';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * A ticket's link to an appointment (task 7-1; doc 17 §1), read only: the patient's own (their
 * account, or any of their merged persons), or one at a workplace the center user's scope
 * covers. Labelled by its Tehran time only.
 */
@Injectable()
export class AppointmentTicketLink implements TicketLinkTarget, OnModuleInit {
  readonly type = 'appointment' as const;

  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(WORKPLACE_DIRECTORY) private readonly workplaces: WorkplaceDirectory,
    @Optional() @Inject(TICKET_LINK_TARGETS) private readonly registry?: TicketLinkTargetRegistry,
  ) {}

  onModuleInit(): void {
    this.registry?.register(this);
  }

  async resolve(id: string, who: TicketRequester, tx?: SqlExecutor): Promise<string | null> {
    if (!UUID.test(id)) return null;
    const row = (
      await (tx ?? this.db).execute(sql`
        SELECT workplace_id, patient_account_id, person_id, starts_at
        FROM appointments WHERE id = ${id}
      `)
    ).rows[0];
    if (!row) return null;
    let reachable: boolean;
    if (who.kind === 'person') {
      reachable =
        (who.accountId !== null && row['patient_account_id'] === who.accountId) ||
        (row['person_id'] !== null && who.personIds.includes(row['person_id'] as string));
    } else {
      const workplace = await this.workplaces.workplace(row['workplace_id'] as string);
      reachable = workplace !== null && scopeCovers(who.access, workplace.nodePath);
    }
    if (!reachable) return null;
    return `نوبت ${formatJalaliDateTime(new Date(row['starts_at'] as string), { digits: 'fa' })}`;
  }

  async workplaceNodePath(id: string, tx?: SqlExecutor): Promise<string | null> {
    if (!UUID.test(id)) return null;
    const row = (
      await (tx ?? this.db).execute(sql`SELECT workplace_id FROM appointments WHERE id = ${id}`)
    ).rows[0];
    if (!row) return null;
    return (await this.workplaces.workplace(row['workplace_id'] as string))?.nodePath ?? null;
  }
}

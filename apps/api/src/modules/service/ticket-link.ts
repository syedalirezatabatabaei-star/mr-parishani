import { Inject, Injectable, Optional, type OnModuleInit } from '@nestjs/common';
import { formatJalaliDateTime } from '@sepehr/contracts';
import { sql } from 'drizzle-orm';
import type { SqlExecutor } from '../../common/audit/audit.port';
import {
  WORKPLACE_DIRECTORY,
  type WorkplaceDirectory,
} from '../../common/catalog/workplace-directory.port';
import {
  CREDIT_CONTRACT_FACTS,
  type CreditContractFactsPort,
} from '../../common/credit/credit-contract-facts.port';
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
 * A ticket's link to a service authorization (task 7-1; doc 17 §1), read only, by the same
 * rules as the patient's and the center's own lists (`mine`, `reachByScope`): one of an
 * application where the person is the patient or the borrower, or one at a workplace the
 * center user's scope covers.
 */
@Injectable()
export class ServiceTicketLink implements TicketLinkTarget, OnModuleInit {
  readonly type = 'service' as const;

  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(WORKPLACE_DIRECTORY) private readonly workplaces: WorkplaceDirectory,
    @Inject(CREDIT_CONTRACT_FACTS) private readonly credit: CreditContractFactsPort,
    @Optional() @Inject(TICKET_LINK_TARGETS) private readonly registry?: TicketLinkTargetRegistry,
  ) {}

  onModuleInit(): void {
    this.registry?.register(this);
  }

  async resolve(id: string, who: TicketRequester, tx?: SqlExecutor): Promise<string | null> {
    if (!UUID.test(id)) return null;
    const row = (
      await (tx ?? this.db).execute(sql`
        SELECT credit_application_id, workplace_id, issued_at
        FROM service_authorizations WHERE id = ${id}
      `)
    ).rows[0];
    if (!row) return null;
    let reachable: boolean;
    if (who.kind === 'person') {
      reachable =
        who.personIds.length > 0 &&
        (await this.credit.applicationsOf(who.personIds)).includes(
          row['credit_application_id'] as string,
        );
    } else {
      const workplace = await this.workplaces.workplace(row['workplace_id'] as string);
      reachable = workplace !== null && scopeCovers(who.access, workplace.nodePath);
    }
    if (!reachable) return null;
    return `خدمت ${formatJalaliDateTime(new Date(row['issued_at'] as string))}`;
  }
}

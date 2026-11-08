import { Inject, Injectable, Optional, type OnModuleInit } from '@nestjs/common';
import { toPersianDigits, type TicketLinkType } from '@sepehr/contracts';
import { sql } from 'drizzle-orm';
import type { SqlExecutor } from '../../common/audit/audit.port';
import {
  TICKET_LINK_TARGETS,
  type TicketLinkTarget,
  type TicketLinkTargetRegistry,
  type TicketRequester,
} from '../../common/ticket/ticket-link-targets.port';
import { WALLET, type WalletPort } from '../../common/wallet/wallet.port';
import { DATABASE, type Database } from '../../db/database.module';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * A ticket's links to an installment and to a slip or payment (task 7-1; doc 17 §1), read
 * only: only the borrower's own, as `/me/repayment` decides (task 6-9: the schedule's purse
 * borrowed by one of their merged persons). A center never reaches them.
 */
abstract class BorrowerLink implements TicketLinkTarget, OnModuleInit {
  abstract readonly type: TicketLinkType;

  constructor(
    protected readonly db: Database,
    private readonly wallet: WalletPort,
    private readonly registry?: TicketLinkTargetRegistry,
  ) {}

  onModuleInit(): void {
    this.registry?.register(this);
  }

  protected abstract row(
    id: string,
    tx?: SqlExecutor,
  ): Promise<{ purseId: string; label: string } | null>;

  async resolve(id: string, who: TicketRequester, tx?: SqlExecutor): Promise<string | null> {
    if (who.kind !== 'person' || who.personIds.length === 0 || !UUID.test(id)) return null;
    const found = await this.row(id, tx);
    if (!found) return null;
    const summary = await this.wallet.summary(found.purseId, tx);
    return who.personIds.includes(summary.borrowerPersonId) ? found.label : null;
  }
}

@Injectable()
export class InstallmentTicketLink extends BorrowerLink {
  readonly type = 'installment' as const;

  constructor(
    @Inject(DATABASE) db: Database,
    @Inject(WALLET) wallet: WalletPort,
    @Optional() @Inject(TICKET_LINK_TARGETS) registry?: TicketLinkTargetRegistry,
  ) {
    super(db, wallet, registry);
  }

  protected async row(id: string, tx?: SqlExecutor) {
    const r = (
      await (tx ?? this.db).execute(sql`
        SELECT s.purse_id, i.index FROM installments i
        JOIN installment_schedules s ON s.id = i.schedule_id
        WHERE i.id = ${id}
      `)
    ).rows[0];
    return r
      ? { purseId: r['purse_id'] as string, label: `قسط ${toPersianDigits(String(r['index']))}` }
      : null;
  }
}

@Injectable()
export class PaymentTicketLink extends BorrowerLink {
  readonly type = 'payment' as const;

  constructor(
    @Inject(DATABASE) db: Database,
    @Inject(WALLET) wallet: WalletPort,
    @Optional() @Inject(TICKET_LINK_TARGETS) registry?: TicketLinkTargetRegistry,
  ) {
    super(db, wallet, registry);
  }

  protected async row(id: string, tx?: SqlExecutor) {
    const r = (
      await (tx ?? this.db).execute(sql`
        SELECT s.purse_id FROM payments p
        JOIN installment_schedules s ON s.id = p.schedule_id
        WHERE p.id = ${id}
      `)
    ).rows[0];
    return r ? { purseId: r['purse_id'] as string, label: 'فیش واریزی' } : null;
  }
}

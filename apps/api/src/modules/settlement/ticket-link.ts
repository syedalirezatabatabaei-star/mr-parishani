import {
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
  Optional,
  type OnModuleInit,
} from '@nestjs/common';
import { toPersianDigits } from '@sepehr/contracts';
import {
  TICKET_LINK_TARGETS,
  type TicketLinkTarget,
  type TicketLinkTargetRegistry,
  type TicketRequester,
} from '../../common/ticket/ticket-link-targets.port';
import { DisputeService } from './dispute.service';
import { SettlementPanelService } from './panel.service';

/**
 * A ticket's link to a doctor's settlement statement (task 7-1; doc 17 §1), read only: exactly
 * what the doctor's panel shows them (task 5-6: every doctor node of it theirs, and
 * settlement.read_own), through that panel's own rule. A patient never reaches one.
 */
@Injectable()
export class StatementTicketLink implements TicketLinkTarget, OnModuleInit {
  readonly type = 'statement' as const;

  constructor(
    private readonly panel: SettlementPanelService,
    @Optional() @Inject(TICKET_LINK_TARGETS) private readonly registry?: TicketLinkTargetRegistry,
  ) {}

  onModuleInit(): void {
    this.registry?.register(this);
  }

  /** Read through the panel's own rule, outside the caller's transaction. */
  async resolve(id: string, who: TicketRequester): Promise<string | null> {
    if (who.kind !== 'org') return null;
    try {
      const statement = await this.panel.statement(who.access, id);
      return `صورت‌وضعیت ${toPersianDigits(
        `${String(statement.periodYear)}/${String(statement.periodMonth).padStart(2, '0')}`,
      )}`;
    } catch (error) {
      if (error instanceof NotFoundException || error instanceof ForbiddenException) return null;
      throw error;
    }
  }
}

/**
 * Task 7-2: a ticket's link to a doctor's payable or a service fee, the item a financial
 * complaint holds: only what the caller could open a dispute on (5-2's own reach).
 */
abstract class SettlementItemLink implements TicketLinkTarget, OnModuleInit {
  abstract readonly type: 'doctor_payable' | 'service_fee';

  constructor(
    private readonly disputes: DisputeService,
    private readonly registry?: TicketLinkTargetRegistry,
  ) {}

  onModuleInit(): void {
    this.registry?.register(this);
  }

  async resolve(id: string, who: TicketRequester): Promise<string | null> {
    if (who.kind !== 'org') return null;
    return this.disputes.itemLabel(who.access, this.type, id);
  }
}

@Injectable()
export class PayableTicketLink extends SettlementItemLink {
  readonly type = 'doctor_payable' as const;

  constructor(
    disputes: DisputeService,
    @Optional() @Inject(TICKET_LINK_TARGETS) registry?: TicketLinkTargetRegistry,
  ) {
    super(disputes, registry);
  }
}

@Injectable()
export class FeeTicketLink extends SettlementItemLink {
  readonly type = 'service_fee' as const;

  constructor(
    disputes: DisputeService,
    @Optional() @Inject(TICKET_LINK_TARGETS) registry?: TicketLinkTargetRegistry,
  ) {
    super(disputes, registry);
  }
}

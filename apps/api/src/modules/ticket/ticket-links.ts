import { Injectable } from '@nestjs/common';
import type { TicketLinkType } from '@sepehr/contracts';
import type { SqlExecutor } from '../../common/audit/audit.port';
import type {
  TicketLinkTarget,
  TicketLinkTargetRegistry,
  TicketRequester,
} from '../../common/ticket/ticket-link-targets.port';

/**
 * The link targets the owning modules registered (task 7-1): one per type. A type no module
 * registered resolves like a record that does not exist.
 */
@Injectable()
export class TicketLinks implements TicketLinkTargetRegistry {
  private readonly targets = new Map<TicketLinkType, TicketLinkTarget>();

  register(target: TicketLinkTarget): void {
    if (this.targets.has(target.type)) {
      throw new Error(`ticket link target ${target.type} is registered twice`);
    }
    this.targets.set(target.type, target);
  }

  async resolve(
    type: TicketLinkType,
    id: string,
    requester: TicketRequester,
    tx?: SqlExecutor,
  ): Promise<string | null> {
    const target = this.targets.get(type);
    return target ? target.resolve(id, requester, tx) : null;
  }

  /** Task 7-2: the workplace node of an appointment or a proforma, or null. */
  async workplaceNodePath(
    type: TicketLinkType,
    id: string,
    tx?: SqlExecutor,
  ): Promise<string | null> {
    const target = this.targets.get(type);
    return target?.workplaceNodePath ? target.workplaceNodePath(id, tx) : null;
  }
}

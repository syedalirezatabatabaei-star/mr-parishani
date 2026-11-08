import { Global, Module } from '@nestjs/common';
import { TICKET_LINK_TARGETS } from '../../common/ticket/ticket-link-targets.port';
import { DisputeDecidedTickets, ProformaDisputeTickets } from './ticket.consumer';
import {
  CenterTicketController,
  ComplaintResponseController,
  PatientTicketController,
  StaffTicketController,
} from './ticket.controller';
import { TicketLinks } from './ticket-links';
import { TicketService } from './ticket.service';
import { TICKET_REQUESTERS } from '../../common/ticket/ticket-requesters.port';
import { TicketRequesterDirectory } from './ticket-requesters';

/**
 * The ticket module's core (task 7-1; doc 17 §1): tickets and their sweep, which the worker
 * runs too (ADR-016), the `proforma.disputed` consumer, and TICKET_LINK_TARGETS, where the
 * owning modules register what a ticket may point at. Global for that registry.
 */
@Global()
@Module({
  providers: [
    TicketService,
    TicketLinks,
    { provide: TICKET_LINK_TARGETS, useExisting: TicketLinks },
    ProformaDisputeTickets,
    DisputeDecidedTickets,
    // Owner 1405/08/10: a ticket's parties, for the bell.
    { provide: TICKET_REQUESTERS, useClass: TicketRequesterDirectory },
  ],
  exports: [TicketService, TICKET_LINK_TARGETS, TICKET_REQUESTERS],
})
export class TicketCoreModule {}

/** The ticket module as the API serves it: the three sides' endpoints on top of the core. */
@Module({
  imports: [TicketCoreModule],
  controllers: [
    PatientTicketController,
    CenterTicketController,
    ComplaintResponseController,
    StaffTicketController,
  ],
})
export class TicketModule {}

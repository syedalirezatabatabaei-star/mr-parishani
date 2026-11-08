import * as z from 'zod';
import { normalizePersianText } from '../text/persian.js';

/**
 * Tickets (task 7-1; doc 17 §1): opened by a patient, a center or staff for a caller; a topic
 * that names the destination unit and the response deadline (configuration); links to what
 * the requester may reach; a conversation whose internal messages only staff see; a life from
 * `open` to `closed`, with the deadline paused while waiting on the requester. Complaints
 * (`kind: complaint`) come with task 7-2.
 */

export const TICKET_STATUSES = [
  'open',
  'assigned',
  'in_progress',
  'waiting_on_requester',
  'resolved',
  'closed',
  'reopened',
] as const;
export type TicketStatus = (typeof TICKET_STATUSES)[number];

/** Not resolved or closed: worked, assignable, transferable. */
export const TICKET_LIVE_STATUSES: readonly TicketStatus[] = [
  'open',
  'assigned',
  'in_progress',
  'waiting_on_requester',
  'reopened',
];

/**
 * What a ticket may point at (doc 17 §1), each checked by its owning module against the
 * requester. The wallet's transactions are not here yet (task 7-1 decision ت۸).
 */
export const TICKET_LINK_TYPES = [
  'appointment',
  'proforma',
  'service',
  'installment',
  'payment',
  'statement',
  // Task 7-2: a doctor's settlement items, which a financial complaint holds (5-2).
  'doctor_payable',
  'service_fee',
] as const;
export type TicketLinkType = (typeof TICKET_LINK_TYPES)[number];

/** `internal`: staff for nobody outside (task 7-2: the disputes of 5-2 before tickets). */
export const TICKET_CHANNELS = ['patient', 'center', 'staff', 'internal'] as const;
export type TicketChannel = (typeof TICKET_CHANNELS)[number];

/** Task 7-2: a complaint (doc 17 §1), financial when its topic says so. */
export const TICKET_KINDS = ['ticket', 'complaint'] as const;
export type TicketKind = (typeof TICKET_KINDS)[number];

/** What a complaint about a doctor may point at, to reach their panel (doc 17 §1). */
export const RESPONDENT_LINK_TYPES: readonly TicketLinkType[] = ['appointment', 'proforma'];

/** What a financial complaint holds (5-2): exactly one of these. */
export const FINANCIAL_LINK_TYPES: readonly TicketLinkType[] = ['doctor_payable', 'service_fee'];

/** Treatment records: never shown to the collection unit (doc 04 §4; doc 17 §1; test 4). */
export const TREATMENT_LINK_TYPES: readonly TicketLinkType[] = [
  'appointment',
  'proforma',
  'service',
];

export const TICKET_EVENT_KINDS = [
  'opened',
  'assigned',
  'status',
  'transferred',
  'sla_warning',
  'sla_breached',
] as const;
export type TicketEventKind = (typeof TICKET_EVENT_KINDS)[number];

/** A unit is a role code (doc 04): its holders with ticket.work take its queue. */
const unitCode = z.string().regex(/^[a-z][a-z_]{1,39}$/);
const topicCode = z.string().regex(/^[a-z][a-z_]{1,39}$/);

// --- configuration ------------------------------------------------------------------------

/**
 * The topics (doc 17 §1; 7.5): each to a unit and a response deadline in hours, locked on
 * the ticket when it is opened. 0 hours: no deadline (CLAUDE.md §4: 0 at first).
 */
export const ticketTopicsSchema = z
  .array(
    z.strictObject({
      code: topicCode,
      title: z.string().transform(normalizePersianText).pipe(z.string().min(2).max(80)),
      unit: unitCode,
      responseHours: z.number().int().min(0).max(8760),
      active: z.boolean(),
      /** Task 7-2: a complaint, and whether it is financial (holds its item, 5-2). */
      kind: z.enum(TICKET_KINDS).default('ticket'),
      financial: z.boolean().default(false),
    }),
  )
  .max(100)
  .refine((t) => new Set(t.map((x) => x.code)).size === t.length, 'unique codes')
  .refine((t) => t.every((x) => !x.financial || x.kind === 'complaint'), 'financial: a complaint');
export type TicketTopic = z.output<typeof ticketTopicsSchema>[number];

// --- inputs -------------------------------------------------------------------------------

const text = (min: number, max: number) =>
  z.string().transform(normalizePersianText).pipe(z.string().min(min).max(max));
const reason = text(3, 1000);

export const ticketLinkInputSchema = z.strictObject({
  type: z.enum(TICKET_LINK_TYPES),
  id: z.uuid(),
});

const openBase = {
  topicCode,
  subject: text(3, 200),
  body: text(1, 4000),
  links: z.array(ticketLinkInputSchema).max(5).default([]),
};

/** A patient's own ticket (`/me/tickets`). */
export const openTicketSchema = z.strictObject(openBase);

/** A center's ticket: from one of the caller's nodes (the first center scope if omitted). */
export const openCenterTicketSchema = z.strictObject({ ...openBase, nodeId: z.uuid().optional() });

/** Staff for a caller (doc 17 §1): the caller's mobile; links are checked against that person. */
export const openTicketOnBehalfSchema = z.strictObject({
  ...openBase,
  mobile: z.string().min(10).max(16),
});

export const ticketMessageSchema = z.strictObject({
  body: text(1, 4000),
  /** Task 7-2: it tells of the treatment; hidden from the collection unit. */
  containsTreatment: z.boolean().default(false),
});

/** Staff only: an internal note is never shown to the requester (test 3). */
export const staffTicketMessageSchema = z.strictObject({
  body: text(1, 4000),
  visibility: z.enum(['public', 'internal']),
  containsTreatment: z.boolean().default(false),
});

/** Task 7-2: staff mark a message as telling of the treatment, after it was written. */
export const flagTicketMessageSchema = z.strictObject({ reason });

export const ticketStatusChangeSchema = z.strictObject({
  to: z.enum(['in_progress', 'waiting_on_requester', 'resolved']),
  note: text(1, 1000).optional(),
});

export const transferTicketSchema = z.strictObject({ unit: unitCode, reason });
export const assignTicketSchema = z.strictObject({ accountId: z.uuid(), reason });
export const reopenTicketSchema = z.strictObject({ reason });

/** Multipart fields with an attachment. */
export const ticketAttachmentFieldsSchema = z.strictObject({
  containsTreatment: z.enum(['true', 'false']).default('false'),
  visibility: z.enum(['public', 'internal']).default('public'),
});

export const ticketQueueQuerySchema = z.strictObject({
  unit: unitCode.optional(),
  status: z.enum(TICKET_STATUSES).optional(),
  mine: z.enum(['true', 'false']).optional(),
});

// --- views --------------------------------------------------------------------------------

const instant = z.iso.datetime({ offset: true });

export const ticketSummarySchema = z.object({
  id: z.uuid(),
  number: z.number().int(),
  kind: z.enum(TICKET_KINDS),
  topicCode: z.string(),
  subject: z.string(),
  status: z.enum(TICKET_STATUSES),
  unit: z.string(),
  channel: z.enum(TICKET_CHANNELS),
  openedAt: instant,
  dueAt: instant.nullable(),
  paused: z.boolean(),
  resolvedAt: instant.nullable(),
  closedAt: instant.nullable(),
});
export type TicketSummary = z.output<typeof ticketSummarySchema>;

/** The staff queue's row: who has it, and whether its deadline has passed. */
export const ticketQueueRowSchema = ticketSummarySchema.extend({
  assigneeAccountId: z.uuid().nullable(),
  overdue: z.boolean(),
});
export type TicketQueueRow = z.output<typeof ticketQueueRowSchema>;

export const ticketLinkViewSchema = z.object({
  type: z.enum(TICKET_LINK_TYPES),
  id: z.uuid(),
  label: z.string(),
});

export const ticketMessageViewSchema = z.object({
  id: z.uuid(),
  side: z.enum(['requester', 'staff', 'respondent']),
  /** Only in staff views; the requester's view has no internal message at all. */
  visibility: z.enum(['public', 'internal']).optional(),
  body: z.string(),
  /** Only in staff views. */
  containsTreatment: z.boolean().optional(),
  createdAt: instant,
});

export const ticketAttachmentViewSchema = z.object({
  id: z.uuid(),
  messageId: z.uuid().nullable(),
  contentType: z.string(),
  sizeBytes: z.number().int(),
  containsTreatment: z.boolean(),
  createdAt: instant,
});

export const ticketEventViewSchema = z.object({
  kind: z.enum(TICKET_EVENT_KINDS),
  fromStatus: z.enum(TICKET_STATUSES).nullable(),
  toStatus: z.enum(TICKET_STATUSES).nullable(),
  fromUnit: z.string().nullable(),
  toUnit: z.string().nullable(),
  reason: z.string().nullable(),
  createdAt: instant,
});

/** The requester's view: public messages and attachments only. */
export const ticketViewSchema = ticketSummarySchema.extend({
  links: z.array(ticketLinkViewSchema),
  messages: z.array(ticketMessageViewSchema),
  attachments: z.array(ticketAttachmentViewSchema),
  canReopen: z.boolean(),
});
export type TicketView = z.output<typeof ticketViewSchema>;

/** Staff's view: everything, with the history. */
export const staffTicketViewSchema = ticketViewSchema.extend({
  assigneeAccountId: z.uuid().nullable(),
  requesterPersonId: z.uuid().nullable(),
  requesterAccountId: z.uuid().nullable(),
  requesterNodeId: z.uuid().nullable(),
  events: z.array(ticketEventViewSchema),
  /** Task 7-2: the dispute a financial complaint holds its item by, and its state. */
  financialDisputeId: z.uuid().nullable(),
  disputeStatus: z.string().nullable(),
});
export type StaffTicketView = z.output<typeof staffTicketViewSchema>;

/** A topic as the opener picks it (task 7-7): no unit and no deadline, which are staff's. */
export const ticketTopicOptionSchema = z.object({
  code: z.string(),
  title: z.string(),
  kind: z.enum(TICKET_KINDS),
  financial: z.boolean(),
});
export type TicketTopicOption = z.output<typeof ticketTopicOptionSchema>;

/** Task 7-7: an agent of a unit, to assign a ticket to: the name and unit only, no contact. */
export const ticketAgentSchema = z.object({
  accountId: z.uuid(),
  name: z.string(),
  unit: z.string(),
});
export type TicketAgent = z.output<typeof ticketAgentSchema>;

export const ticketAttachmentLinkSchema = z.object({ url: z.string(), expiresInSeconds: z.int() });

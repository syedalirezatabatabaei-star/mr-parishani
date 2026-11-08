import {
  DELIVERY_ITEM_KINDS,
  DELIVERY_ITEM_STATUSES,
  DELIVERY_METHODS,
  DELIVERY_STATUSES,
  INSTRUMENT_KINDS,
  INSTRUMENT_STATUSES,
} from '@sepehr/contracts';
import { sql } from 'drizzle-orm';
import { boolean, check, date, index, pgTable, text, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { id, rial, timestamps, timestamptz } from '../../db/columns';

/**
 * Physical deliveries (doc 12 §3; task 4-2): what is expected of a decided credit
 * application at the office, how it came and where it is kept. The application and persons
 * belong to other modules (ids here).
 */
export const physicalDeliveries = pgTable(
  'physical_deliveries',
  {
    id: id(),
    creditApplicationId: uuid('credit_application_id').notNull(),
    status: text('status', { enum: DELIVERY_STATUSES }).notNull().default('awaiting_send'),
    method: text('method', { enum: DELIVERY_METHODS }),
    trackingCode: text('tracking_code'),
    sentAt: timestamptz('sent_at'),
    receivedBy: uuid('received_by'),
    receivedAt: timestamptz('received_at'),
    archiveLocation: text('archive_location'),
    returnReason: text('return_reason'),
    createdBy: uuid('created_by').notNull(),
    ...timestamps(),
  },
  (t) => [
    index('physical_deliveries_application_idx').on(t.creditApplicationId),
    check(
      'physical_deliveries_received_check',
      sql`(${t.status} IN ('awaiting_send', 'sent')) = (${t.receivedAt} IS NULL)`,
    ),
  ],
);

/** One item expected in a delivery, and whether it came. */
export const physicalDeliveryItems = pgTable(
  'physical_delivery_items',
  {
    id: id(),
    deliveryId: uuid('delivery_id')
      .notNull()
      .references(() => physicalDeliveries.id),
    kind: text('kind', { enum: DELIVERY_ITEM_KINDS }).notNull(),
    label: text('label').notNull(),
    status: text('status', { enum: DELIVERY_ITEM_STATUSES }).notNull().default('expected'),
    ...timestamps(),
  },
  (t) => [index('physical_delivery_items_delivery_idx').on(t.deliveryId)],
);

/**
 * A cheque or promissory note (doc 12 §3). Its number is stored encrypted (rule 27,
 * context `instruments.number`) with a blind index to find it, and only its last four
 * characters are ever shown; never logged or sent by SMS.
 */
export const instruments = pgTable(
  'instruments',
  {
    id: id(),
    creditApplicationId: uuid('credit_application_id').notNull(),
    deliveryId: uuid('delivery_id').references(() => physicalDeliveries.id),
    itemId: uuid('item_id').references(() => physicalDeliveryItems.id),
    kind: text('kind', { enum: INSTRUMENT_KINDS }).notNull(),
    issuerPersonId: uuid('issuer_person_id').notNull(),
    role: text('role', { enum: ['borrower', 'guarantor'] }).notNull(),
    guarantorId: uuid('guarantor_id'),
    amountRial: rial('amount_rial').notNull(),
    dueOn: date('due_on'),
    bankName: text('bank_name'),
    numberEnc: text('number_enc').notNull(),
    numberBidx: text('number_bidx').notNull(),
    numberLast4: text('number_last4').notNull(),
    sayadRegisteredConfirmed: boolean('sayad_registered_confirmed').notNull().default(false),
    sayadConfirmedAt: timestamptz('sayad_confirmed_at'),
    sayadConfirmedBy: uuid('sayad_confirmed_by'),
    status: text('status', { enum: INSTRUMENT_STATUSES }).notNull().default('received'),
    notes: text('notes'),
    createdBy: uuid('created_by').notNull(),
    ...timestamps(),
  },
  (t) => [
    index('instruments_application_idx').on(t.creditApplicationId),
    // A number is one instrument of its kind (a cheque's Sayad number is unique).
    uniqueIndex('instruments_number_key')
      .on(t.kind, t.numberBidx)
      .where(sql`${t.deletedAt} IS NULL`),
    uniqueIndex('instruments_item_key')
      .on(t.itemId)
      .where(sql`${t.itemId} IS NOT NULL AND ${t.deletedAt} IS NULL`),
    check('instruments_amount_check', sql`${t.amountRial} > 0`),
    check(
      'instruments_role_check',
      sql`(${t.role} = 'guarantor') = (${t.guarantorId} IS NOT NULL)`,
    ),
    check(
      'instruments_sayad_check',
      sql`${t.sayadRegisteredConfirmed} = (${t.sayadConfirmedAt} IS NOT NULL)
          AND (NOT ${t.sayadRegisteredConfirmed} OR ${t.kind} = 'cheque')`,
    ),
  ],
);

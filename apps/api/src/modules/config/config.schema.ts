import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  customType,
  date,
  index,
  integer,
  pgTable,
  text,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { id, timestamps, timestamptz } from '../../db/columns';

/**
 * jsonb read exactly once. node-postgres already parses jsonb; Drizzle's own jsonb column
 * parses a string value a second time, so the rial amount "10000" came back as the
 * number 10000. Configuration values are often such strings (money, rule 1).
 */
const jsonValue = customType<{ data: unknown; driverData: unknown }>({
  dataType: () => 'jsonb',
  toDriver: (value) => JSON.stringify(value),
  fromDriver: (value) => value,
});

/**
 * Mirror of CONFIG_KEYS in @sepehr/contracts, filled by migrations only. Values reference
 * it, so no value exists for a key the API does not know; the API refuses to start while
 * the two differ. `sensitive` is here too so that the database itself enforces
 * two-person approval.
 */
export const configKeys = pgTable(
  'config_keys',
  {
    id: id(),
    code: text('code').notNull(),
    category: text('category', { enum: ['business', 'technical'] }).notNull(),
    sensitive: boolean('sensitive').notNull(),
    ...timestamps(),
  },
  (t) => [uniqueIndex('config_keys_code_key').on(t.code)],
);

/**
 * One version of one key at one level (ADR-006, ADR-010). A change is a new row, proposed
 * by one person and, for a sensitive key, approved by another; only the decision is ever
 * written to an existing row, and the database refuses anything else. A value never
 * starts in the past, so the value in effect at any past moment never changes.
 *
 * Read only through the config module's resolve() (the CONFIG port).
 */
export const configValues = pgTable(
  'config_values',
  {
    id: id(),
    key: text('key')
      .notNull()
      .references(() => configKeys.code),
    scopeLevel: text('scope_level', {
      enum: ['global', 'city', 'treatment_field', 'center', 'doctor'],
    }).notNull(),
    /** City or treatment-field code, or org node id; null at the global level. */
    scopeRef: text('scope_ref'),
    /** Null withdraws this level's value: the level above applies again. */
    value: jsonValue('value'),
    /** Null while proposed "from approval"; set to the approval time then. */
    effectiveAt: timestamptz('effective_at'),
    status: text('status', { enum: ['proposed', 'approved', 'rejected', 'expired'] })
      .notNull()
      .default('proposed'),
    reason: text('reason').notNull(),
    /** Null only for the values seeded by migrations. */
    proposedBy: uuid('proposed_by'),
    decidedBy: uuid('decided_by'),
    decidedAt: timestamptz('decided_at'),
    ...timestamps(),
  },
  (t) => [
    index('config_values_lookup_idx')
      .on(t.key, t.scopeLevel, t.scopeRef, t.effectiveAt)
      .where(sql`${t.status} = 'approved' AND ${t.deletedAt} IS NULL`),
    index('config_values_key_created_idx').on(t.key, t.createdAt),
  ],
);

/**
 * Official holidays (task 2-1, doc 08 §5, ADR-011): national (no city) or for one city.
 * Entered from the panel by the system admin; lunar holidays cannot be computed, so
 * nothing is seeded. A day is a Tehran calendar day. Removing one is a soft delete.
 * Read only through the HOLIDAY_CALENDAR port.
 */
export const holidays = pgTable(
  'holidays',
  {
    id: id(),
    holidayOn: date('holiday_on', { mode: 'string' }).notNull(),
    title: text('title').notNull(),
    kind: text('kind', { enum: ['national', 'city'] }).notNull(),
    cityCode: text('city_code'),
    createdBy: uuid('created_by'),
    deletedBy: uuid('deleted_by'),
    ...timestamps(),
  },
  (t) => [
    uniqueIndex('holidays_day_scope_key')
      .on(t.holidayOn, sql`coalesce(${t.cityCode}, '')`)
      .where(sql`${t.deletedAt} IS NULL`),
  ],
);

/**
 * Holidays saved together (owner 1405/07/24, plan 3; ADR-043; migration 0089): one person asks
 * with the days and a reason, a second approves or rejects. Approved, every day is added in
 * one transaction, or none: a day already in the calendar is refused, never written over.
 * `affectedContracts` is the plan 3 (a) count when asked; the approver sees it again, fresh.
 */
export const holidayBatches = pgTable(
  'holiday_batches',
  {
    id: id(),
    year: integer('year').notNull(),
    /** [{ on: 'YYYY-MM-DD', title }], national days, in order. */
    days: jsonValue('days').notNull(),
    reason: text('reason').notNull(),
    status: text('status', { enum: ['pending', 'approved', 'rejected'] })
      .notNull()
      .default('pending'),
    requestedBy: uuid('requested_by').notNull(),
    affectedContracts: integer('affected_contracts').notNull(),
    decidedBy: uuid('decided_by'),
    decidedAt: timestamptz('decided_at'),
    savedCount: integer('saved_count'),
    ...timestamps(),
  },
  (t) => [
    check('holiday_batches_status_check', sql`${t.status} IN ('pending', 'approved', 'rejected')`),
    check('holiday_batches_reason_check', sql`length(trim(${t.reason})) >= 3`),
    check('holiday_batches_year_check', sql`${t.year} BETWEEN 1400 AND 1500`),
    check(
      'holiday_batches_days_check',
      sql`jsonb_typeof(${t.days}) = 'array' AND jsonb_array_length(${t.days}) BETWEEN 1 AND 60`,
    ),
    check('holiday_batches_affected_check', sql`${t.affectedContracts} >= 0`),
    check(
      'holiday_batches_two_people_check',
      sql`${t.decidedBy} IS NULL OR ${t.decidedBy} <> ${t.requestedBy}`,
    ),
    check(
      'holiday_batches_decided_check',
      sql`(${t.status} = 'pending') = (${t.decidedBy} IS NULL AND ${t.decidedAt} IS NULL)
          AND (${t.status} = 'approved') = (${t.savedCount} IS NOT NULL)`,
    ),
    uniqueIndex('holiday_batches_open_key')
      .on(t.year)
      .where(sql`${t.status} = 'pending'`),
  ],
);

/**
 * A holiday taken off the calendar (owner 1405/07/29; ADR-043; migration 0099): one holder of
 * config.manage_holidays asks with a reason, a second approves (the holiday is soft deleted,
 * rule 7) or rejects. One open request per holiday. `affectedContracts` is the plan 3 (a) count
 * when asked (national holidays only).
 */
export const holidayRemovals = pgTable(
  'holiday_removals',
  {
    id: id(),
    holidayId: uuid('holiday_id')
      .notNull()
      .references(() => holidays.id, { onDelete: 'restrict' }),
    reason: text('reason').notNull(),
    status: text('status', { enum: ['pending', 'approved', 'rejected'] })
      .notNull()
      .default('pending'),
    requestedBy: uuid('requested_by').notNull(),
    affectedContracts: integer('affected_contracts').notNull(),
    decidedBy: uuid('decided_by'),
    decidedAt: timestamptz('decided_at'),
    ...timestamps(),
  },
  (t) => [
    check('holiday_removals_status_check', sql`${t.status} IN ('pending', 'approved', 'rejected')`),
    check('holiday_removals_reason_check', sql`length(trim(${t.reason})) >= 3`),
    check('holiday_removals_affected_check', sql`${t.affectedContracts} >= 0`),
    check(
      'holiday_removals_two_people_check',
      sql`${t.decidedBy} IS NULL OR ${t.decidedBy} <> ${t.requestedBy}`,
    ),
    check(
      'holiday_removals_decided_check',
      sql`(${t.status} = 'pending') = (${t.decidedBy} IS NULL AND ${t.decidedAt} IS NULL)`,
    ),
    uniqueIndex('holiday_removals_open_key')
      .on(t.holidayId)
      .where(sql`${t.status} = 'pending'`),
  ],
);

/**
 * Notices shown in the admin panel to users holding `audiencePermission` (task 2-1: the
 * Bahman holiday reminder). One open notice per code; raising it again only counts and
 * re-dates it. Resolved when its condition is gone. Not for urgent alerts: those go to
 * the on-call SMS.
 */
export const adminNotices = pgTable(
  'admin_notices',
  {
    id: id(),
    code: text('code').notNull(),
    audiencePermission: text('audience_permission').notNull(),
    message: text('message').notNull(),
    firstRaisedAt: timestamptz('first_raised_at').notNull().defaultNow(),
    lastRaisedAt: timestamptz('last_raised_at').notNull().defaultNow(),
    raiseCount: integer('raise_count').notNull().default(1),
    resolvedAt: timestamptz('resolved_at'),
    ...timestamps(),
  },
  (t) => [
    uniqueIndex('admin_notices_open_code_key')
      .on(t.code)
      .where(sql`${t.resolvedAt} IS NULL AND ${t.deletedAt} IS NULL`),
  ],
);

/**
 * The cities the system knows (ADR-010: a city is a main dimension; adding one is «one
 * record and one flag»). `code` is what centers, holidays and configuration scopes carry;
 * `name` is what pages show; `active` is the flag: the network works there and the search
 * offers it. Filled by migrations; the application only reads it. Never deleted.
 */
export const cities = pgTable(
  'cities',
  {
    id: id(),
    code: text('code').notNull(),
    name: text('name').notNull(),
    active: boolean('active').notNull().default(false),
    sortOrder: integer('sort_order').notNull().default(0),
    ...timestamps(),
  },
  (t) => [
    uniqueIndex('cities_code_key')
      .on(t.code)
      .where(sql`${t.deletedAt} IS NULL`),
  ],
);

import { COST_KINDS, PROFORMA_STATUSES } from '@sepehr/contracts';
import { sql } from 'drizzle-orm';
import {
  check,
  index,
  integer,
  pgTable,
  text,
  uniqueIndex,
  uuid,
  type AnyPgColumn,
} from 'drizzle-orm/pg-core';
import { appendOnlyTimestamps, id, rial, timestamps, timestamptz } from '../../db/columns';

/**
 * Proformas (task 3-4, doc 10 §2). The case, person, referral, doctor, workplace and
 * center belong to other modules, so they are ids here, not foreign keys (module
 * boundary). Only the state and the patient's answer of a proforma are ever written after
 * it is made; its lines never are (migration 0023 enforces both).
 */
export const proformas = pgTable(
  'proformas',
  {
    id: id(),
    caseId: uuid('case_id').notNull(),
    /** The patient: the person of the referral's day. */
    personId: uuid('person_id').notNull(),
    referralId: uuid('referral_id').notNull(),
    doctorId: uuid('doctor_id').notNull(),
    workplaceId: uuid('workplace_id').notNull(),
    centerId: uuid('center_id'),
    /** The workplace's city when the proforma was made: the network's scope (deviation queue). */
    cityCode: text('city_code').notNull(),
    version: integer('version').notNull(),
    supersedesId: uuid('supersedes_id').references((): AnyPgColumn => proformas.id),
    status: text('status', { enum: PROFORMA_STATUSES }).notNull().default('draft'),
    totalRial: rial('total_rial').notNull(),
    /** When the tariffs of its lines were read (the draft's making). */
    tariffSnapshotAt: timestamptz('tariff_snapshot_at').notNull(),
    issuedBy: uuid('issued_by'),
    issuedAt: timestamptz('issued_at'),
    /** `valid_until` of doc 10 §2: issued_at + proforma.validity_days. */
    expiresAt: timestamptz('expires_at'),
    /** The `proforma.validity_days` version its deadline came from (rule 16). */
    validityConfigVersionId: uuid('validity_config_version_id'),
    patientRespondedAt: timestamptz('patient_responded_at'),
    patientResponseNote: text('patient_response_note'),
    createdBy: uuid('created_by'),
    discardReason: text('discard_reason'),
    ...timestamps(),
  },
  (t) => [
    // One live successor per version; a discarded draft does not count.
    uniqueIndex('proformas_supersedes_key')
      .on(t.supersedesId)
      .where(sql`${t.deletedAt} IS NULL`),
    index('proformas_city_status_idx').on(t.cityCode, t.status),
    index('proformas_case_idx').on(t.caseId),
    index('proformas_workplace_status_idx').on(t.workplaceId, t.status),
    index('proformas_person_idx').on(t.personId),
    check('proformas_version_check', sql`${t.version} >= 1`),
    check('proformas_total_check', sql`${t.totalRial} >= 0`),
  ],
);

export const proformaLines = pgTable(
  'proforma_lines',
  {
    id: id(),
    proformaId: uuid('proforma_id')
      .notNull()
      .references(() => proformas.id),
    lineNo: integer('line_no').notNull(),
    serviceId: uuid('service_id').notNull(),
    serviceCode: text('service_code').notNull(),
    tariffVersionId: uuid('tariff_version_id').notNull(),
    tariffMinRial: rial('tariff_min_rial').notNull(),
    tariffMaxRial: rial('tariff_max_rial').notNull(),
    quantity: integer('quantity').notNull(),
    unitRial: rial('unit_rial').notNull(),
    deviationReason: text('deviation_reason'),
    lineTotalRial: rial('line_total_rial').notNull(),
    /** Treatment data (doc 04 §4). */
    toothOrSite: text('tooth_or_site'),
    note: text('note'),
    /**
     * ADR-050: the doctor's wage or materials, copied from the service when the draft is made
     * (or set by the issuer, with its reason); an issued proforma keeps it (migration 0023).
     */
    costKind: text('cost_kind', { enum: COST_KINDS }).notNull().default('wage'),
    costKindReason: text('cost_kind_reason'),
    ...appendOnlyTimestamps(),
  },
  (t) => [
    uniqueIndex('proforma_lines_line_key').on(t.proformaId, t.lineNo),
    check('proforma_lines_quantity_check', sql`${t.quantity} BETWEEN 1 AND 99`),
    check(
      'proforma_lines_amounts_check',
      sql`${t.unitRial} >= 0 AND ${t.tariffMinRial} >= 0 AND ${t.tariffMaxRial} >= ${t.tariffMinRial}
          AND ${t.lineTotalRial} = ${t.unitRial} * ${t.quantity}`,
    ),
    // A price outside the tariff's range carries its reason (doc 10 §2 rule 2).
    check('proforma_lines_cost_kind_check', sql`${t.costKind} IN ('wage', 'material')`),
    check(
      'proforma_lines_cost_kind_reason_check',
      sql`${t.costKindReason} IS NULL OR length(trim(${t.costKindReason})) >= 3`,
    ),
    check(
      'proforma_lines_deviation_check',
      sql`(${t.unitRial} BETWEEN ${t.tariffMinRial} AND ${t.tariffMaxRial}) OR ${t.deviationReason} IS NOT NULL`,
    ),
  ],
);

/** The network specialist's «seen» on a proforma with a price outside its tariff. */
export const proformaDeviationReviews = pgTable(
  'proforma_deviation_reviews',
  {
    id: id(),
    proformaId: uuid('proforma_id')
      .notNull()
      .references(() => proformas.id),
    reviewedBy: uuid('reviewed_by').notNull(),
    note: text('note').notNull(),
    ...appendOnlyTimestamps(),
  },
  (t) => [index('proforma_deviation_reviews_proforma_idx').on(t.proformaId)],
);

/**
 * A request for support, linked to what it is about (doc 10 §2: a disputed proforma).
 * The simple record until the full ticket of phase 7 takes these over (task 7-1); owned
 * by this module until then.
 */
export const supportRequests = pgTable(
  'support_requests',
  {
    id: id(),
    subjectType: text('subject_type', { enum: ['proforma'] }).notNull(),
    subjectId: uuid('subject_id').notNull(),
    personId: uuid('person_id').notNull(),
    accountId: uuid('account_id'),
    note: text('note').notNull(),
    status: text('status', { enum: ['open'] })
      .notNull()
      .default('open'),
    ...appendOnlyTimestamps(),
  },
  (t) => [index('support_requests_subject_idx').on(t.subjectType, t.subjectId)],
);

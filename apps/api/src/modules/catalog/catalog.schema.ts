import {
  BULK_IMPORT_SHEETS,
  CENTER_STATUSES,
  COST_KINDS,
  MEDIA_ASSET_STATUSES,
  MEDIA_REJECTIONS,
  PROFILE_VERSION_STATUSES,
} from '@sepehr/contracts';
import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { appendOnlyTimestamps, id, rial, timestamps, timestamptz } from '../../db/columns';

/**
 * Centers and branches (task 2-2, doc 08 §2–3, ADR-022). Each sits on a node of the
 * access module's org_nodes tree (no parallel tree); these tables hold what the catalog
 * knows about it. National IDs, legal-entity IDs and Sheba numbers are stored only
 * encrypted (FieldCrypto), with a keyed blind index for duplicate checks and the last
 * four digits for display (rule 27).
 */

export const centers = pgTable(
  'centers',
  {
    id: id(),
    /** The center's root node on org_nodes. */
    nodeId: uuid('node_id').notNull(),
    personType: text('person_type', { enum: ['natural', 'legal'] }).notNull(),
    name: text('name').notNull(),
    cityCode: text('city_code').notNull(),
    address: text('address'),
    /** Coordinates in millionths of a degree: integers, never floating point. */
    latitudeE6: integer('latitude_e6'),
    longitudeE6: integer('longitude_e6'),
    phone: text('phone'),
    licenseNumber: text('license_number'),
    /** National ID (natural person) or legal-entity ID, encrypted. */
    identifierEnc: text('identifier_enc').notNull(),
    identifierIndex: text('identifier_index').notNull(),
    identifierLast4: text('identifier_last4').notNull(),
    shebaEnc: text('sheba_enc'),
    shebaIndex: text('sheba_index'),
    shebaLast4: text('sheba_last4'),
    accountHolderName: text('account_holder_name'),
    status: text('status', { enum: CENTER_STATUSES }).notNull().default('draft'),
    /** The document checklist the last submission was checked against (rule 16). */
    checklistConfigVersionId: uuid('checklist_config_version_id'),
    /** Set once, at the first activation: identity and bank account then need two people. */
    firstActivatedAt: timestamptz('first_activated_at'),
    createdBy: uuid('created_by'),
    ...timestamps(),
  },
  (t) => [
    uniqueIndex('centers_node_id_key').on(t.nodeId),
    // A terminated center keeps blocking its IDs (task 2-2 decision): only a soft-deleted
    // draft frees them.
    uniqueIndex('centers_identifier_index_key')
      .on(t.identifierIndex)
      .where(sql`${t.deletedAt} IS NULL`),
    uniqueIndex('centers_sheba_index_key')
      .on(t.shebaIndex)
      .where(sql`${t.deletedAt} IS NULL AND ${t.shebaIndex} IS NOT NULL`),
    index('centers_city_code_idx').on(t.cityCode),
    index('centers_status_idx').on(t.status),
  ],
);

export const branches = pgTable(
  'branches',
  {
    id: id(),
    nodeId: uuid('node_id').notNull(),
    centerId: uuid('center_id').notNull(),
    name: text('name').notNull(),
    /** A single-branch center has exactly one default branch (doc 08 §2). */
    isDefault: boolean('is_default').notNull().default(false),
    address: text('address'),
    latitudeE6: integer('latitude_e6'),
    longitudeE6: integer('longitude_e6'),
    phone: text('phone'),
    // Access details shown to patients, entered by hand (doc 08 §3).
    parking: text('parking', { enum: ['available', 'limited', 'none'] }),
    nearestMetro: text('nearest_metro'),
    nearestBrt: text('nearest_brt'),
    routeNote: text('route_note'),
    ...timestamps(),
  },
  (t) => [
    uniqueIndex('branches_node_id_key').on(t.nodeId),
    uniqueIndex('branches_default_key')
      .on(t.centerId)
      .where(sql`${t.isDefault} AND ${t.deletedAt} IS NULL`),
    index('branches_center_id_idx').on(t.centerId),
  ],
);

/** The center's treatment fields, by code (foreign key to treatment_fields since 2-4). */
export const centerTreatmentFields = pgTable(
  'center_treatment_fields',
  {
    id: id(),
    centerId: uuid('center_id').notNull(),
    fieldCode: text('field_code').notNull(),
    ...timestamps(),
  },
  (t) => [
    uniqueIndex('center_treatment_fields_key')
      .on(t.centerId, t.fieldCode)
      .where(sql`${t.deletedAt} IS NULL`),
  ],
);

/**
 * One row per required document of the checklist (config `catalog.center_document_checklist`).
 * Only the status for now; the file itself comes with task 2-8, reusing these statuses.
 */
export const centerDocuments = pgTable(
  'center_documents',
  {
    id: id(),
    centerId: uuid('center_id').notNull(),
    code: text('code').notNull(),
    status: text('status', { enum: ['received', 'verified', 'incomplete'] }).notNull(),
    note: text('note'),
    updatedBy: uuid('updated_by'),
    ...timestamps(),
  },
  (t) => [
    uniqueIndex('center_documents_key')
      .on(t.centerId, t.code)
      .where(sql`${t.deletedAt} IS NULL`),
  ],
);

/** Every status change of a center, append-only. */
export const centerStatusChanges = pgTable(
  'center_status_changes',
  {
    id: id(),
    centerId: uuid('center_id').notNull(),
    fromStatus: text('from_status', { enum: CENTER_STATUSES }).notNull(),
    toStatus: text('to_status', { enum: CENTER_STATUSES }).notNull(),
    reason: text('reason').notNull(),
    changedBy: uuid('changed_by'),
    /** The approved two-person request behind it, if any. */
    requestId: uuid('request_id'),
    ...appendOnlyTimestamps(),
  },
  (t) => [index('center_status_changes_center_idx').on(t.centerId)],
);

/**
 * Two-person changes (doc 04 §5, doc 08 §3): activation, reactivation after suspension,
 * and a new bank account after the first activation. The proposer never decides.
 */
export const centerChangeRequests = pgTable(
  'center_change_requests',
  {
    id: id(),
    centerId: uuid('center_id').notNull(),
    kind: text('kind', { enum: ['activation', 'reactivation', 'bank_account'] }).notNull(),
    status: text('status', { enum: ['proposed', 'approved', 'rejected', 'withdrawn'] })
      .notNull()
      .default('proposed'),
    // For a bank-account change: the new values, encrypted like the center's.
    shebaEnc: text('sheba_enc'),
    shebaIndex: text('sheba_index'),
    shebaLast4: text('sheba_last4'),
    accountHolderName: text('account_holder_name'),
    reason: text('reason').notNull(),
    proposedBy: uuid('proposed_by').notNull(),
    decidedBy: uuid('decided_by'),
    decidedAt: timestamptz('decided_at'),
    decisionNote: text('decision_note'),
    ...timestamps(),
  },
  (t) => [
    uniqueIndex('center_change_requests_open_key')
      .on(t.centerId, t.kind)
      .where(sql`${t.status} = 'proposed'`),
    index('center_change_requests_status_idx').on(t.status),
  ],
);

/**
 * Doctors (task 2-3, doc 08 §2): one provider profile per doctor, with or without a user
 * account. The medical council number is public (it is shown on the profile), so it is
 * kept in the clear and unique; the national ID is encrypted like a center's (rule 27).
 */
export const doctors = pgTable(
  'doctors',
  {
    id: id(),
    name: text('name').notNull(),
    medicalCouncilNumber: text('medical_council_number').notNull(),
    nationalIdEnc: text('national_id_enc'),
    nationalIdIndex: text('national_id_index'),
    nationalIdLast4: text('national_id_last4'),
    /** The center-kind account the doctor logs in with, if any (identity module). */
    accountId: uuid('account_id'),
    createdBy: uuid('created_by'),
    ...timestamps(),
  },
  (t) => [
    uniqueIndex('doctors_medical_council_number_key')
      .on(t.medicalCouncilNumber)
      .where(sql`${t.deletedAt} IS NULL`),
    uniqueIndex('doctors_national_id_index_key')
      .on(t.nationalIdIndex)
      .where(sql`${t.deletedAt} IS NULL AND ${t.nationalIdIndex} IS NOT NULL`),
    uniqueIndex('doctors_account_id_key')
      .on(t.accountId)
      .where(sql`${t.deletedAt} IS NULL AND ${t.accountId} IS NOT NULL`),
  ],
);

export const doctorTreatmentFields = pgTable(
  'doctor_treatment_fields',
  {
    id: id(),
    doctorId: uuid('doctor_id').notNull(),
    fieldCode: text('field_code').notNull(),
    ...timestamps(),
  },
  (t) => [
    uniqueIndex('doctor_treatment_fields_key')
      .on(t.doctorId, t.fieldCode)
      .where(sql`${t.deletedAt} IS NULL`),
  ],
);

/**
 * Where a doctor works: one doctor node on org_nodes per workplace, under a branch of a
 * center, or a root for a private practice (doc 08 §2). The node's path is copied here so
 * the catalog checks scopes without reading org_nodes.
 */
export const doctorWorkplaces = pgTable(
  'doctor_workplaces',
  {
    id: id(),
    doctorId: uuid('doctor_id').notNull(),
    nodeId: uuid('node_id').notNull(),
    nodePath: text('node_path').notNull(),
    /** Both null for a private practice. */
    centerId: uuid('center_id'),
    branchId: uuid('branch_id'),
    cityCode: text('city_code').notNull(),
    /** Takes Sepehr credit; the public search filters on it (task 2-7 decision 2). */
    creditEnabled: boolean('credit_enabled').notNull().default(false),
    createdBy: uuid('created_by'),
    ...timestamps(),
  },
  (t) => [
    uniqueIndex('doctor_workplaces_node_id_key').on(t.nodeId),
    uniqueIndex('doctor_workplaces_branch_key')
      .on(t.doctorId, t.branchId)
      .where(sql`${t.deletedAt} IS NULL AND ${t.branchId} IS NOT NULL`),
    uniqueIndex('doctor_workplaces_private_key')
      .on(t.doctorId)
      .where(sql`${t.deletedAt} IS NULL AND ${t.branchId} IS NULL`),
    index('doctor_workplaces_doctor_id_idx').on(t.doctorId),
    index('doctor_workplaces_city_code_idx').on(t.cityCode),
  ],
);

/**
 * A secretary of one doctor at one workplace (task 2-3 decision: one secretary, one doctor;
 * serving several doctors later adds rows here, one per workplace, with no destructive
 * change). The secretary's node on org_nodes carries the account and the role.
 */
export const doctorSecretaries = pgTable(
  'doctor_secretaries',
  {
    id: id(),
    workplaceId: uuid('workplace_id').notNull(),
    nodeId: uuid('node_id').notNull(),
    accountId: uuid('account_id').notNull(),
    name: text('name').notNull(),
    createdBy: uuid('created_by'),
    ...timestamps(),
  },
  (t) => [
    uniqueIndex('doctor_secretaries_node_id_key').on(t.nodeId),
    index('doctor_secretaries_workplace_id_idx').on(t.workplaceId),
  ],
);

/**
 * The catalog (task 2-4, doc 08 §4, ADR-024): treatment fields and the services under
 * them, managed by the network manager and the system admin. A field's code is unique for
 * ever (config scopes and credit purses refer to it), so a retired field is soft-deleted
 * and its code never reused.
 */
export const treatmentFields = pgTable(
  'treatment_fields',
  {
    id: id(),
    code: text('code').notNull(),
    name: text('name').notNull(),
    sortOrder: integer('sort_order').notNull().default(0),
    createdBy: uuid('created_by'),
    ...timestamps(),
  },
  (t) => [
    uniqueIndex('treatment_fields_code_key').on(t.code),
    uniqueIndex('treatment_fields_name_key')
      .on(t.name)
      .where(sql`${t.deletedAt} IS NULL`),
  ],
);

/**
 * A service under a treatment field, or the one special `visit` service, which belongs to
 * no field (task 2-4 decision). Codes are unique for ever, like fields.
 */
export const services = pgTable(
  'services',
  {
    id: id(),
    /** Null only for the visit. */
    fieldId: uuid('field_id'),
    code: text('code').notNull(),
    name: text('name').notNull(),
    kind: text('kind', { enum: ['standard', 'visit'] })
      .notNull()
      .default('standard'),
    /** ADR-050: the doctor's wage or materials; copied onto each proforma line. */
    costKind: text('cost_kind', { enum: COST_KINDS }).notNull().default('wage'),
    createdBy: uuid('created_by'),
    ...timestamps(),
  },
  (t) => [
    uniqueIndex('services_code_key').on(t.code),
    uniqueIndex('services_name_key')
      .on(t.fieldId, t.name)
      .where(sql`${t.deletedAt} IS NULL`),
    uniqueIndex('services_visit_key')
      .on(t.kind)
      .where(sql`${t.kind} = 'visit'`),
    index('services_field_id_idx').on(t.fieldId),
    check('services_cost_kind_check', sql`${t.costKind} IN ('wage', 'material')`),
  ],
);

/**
 * A tariff series: the price of one service at one doctor workplace or at one center
 * (doc 08 §4). The series never changes; its prices are the versions below. The owner's
 * node path and city are copied here so scopes are checked without reading org_nodes.
 */
export const tariffs = pgTable(
  'tariffs',
  {
    id: id(),
    serviceId: uuid('service_id').notNull(),
    ownerKind: text('owner_kind', { enum: ['workplace', 'center'] }).notNull(),
    workplaceId: uuid('workplace_id'),
    centerId: uuid('center_id'),
    nodePath: text('node_path').notNull(),
    cityCode: text('city_code').notNull(),
    createdBy: uuid('created_by'),
    ...appendOnlyTimestamps(),
  },
  (t) => [
    uniqueIndex('tariffs_workplace_key')
      .on(t.workplaceId, t.serviceId)
      .where(sql`${t.ownerKind} = 'workplace'`),
    uniqueIndex('tariffs_center_key')
      .on(t.centerId, t.serviceId)
      .where(sql`${t.ownerKind} = 'center'`),
    index('tariffs_service_id_idx').on(t.serviceId),
  ],
);

/**
 * The prices of a tariff over time, append-only (doc 08 §4): the version in force at a
 * moment is the latest non-cancelled one whose `effective_at` has come. Only a version
 * that has not started yet may be cancelled; a started one is replaced by a new version.
 * A booking keeps the id of the version it was quoted (task 2-6), so a later change never
 * reaches it.
 */
export const tariffVersions = pgTable(
  'tariff_versions',
  {
    id: id(),
    tariffId: uuid('tariff_id').notNull(),
    /** `withdrawn`: the service is no longer offered here from `effective_at` on. */
    status: text('status', { enum: ['offered', 'withdrawn'] }).notNull(),
    /** Only for the visit service. */
    isFree: boolean('is_free').notNull().default(false),
    minAmountRial: rial('min_amount_rial'),
    maxAmountRial: rial('max_amount_rial'),
    effectiveAt: timestamptz('effective_at').notNull(),
    reason: text('reason').notNull(),
    createdBy: uuid('created_by'),
    cancelledAt: timestamptz('cancelled_at'),
    cancelledBy: uuid('cancelled_by'),
    cancelReason: text('cancel_reason'),
    ...appendOnlyTimestamps(),
  },
  (t) => [
    uniqueIndex('tariff_versions_effective_key')
      .on(t.tariffId, t.effectiveAt)
      .where(sql`${t.cancelledAt} IS NULL`),
  ],
);

/**
 * The public search's index (task 2-7, doc 08 §9, ADR-028): one row per doctor's workplace,
 * built only by the search indexer from the catalog's tables, the prices and booking's free
 * times (BOOKABLE_SLOTS), and refreshed from the outbox events that change any of them. A
 * read model: it decides nothing, so a stale row can never book a taken time (booking's
 * EXCLUDE constraint decides, ADR-027). Never deleted: a workplace that stops being found
 * is `listed = false` (rule 7).
 *
 * The `*_key` columns hold searchKey() of the text (rule 23: ی/ك, digits), which the search
 * applies to every term as well; pg_trgm indexes them (migration 0017).
 */
export const searchEntries = pgTable(
  'search_entries',
  {
    id: id(),
    workplaceId: uuid('workplace_id').notNull(),
    doctorId: uuid('doctor_id').notNull(),
    /** Null for a private practice. */
    centerId: uuid('center_id'),
    cityCode: text('city_code').notNull(),
    /** As shown: the doctor's and the center's names. */
    doctorName: text('doctor_name').notNull(),
    placeName: text('place_name'),
    /** Everything the free text matches: the names, the fields and the services offered. */
    searchKey: text('search_key').notNull(),
    doctorNameKey: text('doctor_name_key').notNull(),
    placeNameKey: text('place_name_key'),
    /** The doctor's active treatment fields, as { code, name } in code order. */
    treatmentFields: jsonb('treatment_fields').$type<{ code: string; name: string }[]>().notNull(),
    treatmentFieldCodes: text('treatment_field_codes').array().notNull(),
    /** Services with a price in force here (only those can be booked). */
    serviceCodes: text('service_codes').array().notNull(),
    creditEnabled: boolean('credit_enabled').notNull(),
    /** Found by the search: the workplace exists and takes new appointments. */
    listed: boolean('listed').notNull(),
    /** The earliest free slot when indexed: a hint for filtering and order, never a promise. */
    nextFreeSlotAt: timestamptz('next_free_slot_at'),
    /**
     * When the free time must be computed again: now when an event asked, else when time
     * alone changes it (the slot passes, a price starts, the entry grows old).
     */
    refreshDueAt: timestamptz('refresh_due_at').notNull(),
    /**
     * Events that asked for a refresh since the last one began. A refresh that started
     * before another request leaves the entry due, so no request is ever lost.
     */
    pendingChanges: integer('pending_changes').notNull().default(0),
    refreshedAt: timestamptz('refreshed_at').notNull(),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
    updatedAt: timestamptz('updated_at').notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('search_entries_workplace_id_key').on(t.workplaceId),
    index('search_entries_doctor_id_idx').on(t.doctorId),
    index('search_entries_center_id_idx').on(t.centerId),
    index('search_entries_refresh_due_at_idx').on(t.refreshDueAt),
    index('search_entries_listed_city_idx')
      .on(t.cityCode, t.nextFreeSlotAt)
      .where(sql`${t.listed} AND ${t.nextFreeSlotAt} IS NOT NULL`),
    index('search_entries_listed_next_free_idx')
      .on(t.nextFreeSlotAt)
      .where(sql`${t.listed} AND ${t.nextFreeSlotAt} IS NOT NULL`),
    index('search_entries_search_key_trgm').using('gin', sql`${t.searchKey} gin_trgm_ops`),
    index('search_entries_doctor_name_key_trgm').using('gin', sql`${t.doctorNameKey} gin_trgm_ops`),
    index('search_entries_place_name_key_trgm').using('gin', sql`${t.placeNameKey} gin_trgm_ops`),
    index('search_entries_treatment_field_codes_idx').using('gin', t.treatmentFieldCodes),
    index('search_entries_service_codes_idx').using('gin', t.serviceCodes),
  ],
);

/**
 * The price in force of each service offered at an indexed workplace, for the price filter.
 * A service no longer offered keeps its row with `offered = false` (never deleted).
 */
export const searchEntryPrices = pgTable(
  'search_entry_prices',
  {
    id: id(),
    entryId: uuid('entry_id')
      .notNull()
      .references(() => searchEntries.id),
    serviceCode: text('service_code').notNull(),
    isVisit: boolean('is_visit').notNull(),
    offered: boolean('offered').notNull(),
    isFree: boolean('is_free').notNull(),
    minAmountRial: rial('min_amount_rial').notNull(),
    maxAmountRial: rial('max_amount_rial').notNull(),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
    updatedAt: timestamptz('updated_at').notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('search_entry_prices_entry_service_key').on(t.entryId, t.serviceCode),
    index('search_entry_prices_service_idx')
      .on(t.serviceCode, t.minAmountRial, t.maxAmountRial)
      .where(sql`${t.offered}`),
  ],
);

/** Each run of `pnpm catalog:rebuild-search`, dry or not (task 2-7 decision 1). Append-only. */
export const searchRebuildRuns = pgTable('search_rebuild_runs', {
  id: id(),
  mode: text('mode', { enum: ['dry_run', 'apply'] }).notNull(),
  workplaces: integer('workplaces').notNull(),
  inserted: integer('inserted').notNull(),
  updated: integer('updated').notNull(),
  unchanged: integer('unchanged').notNull(),
  listed: integer('listed').notNull(),
  unlisted: integer('unlisted').notNull(),
  startedAt: timestamptz('started_at').notNull(),
  finishedAt: timestamptz('finished_at').notNull(),
  ...appendOnlyTimestamps(),
});

/**
 * A doctor's public profile (task 2-8, doc 08 §10, ADR-029): one per doctor, its current
 * Latin address, and the version the public sees. Content lives in versions.
 */
export const doctorProfiles = pgTable(
  'doctor_profiles',
  {
    id: id(),
    doctorId: uuid('doctor_id').notNull(),
    slug: text('slug').notNull(),
    /** Null until a version is first approved; the public sees nothing before that. */
    publishedVersionId: uuid('published_version_id'),
    firstPublishedAt: timestamptz('first_published_at'),
    createdBy: uuid('created_by'),
    ...timestamps(),
  },
  (t) => [
    uniqueIndex('doctor_profiles_doctor_id_key').on(t.doctorId),
    uniqueIndex('doctor_profiles_slug_key').on(t.slug),
  ],
);

/**
 * One version of a profile: `draft → in_review → published | rejected` (rule 8, guarded by
 * a trigger). Only a draft's content changes; at most one draft or in-review version per
 * profile at a time. A published version keeps showing until a newer one is approved.
 */
export const doctorProfileVersions = pgTable(
  'doctor_profile_versions',
  {
    id: id(),
    profileId: uuid('profile_id')
      .notNull()
      .references(() => doctorProfiles.id),
    versionNo: integer('version_no').notNull(),
    status: text('status', { enum: PROFILE_VERSION_STATUSES }).notNull(),
    content: jsonb('content').$type<Record<string, unknown>>().notNull(),
    createdBy: uuid('created_by'),
    submittedBy: uuid('submitted_by'),
    submittedAt: timestamptz('submitted_at'),
    decidedBy: uuid('decided_by'),
    decidedAt: timestamptz('decided_at'),
    decisionReason: text('decision_reason'),
    ...timestamps(),
  },
  (t) => [
    uniqueIndex('doctor_profile_versions_number_key').on(t.profileId, t.versionNo),
    uniqueIndex('doctor_profile_versions_open_key')
      .on(t.profileId)
      .where(sql`${t.status} IN ('draft', 'in_review')`),
    index('doctor_profile_versions_in_review_idx')
      .on(t.submittedAt)
      .where(sql`${t.status} = 'in_review'`),
  ],
);

/**
 * Every address a profile ever had (append-only). A slug once used is never given to
 * another profile, so an old link always redirects (301) to the right doctor.
 */
export const doctorProfileSlugs = pgTable(
  'doctor_profile_slugs',
  {
    id: id(),
    profileId: uuid('profile_id')
      .notNull()
      .references(() => doctorProfiles.id),
    slug: text('slug').notNull(),
    createdBy: uuid('created_by'),
    ...appendOnlyTimestamps(),
  },
  (t) => [uniqueIndex('doctor_profile_slugs_slug_key').on(t.slug)],
);

/**
 * A file uploaded for a profile (task 2-8): kept first in the private space; the worker
 * checks its real type, scans it and makes its variants (`pending → ready | rejected`).
 * Published copies live in the public space while a published version shows them.
 */
export const mediaAssets = pgTable(
  'media_assets',
  {
    id: id(),
    doctorId: uuid('doctor_id').notNull(),
    kind: text('kind', { enum: ['image', 'video'] }).notNull(),
    status: text('status', { enum: MEDIA_ASSET_STATUSES }).notNull(),
    rejection: text('rejection', { enum: MEDIA_REJECTIONS }),
    /** The type found in the bytes, never the name's or the browser's. */
    detectedMime: text('detected_mime').notNull(),
    sizeBytes: integer('size_bytes').notNull(),
    originalKey: text('original_key').notNull(),
    /** What the worker made: [{ key, mime, width? }], in the private space. */
    variants: jsonb('variants').$type<{ key: string; mime: string; width?: number }[]>(),
    /** Set while a published version shows it: its variants are in the public space. */
    publishedAt: timestamptz('published_at'),
    createdBy: uuid('created_by'),
    ...timestamps(),
  },
  (t) => [index('media_assets_doctor_id_idx').on(t.doctorId)],
);

/**
 * A bulk import of centers and doctors (task 2-9, doc 08 §12, ADR-030): `previewed →
 * committed → processed`, or `cancelled` (a preview dropped, or a batch undone while nothing
 * of it was touched). The file itself is never kept; its checked rows are.
 */
export const catalogImportBatches = pgTable('catalog_import_batches', {
  id: id(),
  status: text('status', {
    enum: ['previewed', 'committed', 'processed', 'cancelled'],
  }).notNull(),
  /** The uploader: the worker creates and applies as them, with their access then. */
  createdBy: uuid('created_by').notNull(),
  /** Per sheet: rows valid, duplicate and with errors (the preview). */
  summary: jsonb('summary').$type<Record<string, Record<string, number>>>().notNull(),
  committedAt: timestamptz('committed_at'),
  processedAt: timestamptz('processed_at'),
  cancelledAt: timestamptz('cancelled_at'),
  cancelReason: text('cancel_reason'),
  ...timestamps(),
});

/**
 * One checked row of a batch. Identifiers, Sheba numbers and national IDs are kept only
 * encrypted, with their last four digits (rule 27). A center's or branch's row becomes
 * `created`; a doctor's, tariff's or schedule's is `held` until its center is active (task
 * 2-9 decision 1), then `applied` or `failed` with a reason.
 */
export const catalogImportRows = pgTable(
  'catalog_import_rows',
  {
    id: id(),
    batchId: uuid('batch_id')
      .notNull()
      .references(() => catalogImportBatches.id),
    sheet: text('sheet', { enum: BULK_IMPORT_SHEETS }).notNull(),
    rowNumber: integer('row_number').notNull(),
    ref: text('ref'),
    /** The row code of the center it belongs to (to apply held rows once it is active). */
    centerRef: text('center_ref'),
    status: text('status', {
      enum: [
        'valid',
        'duplicate',
        'error',
        'created',
        'held',
        'proposed',
        'applied',
        'failed',
        'cancelled',
      ],
    }).notNull(),
    problems: jsonb('problems').$type<{ column: string | null; code: string }[]>().notNull(),
    data: jsonb('data').$type<Record<string, unknown>>(),
    /** What the row became: a center, branch, doctor or workplace id. */
    entityId: uuid('entity_id'),
    /** Why applying failed (a code), for the report. */
    failure: text('failure'),
    ...timestamps(),
  },
  (t) => [
    uniqueIndex('catalog_import_rows_batch_row_key').on(t.batchId, t.sheet, t.rowNumber),
    index('catalog_import_rows_held_idx')
      .on(t.batchId, t.centerRef)
      .where(sql`${t.status} = 'held'`),
  ],
);

/**
 * A doctor's visit price proposed from the internal panel and decided by a second person
 * (owner 1405/07/29, answer i; migration 0100). Approving writes the visit's tariff version
 * (`tariff_version_id`); what was proposed never changes, and a decided proposal is final (a
 * trigger guards it). One open proposal per workplace. No ledger row.
 */
export const visitTariffProposals = pgTable(
  'visit_tariff_proposals',
  {
    id: id(),
    workplaceId: uuid('workplace_id')
      .notNull()
      .references(() => doctorWorkplaces.id, { onDelete: 'restrict' }),
    isFree: boolean('is_free').notNull(),
    minAmountRial: rial('min_amount_rial').notNull(),
    maxAmountRial: rial('max_amount_rial').notNull(),
    effectiveAt: timestamptz('effective_at'),
    reason: text('reason').notNull(),
    status: text('status', { enum: ['pending', 'approved', 'rejected'] })
      .notNull()
      .default('pending'),
    requestedBy: uuid('requested_by').notNull(),
    decidedBy: uuid('decided_by'),
    decidedAt: timestamptz('decided_at'),
    decisionReason: text('decision_reason'),
    tariffVersionId: uuid('tariff_version_id').references(() => tariffVersions.id, {
      onDelete: 'restrict',
    }),
    ...timestamps(),
  },
  (t) => [
    check(
      'visit_tariff_proposals_status_check',
      sql`${t.status} IN ('pending', 'approved', 'rejected')`,
    ),
    check('visit_tariff_proposals_reason_check', sql`length(trim(${t.reason})) >= 3`),
    check(
      'visit_tariff_proposals_pricing_check',
      sql`(${t.isFree} AND ${t.minAmountRial} = 0 AND ${t.maxAmountRial} = 0)
          OR (NOT ${t.isFree} AND ${t.minAmountRial} > 0 AND ${t.maxAmountRial} >= ${t.minAmountRial})`,
    ),
    check(
      'visit_tariff_proposals_two_people_check',
      sql`${t.decidedBy} IS NULL OR ${t.decidedBy} <> ${t.requestedBy}`,
    ),
    check(
      'visit_tariff_proposals_decided_check',
      sql`(${t.status} = 'pending') = (${t.decidedBy} IS NULL AND ${t.decidedAt} IS NULL)`,
    ),
    check(
      'visit_tariff_proposals_version_check',
      sql`(${t.status} = 'approved') = (${t.tariffVersionId} IS NOT NULL)`,
    ),
    uniqueIndex('visit_tariff_proposals_open_key')
      .on(t.workplaceId)
      .where(sql`${t.status} = 'pending'`),
  ],
);

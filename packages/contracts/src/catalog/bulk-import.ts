import * as z from 'zod';
import { WEEKDAYS } from '../jalali/working-days.js';
import { normalizeDigits } from '../text/digits.js';
import { normalizePersianText } from '../text/persian.js';
import { scheduleRangeSchema } from '../booking/schedule.js';
import { createCenterSchema } from './centers.js';
import { medicalCouncilNumberSchema, nationalIdSchema } from './doctors.js';
import { rialAmountSchema } from './tariffs.js';

/**
 * The bulk import of centers and doctors from Excel (task 2-9, doc 08 §12, doc 05 §8): one
 * workbook, one sheet per kind, rows tied together by a «row code» of the same file. Every
 * row is checked with the same schema as a registration from the panel.
 */

export const BULK_IMPORT_LIMITS = {
  maxFileBytes: 5 * 1024 * 1024,
  maxInflatedBytes: 50 * 1024 * 1024,
  maxZipEntries: 60,
  maxRows: 5000,
} as const;

export const BULK_IMPORT_SHEETS = [
  'centers',
  'branches',
  'doctors',
  'tariffs',
  'schedules',
] as const;
export type BulkImportSheet = (typeof BULK_IMPORT_SHEETS)[number];

interface ColumnSpec {
  readonly code: string;
  readonly title: string;
  readonly required: boolean;
}

const col = (code: string, title: string, required = false): ColumnSpec => ({
  code,
  title,
  required,
});

/** Sheet titles and columns, as in the template; a header matches by title or by code. */
export const BULK_IMPORT_SPEC: Readonly<
  Record<BulkImportSheet, { readonly title: string; readonly columns: readonly ColumnSpec[] }>
> = {
  centers: {
    title: 'مراکز',
    columns: [
      col('ref', 'کد ردیف', true),
      col('person_type', 'نوع شخص', true),
      col('identifier', 'کد ملی یا شناسه ملی', true),
      col('name', 'نام مرکز', true),
      col('city_code', 'کد شهر', true),
      col('address', 'نشانی'),
      col('phone', 'تلفن'),
      col('license_number', 'شماره پروانه'),
      col('sheba', 'شبا'),
      col('account_holder_name', 'نام صاحب حساب'),
      col('treatment_field_codes', 'کدهای فیلد درمان'),
    ],
  },
  branches: {
    title: 'شعبه‌ها',
    columns: [
      col('ref', 'کد ردیف', true),
      col('center_ref', 'کد مرکز', true),
      col('name', 'نام شعبه', true),
      col('address', 'نشانی'),
      col('phone', 'تلفن'),
    ],
  },
  doctors: {
    title: 'پزشکان',
    columns: [
      col('ref', 'کد ردیف', true),
      col('center_ref', 'کد مرکز', true),
      col('branch_ref', 'کد شعبه'),
      col('name', 'نام پزشک', true),
      col('medical_council_number', 'شماره نظام پزشکی', true),
      col('national_id', 'کد ملی'),
      col('treatment_field_codes', 'کدهای فیلد درمان'),
    ],
  },
  tariffs: {
    title: 'خدمات و تعرفه‌ها',
    columns: [
      col('owner_ref', 'کد مرکز یا پزشک', true),
      col('service_code', 'کد خدمت', true),
      col('is_free', 'رایگان'),
      col('min_rial', 'حداقل (ریال)'),
      col('max_rial', 'حداکثر (ریال)'),
    ],
  },
  schedules: {
    title: 'الگوی تقویم',
    columns: [
      col('doctor_ref', 'کد پزشک', true),
      col('weekday', 'روز هفته', true),
      col('start', 'از ساعت', true),
      col('end', 'تا ساعت', true),
      col('slot_minutes', 'مدت هر نوبت (دقیقه)', true),
      col('service_codes', 'کدهای خدمت', true),
    ],
  },
};

const PERSIAN_WEEKDAYS: Readonly<Record<string, (typeof WEEKDAYS)[number]>> = {
  شنبه: 'saturday',
  یکشنبه: 'sunday',
  یک‌شنبه: 'sunday',
  دوشنبه: 'monday',
  سه‌شنبه: 'tuesday',
  سهشنبه: 'tuesday',
  چهارشنبه: 'wednesday',
  پنجشنبه: 'thursday',
  پنج‌شنبه: 'thursday',
  جمعه: 'friday',
};

const YES = new Set(['1', 'true', 'yes', 'بله', 'بلی', 'آری', 'رایگان']);
const NO = new Set(['', '0', 'false', 'no', 'خیر', 'نه']);

/** A comma list (Latin or Persian comma), trimmed, empty items dropped. */
const list = (cell: string) =>
  cell
    .split(/[,،]/)
    .map((v) => v.trim())
    .filter((v) => v !== '');

const refSchema = z
  .string()
  .transform((v) => normalizeDigits(v).trim().toUpperCase())
  .pipe(z.string().regex(/^[A-Z0-9][A-Z0-9_-]{0,39}$/));

/** One problem of one row, for the preview and the downloadable report. */
export interface RowProblem {
  /** The column's code, or null for the row as a whole. */
  readonly column: string | null;
  readonly code: string;
}

export interface ParsedRow<T> {
  readonly sheet: BulkImportSheet;
  /** The row's number in its sheet as Excel shows it (the header is row 1). */
  readonly rowNumber: number;
  readonly ref: string | null;
  readonly value: T | null;
  readonly problems: RowProblem[];
}

/** An inner schema's issue, kept by its code (the preview names codes, not English text). */
const reraise = (issue: z.core.$ZodIssue) => ({
  code: 'custom' as const,
  path: issue.path,
  message: issue.code === 'custom' ? issue.message : issue.code,
});

const problemsOf = (error: z.ZodError, columnOf: (path: string) => string | null) =>
  error.issues.map((issue) => ({
    column: columnOf(String(issue.path[0] ?? '')),
    code: issue.code === 'custom' ? issue.message.replace(/\s+/g, '_') : issue.code,
  }));

export const bulkCenterRowSchema = z
  .object({
    ref: refSchema,
    person_type: z.string().transform((v) => {
      const t = normalizePersianText(v).toLowerCase();
      return t === 'حقیقی' ? 'natural' : t === 'حقوقی' ? 'legal' : t;
    }),
    identifier: z.string(),
    name: z.string(),
    city_code: z.string().transform((v) => v.trim().toLowerCase()),
    address: z.string(),
    phone: z.string(),
    license_number: z.string(),
    sheba: z.string(),
    account_holder_name: z.string(),
    treatment_field_codes: z.string().transform(list),
  })
  .transform((r, ctx) => {
    const center = createCenterSchema.safeParse({
      personType: r.person_type,
      identifier: r.identifier,
      name: r.name,
      cityCode: r.city_code,
      ...(r.address ? { address: r.address } : {}),
      ...(r.phone ? { phone: r.phone } : {}),
      ...(r.license_number ? { licenseNumber: r.license_number } : {}),
      ...(r.sheba ? { sheba: r.sheba } : {}),
      ...(r.account_holder_name ? { accountHolderName: r.account_holder_name } : {}),
      ...(r.treatment_field_codes.length ? { treatmentFieldCodes: r.treatment_field_codes } : {}),
    });
    if (!center.success) {
      for (const issue of center.error.issues) ctx.addIssue(reraise(issue));
      return z.NEVER;
    }
    return { ref: r.ref, center: center.data };
  });

export const bulkBranchRowSchema = z.object({
  ref: refSchema,
  center_ref: refSchema,
  name: z.string().transform(normalizePersianText).pipe(z.string().min(2).max(200)),
  address: z.string().transform(normalizePersianText).pipe(z.string().max(500)),
  phone: z
    .string()
    .transform((v) => normalizeDigits(v).replace(/[\s\-()]/g, ''))
    .pipe(z.union([z.literal(''), z.string().regex(/^0\d{9,10}$/)])),
});

export const bulkDoctorRowSchema = z.object({
  ref: refSchema,
  center_ref: refSchema,
  branch_ref: z.union([z.literal(''), refSchema]),
  name: z.string().transform(normalizePersianText).pipe(z.string().min(2).max(200)),
  medical_council_number: medicalCouncilNumberSchema,
  national_id: z.union([z.literal(''), nationalIdSchema]),
  treatment_field_codes: z
    .string()
    .transform(list)
    .pipe(z.array(z.string().regex(/^[a-z][a-z0-9_]{1,62}$/)).max(20)),
});

export const bulkTariffRowSchema = z
  .object({
    owner_ref: refSchema,
    service_code: z.string().regex(/^[a-z][a-z0-9_]{1,62}$/),
    is_free: z.string().transform((v, ctx) => {
      const t = normalizePersianText(v).toLowerCase();
      if (YES.has(t)) return true;
      if (NO.has(t)) return false;
      ctx.addIssue({ code: 'custom', message: 'yes_or_no' });
      return z.NEVER;
    }),
    min_rial: z.union([z.literal(''), rialAmountSchema]),
    max_rial: z.union([z.literal(''), rialAmountSchema]),
  })
  .transform((r, ctx) => {
    if (r.is_free)
      return {
        ownerRef: r.owner_ref,
        serviceCode: r.service_code,
        pricing: { kind: 'free' as const },
      };
    if (r.min_rial === '' || r.max_rial === '' || r.min_rial <= 0n || r.max_rial < r.min_rial) {
      ctx.addIssue({ code: 'custom', path: ['min_rial'], message: 'price_range' });
      return z.NEVER;
    }
    return {
      ownerRef: r.owner_ref,
      serviceCode: r.service_code,
      pricing: { kind: 'range' as const, minRial: r.min_rial, maxRial: r.max_rial },
    };
  });

export const bulkScheduleRowSchema = z
  .object({
    doctor_ref: refSchema,
    weekday: z.string().transform((v) => {
      const t = normalizePersianText(v).replace(/\s+/g, '');
      return PERSIAN_WEEKDAYS[t] ?? v.trim().toLowerCase();
    }),
    start: z.string(),
    end: z.string(),
    slot_minutes: z.string().transform(normalizeDigits),
    service_codes: z.string().transform(list),
  })
  .transform((r, ctx) => {
    const range = scheduleRangeSchema.safeParse({
      weekday: r.weekday,
      start: r.start,
      end: r.end,
      slotMinutes: Number(r.slot_minutes),
      serviceCodes: r.service_codes,
    });
    if (!range.success) {
      for (const issue of range.error.issues) ctx.addIssue(reraise(issue));
      return z.NEVER;
    }
    return { doctorRef: r.doctor_ref, range: range.data };
  });

const SCHEMAS = {
  centers: bulkCenterRowSchema,
  branches: bulkBranchRowSchema,
  doctors: bulkDoctorRowSchema,
  tariffs: bulkTariffRowSchema,
  schedules: bulkScheduleRowSchema,
} as const;

export type BulkRowValue<S extends BulkImportSheet> = z.output<(typeof SCHEMAS)[S]>;

export interface ParsedWorkbook {
  readonly centers: ParsedRow<BulkRowValue<'centers'>>[];
  readonly branches: ParsedRow<BulkRowValue<'branches'>>[];
  readonly doctors: ParsedRow<BulkRowValue<'doctors'>>[];
  readonly tariffs: ParsedRow<BulkRowValue<'tariffs'>>[];
  readonly schedules: ParsedRow<BulkRowValue<'schedules'>>[];
  /** Workbook-level problems: a sheet or a required column missing. */
  readonly problems: {
    readonly sheet: BulkImportSheet | null;
    readonly code: string;
    readonly column?: string;
  }[];
}

const headerKey = (value: string) => normalizePersianText(value).toLowerCase().replace(/\s+/g, ' ');

/**
 * Reads the sheets of a workbook (as rows of cell texts) into checked rows, and checks what
 * the file can check on its own: every reference points to a row of the file, and no row
 * code, identifier, Sheba or council number appears twice. The database's duplicates are
 * the API's to find.
 */
export function parseBulkWorkbook(
  sheets: readonly { readonly name: string; readonly rows: readonly (readonly string[])[] }[],
): ParsedWorkbook {
  const problems: { sheet: BulkImportSheet | null; code: string; column?: string }[] = [];
  const parsed = {} as { [S in BulkImportSheet]: ParsedRow<BulkRowValue<S>>[] };
  for (const sheet of BULK_IMPORT_SHEETS) {
    const spec = BULK_IMPORT_SPEC[sheet];
    const found = sheets.find(
      (s) => headerKey(s.name) === headerKey(spec.title) || headerKey(s.name) === sheet,
    );
    (parsed as Record<string, unknown[]>)[sheet] = [];
    if (!found) {
      // Only the centers sheet is required; the others may be left out.
      if (sheet === 'centers') problems.push({ sheet, code: 'sheet_missing' });
      continue;
    }
    const [header = [], ...data] = found.rows;
    const index = new Map<string, number>();
    header.forEach((cell, i) => {
      const key = headerKey(cell);
      const column = spec.columns.find((c) => c.code === key || headerKey(c.title) === key);
      if (column && !index.has(column.code)) index.set(column.code, i);
    });
    const missing = spec.columns.filter((c) => c.required && !index.has(c.code));
    if (missing.length > 0) {
      for (const c of missing) problems.push({ sheet, code: 'column_missing', column: c.code });
      continue;
    }
    data.forEach((cells, i) => {
      const raw: Record<string, string> = {};
      for (const c of spec.columns) raw[c.code] = (cells[index.get(c.code) ?? -1] ?? '').trim();
      const result = SCHEMAS[sheet].safeParse(raw);
      // Inner schemas name fields in camelCase (cityCode); the sheet in snake_case (city_code).
      const columnOf = (path: string) => {
        const code = path.replace(/[A-Z]/g, (m) => `_${m.toLowerCase()}`);
        return spec.columns.some((c) => c.code === code) ? code : null;
      };
      (parsed[sheet] as ParsedRow<unknown>[]).push({
        sheet,
        rowNumber: i + 2,
        ref: raw['ref'] ? normalizeDigits(raw['ref']).trim().toUpperCase() : null,
        value: result.success ? result.data : null,
        problems: result.success ? [] : problemsOf(result.error, columnOf),
      });
    });
  }
  crossCheck(parsed);
  return { ...parsed, problems };
}

function crossCheck(p: { [S in BulkImportSheet]: ParsedRow<BulkRowValue<S>>[] }) {
  const flag = (row: ParsedRow<unknown>, column: string | null, code: string) => {
    row.problems.push({ column, code });
  };
  const once = <T>(
    rows: ParsedRow<T>[],
    keyOf: (row: ParsedRow<T>) => string | null,
    column: string,
  ) => {
    const seen = new Set<string>();
    for (const row of rows) {
      const key = keyOf(row);
      if (key === null) continue;
      if (seen.has(key)) flag(row, column, 'duplicate_in_file');
      seen.add(key);
    }
  };
  // Row codes are unique across the whole file: a tariff's owner may be a center or a doctor.
  once([...p.centers, ...p.branches, ...p.doctors] as ParsedRow<unknown>[], (r) => r.ref, 'ref');
  once(p.centers, (r) => r.value?.center.identifier ?? null, 'identifier');
  once(p.centers, (r) => r.value?.center.sheba ?? null, 'sheba');
  once(p.doctors, (r) => r.value?.medical_council_number ?? null, 'medical_council_number');
  once(p.doctors, (r) => r.value?.national_id || null, 'national_id');

  const centers = new Set(p.centers.filter((r) => r.value).map((r) => r.ref));
  const branches = new Map(
    p.branches.filter((r) => r.value).map((r) => [r.ref, r.value?.center_ref]),
  );
  const doctors = new Set(p.doctors.filter((r) => r.value).map((r) => r.ref));
  for (const row of p.branches) {
    if (row.value && !centers.has(row.value.center_ref)) flag(row, 'center_ref', 'unknown_center');
  }
  for (const row of p.doctors) {
    if (!row.value) continue;
    if (!centers.has(row.value.center_ref)) flag(row, 'center_ref', 'unknown_center');
    const branch = row.value.branch_ref;
    if (branch !== '' && branches.get(branch) !== row.value.center_ref) {
      flag(row, 'branch_ref', 'unknown_branch');
    }
  }
  for (const row of p.tariffs) {
    const owner = row.value?.ownerRef;
    if (owner !== undefined && !centers.has(owner) && !doctors.has(owner)) {
      flag(row, 'owner_ref', 'unknown_owner');
    }
  }
  for (const row of p.schedules) {
    if (row.value && !doctors.has(row.value.doctorRef)) flag(row, 'doctor_ref', 'unknown_doctor');
  }
}

/** The template: every sheet with its header row. */
export function bulkImportTemplate(): { name: string; rows: string[][] }[] {
  return BULK_IMPORT_SHEETS.map((sheet) => ({
    name: BULK_IMPORT_SPEC[sheet].title,
    rows: [BULK_IMPORT_SPEC[sheet].columns.map((c) => c.title)],
  }));
}

/** Committing, cancelling or applying proposed prices: always with a reason. */
export const bulkImportDecisionSchema = z.object({
  reason: z.string().transform(normalizePersianText).pipe(z.string().min(3).max(500)),
});

// --- answers and the list (task 2-11: the internal panel's import page) -----------------

export const BULK_IMPORT_BATCH_STATUSES = [
  'previewed',
  'committed',
  'processed',
  'cancelled',
] as const;
export const BULK_IMPORT_ROW_STATUSES = [
  'valid',
  'duplicate',
  'error',
  'created',
  'held',
  'proposed',
  'applied',
  'failed',
  'cancelled',
] as const;

/** A batch's preview: per sheet, how many rows of each status; the rows not imported. */
export const bulkPreviewSchema = z.object({
  batchId: z.uuid(),
  status: z.enum(BULK_IMPORT_BATCH_STATUSES),
  summary: z.record(z.string(), z.record(z.string(), z.int())),
  rejected: z.array(
    z.object({
      sheet: z.enum(BULK_IMPORT_SHEETS),
      rowNumber: z.int(),
      ref: z.string().nullable(),
      status: z.enum(BULK_IMPORT_ROW_STATUSES),
      problems: z.array(z.object({ column: z.string().nullable(), code: z.string() })),
    }),
  ),
});
export type BulkPreviewBody = z.infer<typeof bulkPreviewSchema>;

const pageNumber = (max: number) =>
  z
    .string()
    .transform(normalizeDigits)
    .pipe(z.string().regex(/^[1-9][0-9]{0,3}$/))
    .transform(Number)
    .pipe(z.number().int().min(1).max(max));

/** `GET /catalog/imports`: the caller's own batches (a batch is its uploader's), newest first. */
export const bulkImportListQuerySchema = z.object({
  status: z.enum(BULK_IMPORT_BATCH_STATUSES).optional(),
  page: pageNumber(1000).optional(),
  pageSize: pageNumber(50).optional(),
});

export const bulkImportListSchema = z.object({
  /** Whether the import is on (`catalog.bulk_import_enabled`); off, nothing new is taken. */
  enabled: z.boolean(),
  page: z.int().positive(),
  pageSize: z.int().positive(),
  total: z.int().nonnegative(),
  items: z.array(
    z.object({
      batchId: z.uuid(),
      status: z.enum(BULK_IMPORT_BATCH_STATUSES),
      summary: z.record(z.string(), z.record(z.string(), z.int())),
      createdAt: z.iso.datetime({ offset: true }),
      committedAt: z.iso.datetime({ offset: true }).nullable(),
      processedAt: z.iso.datetime({ offset: true }).nullable(),
      cancelledAt: z.iso.datetime({ offset: true }).nullable(),
    }),
  ),
});

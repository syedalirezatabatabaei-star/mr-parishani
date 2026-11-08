import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  HttpException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  BULK_IMPORT_LIMITS,
  BULK_IMPORT_SHEETS,
  BULK_IMPORT_SPEC,
  bulkImportTemplate,
  csvField,
  parseBulkWorkbook,
  type BulkImportSheet,
  type ParsedRow,
  type ParsedWorkbook,
  type PermissionCode,
  type bulkImportListQuerySchema,
} from '@sepehr/contracts';
import { and, asc, count, desc, eq, inArray, isNull, or, sql } from 'drizzle-orm';
import type { z } from 'zod';
import type { EffectiveAccess } from '../../common/auth/access.port';
import { ORG_TREE, type OrgTreePort } from '../../common/auth/org-tree.port';
import { AUDIT_LOG, type Actor, type AuditLog } from '../../common/audit/audit.port';
import { CONFIG, type ConfigPort } from '../../common/config/config.port';
import { MALWARE_SCANNER, type MalwareScanner } from '../../common/security/malware-scanner.port';
import { readSheets, writeWorkbook, XlsxError } from '../../common/xlsx';
import { DATABASE, type Database } from '../../db/database.module';
import { lastFour } from '../../security/blind-index';
import { CATALOG_CRYPTO, type CatalogCrypto } from './catalog.crypto';
import {
  catalogImportBatches,
  branches,
  catalogImportRows,
  centers,
  doctors,
  services,
  treatmentFields,
} from './catalog.schema';
import { TariffService } from './tariff.service';

type Tx = Parameters<Parameters<Database['transaction']>[0]>[0];
type BatchRow = typeof catalogImportBatches.$inferSelect;
type ImportRow = typeof catalogImportRows.$inferSelect;
type RowStatus = ImportRow['status'];

const IMPORT: PermissionCode = 'catalog.import_centers';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface UploadedWorkbook {
  readonly originalname: string;
  readonly size: number;
  readonly buffer: Buffer;
}

/** What one row of the preview says. */
export interface PreviewRow {
  readonly sheet: BulkImportSheet;
  readonly rowNumber: number;
  readonly ref: string | null;
  readonly status: RowStatus;
  readonly problems: readonly { column: string | null; code: string }[];
}

export interface BulkPreview {
  readonly batchId: string;
  readonly status: BatchRow['status'];
  /** Per sheet: how many rows are new (valid), duplicates, or have errors. */
  readonly summary: Record<string, Record<string, number>>;
  /** The rows that will not be imported, with why. */
  readonly rejected: readonly PreviewRow[];
}

/** Encryption context of an identifier kept in a batch row: bound to that row. */
export const importContext = (batchId: string, sheet: string, rowNumber: number, field: string) =>
  `catalog_import_rows.${field}.${batchId}.${sheet}.${String(rowNumber)}`;

const codeOf = (error: unknown): string => {
  if (error instanceof HttpException) {
    const body: unknown = error.getResponse();
    if (typeof body === 'object' && body !== null && 'error' in body) return String(body.error);
    return `http_${String(error.getStatus())}`;
  }
  return 'unexpected_error';
};
export { codeOf as importErrorCode };

/**
 * The bulk import of centers and doctors (task 2-9, doc 08 §12, doc 05 §8, ADR-030), behind
 * the `catalog.bulk_import_enabled` flag, for the network specialist
 * (`catalog.import_centers`). The file is scanned, read in memory and never kept; its
 * checked rows are, identifiers only encrypted. Committing hands the batch to the worker
 * (BulkImportWorker). A batch is its uploader's: nobody else sees it.
 *
 * The preview checks each row as the panel would, the references and duplicates within the
 * file, and against the database: an identifier, Sheba, council number or national ID
 * already registered is a duplicate; a city outside the uploader's scope, an unknown
 * treatment field or service is an error; a row depending on a rejected row is rejected.
 */
@Injectable()
export class BulkImportService {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(AUDIT_LOG) private readonly audit: AuditLog,
    @Inject(CONFIG) private readonly config: ConfigPort,
    @Inject(CATALOG_CRYPTO) private readonly crypto: CatalogCrypto,
    @Inject(MALWARE_SCANNER) private readonly scanner: MalwareScanner,
    @Inject(ORG_TREE) private readonly tree: OrgTreePort,
    private readonly tariffs: TariffService,
  ) {}

  /** The workbook to fill in: every sheet with its header row. */
  template(access: EffectiveAccess): Uint8Array {
    this.require(access);
    return writeWorkbook(bulkImportTemplate());
  }

  async upload(
    actor: Actor,
    access: EffectiveAccess,
    file: UploadedWorkbook | undefined,
  ): Promise<BulkPreview> {
    this.require(access);
    await this.requireEnabled();
    if (!file) throw new BadRequestException({ error: 'file_required' });
    if (!/\.xlsx$/i.test(file.originalname)) throw new BadRequestException({ error: 'xlsx_only' });
    if (file.size > BULK_IMPORT_LIMITS.maxFileBytes) {
      throw new BadRequestException({ error: 'file_too_large' });
    }
    // Scanned before anything reads it (rule 28).
    const scan = await this.scanner.scan(file.buffer);
    if (!scan.clean) throw new BadRequestException({ error: 'file_infected' });
    let workbook: ParsedWorkbook;
    try {
      workbook = parseBulkWorkbook(readSheets(new Uint8Array(file.buffer), BULK_IMPORT_LIMITS));
    } catch (error) {
      if (error instanceof XlsxError) throw new BadRequestException({ error: error.code });
      throw error;
    }
    if (workbook.problems.length > 0) {
      throw new BadRequestException({ error: 'invalid_workbook', problems: workbook.problems });
    }
    const statuses = await this.check(access, workbook);

    return this.db.transaction(async (tx) => {
      const summary: Record<string, Record<string, number>> = {};
      for (const sheet of BULK_IMPORT_SHEETS) {
        const counts = { valid: 0, duplicate: 0, error: 0 };
        for (const row of workbook[sheet] as ParsedRow<unknown>[])
          counts[statuses.get(row) ?? 'error']++;
        summary[sheet] = counts;
      }
      const [batch] = await tx
        .insert(catalogImportBatches)
        .values({ status: 'previewed', createdBy: actor.accountId ?? '', summary })
        .returning();
      if (!batch) throw new Error('batch insert returned nothing');
      const centerOfDoctor = new Map(
        workbook.doctors.map((d) => [d.ref, d.value?.center_ref ?? null] as const),
      );
      const values = BULK_IMPORT_SHEETS.flatMap((sheet) =>
        (workbook[sheet] as ParsedRow<unknown>[]).map((row) => {
          const status = statuses.get(row) ?? 'error';
          return {
            batchId: batch.id,
            sheet,
            rowNumber: row.rowNumber,
            ref: row.ref,
            centerRef: this.centerRefOf(sheet, row, centerOfDoctor),
            status,
            problems: row.problems,
            data: status === 'valid' ? this.stored(batch.id, sheet, row) : null,
          };
        }),
      );
      for (let i = 0; i < values.length; i += 500) {
        await tx.insert(catalogImportRows).values(values.slice(i, i + 500));
      }
      await this.audit.record(
        {
          actor,
          action: 'catalog.import_previewed',
          entityType: 'catalog_import_batch',
          entityId: batch.id,
          after: { summary },
        },
        tx,
      );
      return this.previewOf(tx, batch);
    });
  }

  async get(access: EffectiveAccess, batchId: string): Promise<BulkPreview> {
    this.require(access);
    return this.db.transaction(async (tx) =>
      this.previewOf(tx, await this.own(tx, access, batchId)),
    );
  }

  /**
   * The caller's own batches, newest first, filtered and paged on the server (task 2-11), with
   * whether the import is on: the page says so when it is off.
   */
  async list(access: EffectiveAccess, query: z.output<typeof bulkImportListQuerySchema>) {
    this.require(access);
    const page = query.page ?? 1;
    const pageSize = query.pageSize ?? 20;
    const where = and(
      eq(catalogImportBatches.createdBy, access.accountId),
      isNull(catalogImportBatches.deletedAt),
      ...(query.status ? [eq(catalogImportBatches.status, query.status)] : []),
    );
    const [flag, rows, [counted]] = await Promise.all([
      this.config.resolve('catalog.bulk_import_enabled'),
      this.db
        .select()
        .from(catalogImportBatches)
        .where(where)
        .orderBy(desc(catalogImportBatches.createdAt), desc(catalogImportBatches.id))
        .limit(pageSize)
        .offset((page - 1) * pageSize),
      this.db.select({ n: count() }).from(catalogImportBatches).where(where),
    ]);
    return {
      enabled: flag.value,
      page,
      pageSize,
      total: counted?.n ?? 0,
      items: rows.map((b) => ({
        batchId: b.id,
        status: b.status,
        summary: b.summary,
        createdAt: b.createdAt.toISOString(),
        committedAt: b.committedAt?.toISOString() ?? null,
        processedAt: b.processedAt?.toISOString() ?? null,
        cancelledAt: b.cancelledAt?.toISOString() ?? null,
      })),
    };
  }

  /** The preview becomes a batch: the worker creates its centers within seconds. */
  async commit(actor: Actor, access: EffectiveAccess, batchId: string, reason: string) {
    this.require(access);
    await this.requireEnabled();
    return this.db.transaction(async (tx) => {
      const batch = await this.own(tx, access, batchId, true);
      if (batch.status !== 'previewed') {
        throw new ConflictException({ error: 'not_previewed', status: batch.status });
      }
      const [after] = await tx
        .update(catalogImportBatches)
        .set({ status: 'committed', committedAt: sql`now()` })
        .where(eq(catalogImportBatches.id, batch.id))
        .returning();
      if (!after) throw new Error('batch update returned nothing');
      await this.audit.record(
        {
          actor,
          action: 'catalog.import_committed',
          entityType: 'catalog_import_batch',
          entityId: batch.id,
          before: { status: batch.status },
          after: { status: 'committed' },
          reason,
        },
        tx,
      );
      return this.previewOf(tx, after);
    });
  }

  /**
   * Undoes a batch while nothing of it was touched (doc 05 §8): a preview or a committed
   * batch not processed yet simply ends; a processed one only while every center it made is
   * still a draft nobody edited, with no documents, no other branch and no doctor. Its
   * centers, branches and their tree nodes are then retired (soft delete) and its held rows
   * cancelled.
   */
  async cancel(actor: Actor, access: EffectiveAccess, batchId: string, reason: string) {
    this.require(access);
    return this.db.transaction(async (tx) => {
      const batch = await this.own(tx, access, batchId, true);
      if (batch.status === 'cancelled') throw new ConflictException({ error: 'already_cancelled' });
      if (batch.status === 'processed') {
        const rows = await tx
          .select()
          .from(catalogImportRows)
          .where(eq(catalogImportRows.batchId, batch.id));
        if (rows.some((r) => r.status === 'applied' || r.status === 'proposed')) {
          throw new ConflictException({ error: 'batch_in_use' });
        }
        const centerIds = rows
          .filter((r) => r.sheet === 'centers' && r.status === 'created' && r.entityId)
          .map((r) => r.entityId as string);
        const branchIds = rows
          .filter((r) => r.sheet === 'branches' && r.status === 'created' && r.entityId)
          .map((r) => r.entityId as string);
        if (!(await this.untouched(tx, centerIds, branchIds))) {
          throw new ConflictException({ error: 'batch_in_use' });
        }
        await this.retire(tx, actor, access, centerIds, reason);
      }
      await tx
        .update(catalogImportRows)
        .set({ status: 'cancelled' })
        .where(
          and(
            eq(catalogImportRows.batchId, batch.id),
            inArray(catalogImportRows.status, ['valid', 'created', 'held']),
          ),
        );
      const [after] = await tx
        .update(catalogImportBatches)
        .set({ status: 'cancelled', cancelledAt: sql`now()`, cancelReason: reason })
        .where(eq(catalogImportBatches.id, batch.id))
        .returning();
      if (!after) throw new Error('batch update returned nothing');
      await this.audit.record(
        {
          actor,
          action: 'catalog.import_cancelled',
          entityType: 'catalog_import_batch',
          entityId: batch.id,
          before: { status: batch.status },
          after: { status: 'cancelled' },
          reason,
        },
        tx,
      );
      return this.previewOf(tx, after);
    });
  }

  /**
   * Every row and what became of it, as CSV for Excel (a BOM, so Persian shows right); a
   * cell starting with = + - @ is neutralized (csvField).
   */
  async report(access: EffectiveAccess, batchId: string): Promise<string> {
    this.require(access);
    const batch = await this.db.transaction((tx) => this.own(tx, access, batchId));
    const rows = await this.db
      .select()
      .from(catalogImportRows)
      .where(eq(catalogImportRows.batchId, batch.id))
      .orderBy(asc(catalogImportRows.sheet), asc(catalogImportRows.rowNumber));
    const lines: string[][] = [['برگه', 'ردیف', 'کد ردیف', 'وضعیت', 'ستون', 'مشکل']];
    const order = new Map(BULK_IMPORT_SHEETS.map((s, i) => [s, i]));
    rows.sort((a, b) => (order.get(a.sheet) ?? 0) - (order.get(b.sheet) ?? 0));
    for (const row of rows) {
      const spec = BULK_IMPORT_SPEC[row.sheet];
      const title = (column: string | null) =>
        column === null ? '' : (spec.columns.find((c) => c.code === column)?.title ?? column);
      const problems = row.failure ? [{ column: null, code: row.failure }] : row.problems;
      if (problems.length === 0) {
        lines.push([spec.title, String(row.rowNumber), row.ref ?? '', row.status, '', '']);
      }
      for (const p of problems) {
        lines.push([
          spec.title,
          String(row.rowNumber),
          row.ref ?? '',
          row.status,
          title(p.column),
          p.code,
        ]);
      }
    }
    return `\uFEFF${lines.map((l) => l.map(csvField).join(',')).join('\r\n')}\r\n`;
  }

  // --- the proposed price list (task 2-9 decision 2) ------------------------------------

  /**
   * The prices a batch proposed for an active center and its doctors: for whoever may set
   * that center's prices (TariffService decides, as for any price).
   */
  async proposedTariffs(actor: Actor, access: EffectiveAccess, centerId: string) {
    await this.tariffs.list(actor, access, { centerId });
    const rows = await this.proposedOf(this.db, centerId);
    return rows.map((r) => ({
      rowId: r.id,
      batchId: r.batchId,
      ...(r.data as Record<string, unknown>),
      owner: (r.data as { ownerWorkplaceId?: string }).ownerWorkplaceId ? 'workplace' : 'center',
    }));
  }

  /**
   * Applies the proposed prices of a center, each as its own price change by the caller
   * (their name in the audit trail, their authority checked for each owner). A row the caller
   * may not price stays proposed; one the tariff service refuses is `failed` with why.
   */
  async applyProposed(actor: Actor, access: EffectiveAccess, centerId: string, reason: string) {
    await this.tariffs.list(actor, access, { centerId });
    const rows = await this.proposedOf(this.db, centerId);
    const results: { rowId: string; status: string; failure?: string }[] = [];
    for (const row of rows) {
      const data = row.data as {
        serviceCode: string;
        pricing: { kind: 'free' } | { kind: 'range'; minRial: string; maxRial: string };
        ownerWorkplaceId?: string;
      };
      try {
        await this.tariffs.set(actor, access, {
          owner: data.ownerWorkplaceId
            ? { kind: 'workplace', workplaceId: data.ownerWorkplaceId }
            : { kind: 'center', centerId },
          serviceCode: data.serviceCode,
          pricing:
            data.pricing.kind === 'free'
              ? { kind: 'free' }
              : {
                  kind: 'range',
                  minRial: BigInt(data.pricing.minRial),
                  maxRial: BigInt(data.pricing.maxRial),
                },
          reason,
        });
        await this.db
          .update(catalogImportRows)
          .set({ status: 'applied' })
          .where(and(eq(catalogImportRows.id, row.id), eq(catalogImportRows.status, 'proposed')));
        results.push({ rowId: row.id, status: 'applied' });
      } catch (error) {
        const failure = codeOf(error);
        if (error instanceof ForbiddenException || error instanceof NotFoundException) {
          results.push({ rowId: row.id, status: 'proposed', failure });
          continue;
        }
        await this.db
          .update(catalogImportRows)
          .set({ status: 'failed', failure })
          .where(and(eq(catalogImportRows.id, row.id), eq(catalogImportRows.status, 'proposed')));
        results.push({ rowId: row.id, status: 'failed', failure });
      }
    }
    return results;
  }

  // --- helpers --------------------------------------------------------------------------

  private proposedOf(ex: Tx | Database, centerId: string) {
    return ex
      .select()
      .from(catalogImportRows)
      .where(
        and(
          eq(catalogImportRows.sheet, 'tariffs'),
          eq(catalogImportRows.status, 'proposed'),
          sql`${catalogImportRows.data}->>'centerId' = ${centerId}`,
        ),
      )
      .orderBy(asc(catalogImportRows.createdAt), asc(catalogImportRows.rowNumber));
  }

  /** Row statuses of the preview: the file's own checks, then the database's. */
  private async check(access: EffectiveAccess, wb: ParsedWorkbook) {
    const status = new Map<ParsedRow<unknown>, 'valid' | 'duplicate' | 'error'>();
    const problem = (row: ParsedRow<unknown>, column: string | null, code: string) => {
      row.problems.push({ column, code });
    };

    const cities = new Set<string>();
    let global = false;
    for (const scope of access.scopes) {
      if (scope.kind === 'global') global = true;
      if (scope.kind === 'city') cities.add(scope.code);
    }
    const fieldCodes = new Set(
      (
        await this.db
          .select({ code: treatmentFields.code })
          .from(treatmentFields)
          .where(isNull(treatmentFields.deletedAt))
      ).map((r) => r.code),
    );
    const serviceCodes = new Set(
      (
        await this.db
          .select({ code: services.code })
          .from(services)
          .where(isNull(services.deletedAt))
      ).map((r) => r.code),
    );

    for (const row of wb.centers) {
      const center = row.value?.center;
      if (!center) continue;
      if (!global && !cities.has(center.cityCode)) problem(row, 'city_code', 'city_out_of_scope');
      for (const code of center.treatmentFieldCodes ?? []) {
        if (!fieldCodes.has(code)) problem(row, 'treatment_field_codes', 'unknown_treatment_field');
      }
    }
    for (const row of wb.doctors) {
      for (const code of row.value?.treatment_field_codes ?? []) {
        if (!fieldCodes.has(code)) problem(row, 'treatment_field_codes', 'unknown_treatment_field');
      }
    }
    for (const row of wb.tariffs) {
      if (row.value && !serviceCodes.has(row.value.serviceCode)) {
        problem(row, 'service_code', 'unknown_service');
      }
    }
    for (const row of wb.schedules) {
      if (row.value?.range.serviceCodes.some((c) => !serviceCodes.has(c))) {
        problem(row, 'service_codes', 'unknown_service');
      }
    }

    // Already registered: a duplicate, not an error.
    const duplicate = new Set<ParsedRow<unknown>>();
    for (const row of wb.centers) {
      const center = row.value?.center;
      if (!center || row.problems.length > 0) continue;
      const kind = center.personType === 'natural' ? 'national_id' : 'legal_id';
      // Under every key of the ring (ADR-042): a center indexed under an older key is found.
      const identifierIndexes = this.crypto.blindIndex.allOf(kind, center.identifier);
      const shebaIndexes = center.sheba
        ? this.crypto.blindIndex.allOf('sheba', center.sheba)
        : null;
      const found = await this.db
        .select({ id: centers.id, identifierIndex: centers.identifierIndex })
        .from(centers)
        .where(
          and(
            isNull(centers.deletedAt),
            shebaIndexes
              ? or(
                  inArray(centers.identifierIndex, identifierIndexes),
                  inArray(centers.shebaIndex, shebaIndexes),
                )
              : inArray(centers.identifierIndex, identifierIndexes),
          ),
        );
      if (found.length > 0) {
        duplicate.add(row);
        problem(
          row,
          found.some((f) => identifierIndexes.includes(f.identifierIndex)) ? 'identifier' : 'sheba',
          'already_registered',
        );
      }
    }
    for (const row of wb.doctors) {
      const d = row.value;
      if (!d || row.problems.length > 0) continue;
      const nationalIndexes = d.national_id
        ? this.crypto.blindIndex.allOf('national_id', d.national_id)
        : null;
      const found = await this.db
        .select({ number: doctors.medicalCouncilNumber })
        .from(doctors)
        .where(
          and(
            isNull(doctors.deletedAt),
            nationalIndexes
              ? or(
                  eq(doctors.medicalCouncilNumber, d.medical_council_number),
                  inArray(doctors.nationalIdIndex, nationalIndexes),
                )
              : eq(doctors.medicalCouncilNumber, d.medical_council_number),
          ),
        );
      if (found.length > 0) {
        duplicate.add(row);
        problem(
          row,
          found.some((f) => f.number === d.medical_council_number)
            ? 'medical_council_number'
            : 'national_id',
          'already_registered',
        );
      }
    }

    // A row that depends on a row not imported is not imported either.
    const good = (row: ParsedRow<unknown>) => row.value !== null && row.problems.length === 0;
    const centerOk = new Set(wb.centers.filter(good).map((r) => r.ref));
    const branchOk = new Set(
      wb.branches
        .filter((r) => good(r) && centerOk.has(r.value?.center_ref ?? ''))
        .map((r) => r.ref),
    );
    const doctorOk = new Set(
      wb.doctors
        .filter(
          (r) =>
            good(r) &&
            centerOk.has(r.value?.center_ref ?? '') &&
            (r.value?.branch_ref === '' || branchOk.has(r.value?.branch_ref ?? '')),
        )
        .map((r) => r.ref),
    );
    const depends = (row: ParsedRow<unknown>, ok: boolean, column: string) => {
      if (good(row) && !ok) problem(row, column, 'depends_on_rejected_row');
    };
    for (const r of wb.branches) depends(r, centerOk.has(r.value?.center_ref ?? ''), 'center_ref');
    for (const r of wb.doctors) {
      depends(
        r,
        centerOk.has(r.value?.center_ref ?? '') &&
          (r.value?.branch_ref === '' || branchOk.has(r.value?.branch_ref ?? '')),
        'center_ref',
      );
    }
    for (const r of wb.tariffs) {
      const owner = r.value?.ownerRef ?? '';
      depends(r, centerOk.has(owner) || doctorOk.has(owner), 'owner_ref');
    }
    for (const r of wb.schedules) depends(r, doctorOk.has(r.value?.doctorRef ?? ''), 'doctor_ref');

    for (const sheet of BULK_IMPORT_SHEETS) {
      for (const row of wb[sheet] as ParsedRow<unknown>[]) {
        status.set(
          row,
          duplicate.has(row) && row.problems.every((p) => p.code === 'already_registered')
            ? 'duplicate'
            : row.value === null || row.problems.length > 0
              ? 'error'
              : 'valid',
        );
      }
    }
    return status;
  }

  /** The center (by row code) a row belongs to, to apply it once that center is active. */
  private centerRefOf(
    sheet: BulkImportSheet,
    row: ParsedRow<unknown>,
    centerOfDoctor: Map<string | null, string | null>,
  ): string | null {
    const v = row.value as Record<string, unknown> | null;
    if (!v) return null;
    if (sheet === 'centers') return row.ref;
    if (sheet === 'branches' || sheet === 'doctors') return v['center_ref'] as string;
    if (sheet === 'tariffs') {
      const owner = v['ownerRef'] as string;
      return centerOfDoctor.get(owner) ?? owner;
    }
    return centerOfDoctor.get(v['doctorRef'] as string) ?? null;
  }

  /** What a valid row keeps: identifiers only encrypted, bigints as strings. */
  private stored(batchId: string, sheet: BulkImportSheet, row: ParsedRow<unknown>) {
    const secret = (field: string, value: string) => ({
      enc: this.crypto.fieldCrypto.encrypt(
        value,
        importContext(batchId, sheet, row.rowNumber, field),
      ),
      last4: lastFour(value),
    });
    const v = row.value as Record<string, unknown>;
    if (sheet === 'centers') {
      const { identifier, sheba, ...center } = (v as { center: Record<string, unknown> }).center;
      return {
        center,
        identifier: secret('identifier', String(identifier)),
        ...(typeof sheba === 'string' ? { sheba: secret('sheba', sheba) } : {}),
      };
    }
    if (sheet === 'doctors') {
      const { national_id: nationalId, ...rest } = v;
      return {
        ...rest,
        ...(typeof nationalId === 'string' && nationalId !== ''
          ? { nationalId: secret('national_id', nationalId) }
          : {}),
      };
    }
    return JSON.parse(
      JSON.stringify(v, (_key, value: unknown) =>
        typeof value === 'bigint' ? value.toString() : value,
      ),
    ) as Record<string, unknown>;
  }

  private async previewOf(ex: Tx | Database, batch: BatchRow): Promise<BulkPreview> {
    const rejected = await ex
      .select()
      .from(catalogImportRows)
      .where(
        and(
          eq(catalogImportRows.batchId, batch.id),
          inArray(catalogImportRows.status, ['error', 'duplicate', 'failed']),
        ),
      )
      .orderBy(asc(catalogImportRows.sheet), asc(catalogImportRows.rowNumber));
    return {
      batchId: batch.id,
      status: batch.status,
      summary: batch.summary,
      rejected: rejected.map((r) => ({
        sheet: r.sheet,
        rowNumber: r.rowNumber,
        ref: r.ref,
        status: r.status,
        problems: r.failure ? [{ column: null, code: r.failure }] : r.problems,
      })),
    };
  }

  /** A batch of the caller's own; anyone else's is not found. */
  private async own(ex: Tx, access: EffectiveAccess, batchId: string, lock = false) {
    if (!UUID.test(batchId)) throw new NotFoundException({ error: 'batch_not_found' });
    const query = ex
      .select()
      .from(catalogImportBatches)
      .where(eq(catalogImportBatches.id, batchId));
    const [batch] = lock ? await query.for('update') : await query;
    if (!batch || batch.createdBy !== access.accountId) {
      throw new NotFoundException({ error: 'batch_not_found' });
    }
    return batch;
  }

  /** Soft-deletes the centers, their branches and their tree nodes (rule 7). */
  private async retire(
    tx: Tx,
    actor: Actor,
    access: EffectiveAccess,
    centerIds: string[],
    reason: string,
  ) {
    if (centerIds.length === 0) return;
    const centerRows = await tx.select().from(centers).where(inArray(centers.id, centerIds));
    const branchRows = await tx
      .select()
      .from(branches)
      .where(inArray(branches.centerId, centerIds));
    await tx
      .update(branches)
      .set({ deletedAt: sql`now()` })
      .where(inArray(branches.centerId, centerIds));
    await tx
      .update(centers)
      .set({ deletedAt: sql`now()` })
      .where(inArray(centers.id, centerIds));
    await this.tree.retireNodes(
      actor,
      access,
      [...centerRows.map((c) => c.nodeId), ...branchRows.map((b) => b.nodeId)],
      reason,
      tx,
    );
    for (const center of centerRows) {
      await this.audit.record(
        {
          actor,
          action: 'catalog.center_import_undone',
          entityType: 'center',
          entityId: center.id,
          before: { status: center.status, name: center.name },
          reason,
        },
        tx,
      );
    }
  }

  /** Nothing of these centers was touched since the import made them. */
  private async untouched(tx: Tx, centerIds: string[], branchIds: string[]): Promise<boolean> {
    if (centerIds.length === 0) return true;
    const { rows } = await tx.execute(sql`
      SELECT
        (SELECT count(*) FROM centers c
          WHERE c.id IN ${centerIds}
            AND (c.status <> 'draft' OR c.updated_at <> c.created_at OR c.deleted_at IS NOT NULL))
        + (SELECT count(*) FROM center_documents d WHERE d.center_id IN ${centerIds})
        + (SELECT count(*) FROM branches b
            WHERE b.center_id IN ${centerIds} AND b.deleted_at IS NULL
              AND NOT b.is_default AND b.id NOT IN ${branchIds.length > 0 ? branchIds : ['00000000-0000-0000-0000-000000000000']})
        + (SELECT count(*) FROM doctor_workplaces w
            WHERE w.center_id IN ${centerIds} AND w.deleted_at IS NULL) AS touched
    `);
    return Number(rows[0]?.['touched']) === 0;
  }

  private require(access: EffectiveAccess) {
    if (!access.permissions.has(IMPORT)) {
      throw new ForbiddenException({ error: 'permission_required', permission: IMPORT });
    }
  }

  private async requireEnabled() {
    const flag = await this.config.resolve('catalog.bulk_import_enabled');
    if (!flag.value) throw new ForbiddenException({ error: 'feature_disabled' });
  }
}

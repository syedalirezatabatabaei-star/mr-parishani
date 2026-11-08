import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  csvField,
  LEAD_IMPORT_COLUMNS,
  LEAD_IMPORT_LIMITS,
  normalizeMobile,
  normalizeNationalId,
  normalizePersianText,
  type LeadImportColumn,
} from '@sepehr/contracts';
import { and, asc, count, eq, isNull, ne, sql } from 'drizzle-orm';
import type { EffectiveAccess } from '../../common/auth/access.port';
import { AUDIT_LOG, type Actor, type AuditLog } from '../../common/audit/audit.port';
import { CONFIG, type ConfigPort } from '../../common/config/config.port';
import { OUTBOX, type OutboxPort } from '../../common/events/outbox.port';
import { MALWARE_SCANNER, type MalwareScanner } from '../../common/security/malware-scanner.port';
import { DATABASE, type Database } from '../../db/database.module';
import { IMPORT_ROW_NATIONAL_ID, LEAD_CRYPTO, type LeadCrypto } from './lead.crypto';
import {
  caseAssignments,
  caseIntakes,
  cases,
  caseStatusChanges,
  leadImportBatches,
  leadImportRows,
  persons,
} from './lead.schema';
import { requirePermission, UUID, type Tx } from './lead.shared';
import { PersonMobileApprovalService } from './person-mobile-approval.service';
import { PersonMobiles } from './person-mobiles';
import { readFirstSheet, writeSheet, XlsxError } from '../../common/xlsx';

type BatchRow = typeof leadImportBatches.$inferSelect;

/** An uploaded file as the multipart parser hands it over; kept in memory only. */
export interface UploadedSheet {
  readonly originalname: string;
  readonly size: number;
  readonly buffer: Buffer;
}

export interface ImportPreview {
  readonly batchId: string;
  readonly status: BatchRow['status'];
  readonly rowCount: number;
  /** Valid rows whose mobile has no person yet. */
  readonly newCount: number;
  /** Valid rows of a person already known: they become duplicates or returning cases. */
  readonly existingCount: number;
  readonly errorCount: number;
  readonly errors: { row: number; codes: string[] }[];
}

const CODE = /^[a-z][a-z0-9_]{1,62}$/;
const YES = new Set(['1', 'true', 'yes', 'y', 'بله', 'بلی', 'آری', 'دارد']);
const NO = new Set(['', '0', 'false', 'no', 'n', 'خیر', 'نه', 'ندارد']);

const headerKey = (value: string) => normalizePersianText(value).toLowerCase();

/**
 * The Excel import of patients and leads (doc 05 §8; task 2-5b decision 2). The file is
 * read in memory and never stored: its rows are normalized and kept (a national ID only
 * encrypted) for the preview, then processed in the worker after commit. The whole import
 * is behind the `lead.excel_import_enabled` flag. Since task 2-8 every upload is scanned by
 * ClamAV (MALWARE_SCANNER) before it is read; the flag is turned on by the owner, with the
 * two-person config approval.
 *
 * Cancelling a batch undoes only what nobody has touched since: a case still `new` with
 * no other status change, intake or manual assignment, and a person the batch created
 * who has nothing else and no account. Undoing is a soft delete (rule 7).
 */
@Injectable()
export class LeadImportService {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(AUDIT_LOG) private readonly audit: AuditLog,
    @Inject(CONFIG) private readonly config: ConfigPort,
    @Inject(OUTBOX) private readonly outbox: OutboxPort,
    @Inject(LEAD_CRYPTO) private readonly crypto: LeadCrypto,
    @Inject(MALWARE_SCANNER) private readonly scanner: MalwareScanner,
    private readonly mobiles: PersonMobileApprovalService,
  ) {}

  /** The sheet to fill in: one header row of the column titles. */
  template(access: EffectiveAccess): Uint8Array {
    requirePermission(access, 'lead.import');
    return writeSheet([LEAD_IMPORT_COLUMNS.map((c) => c.title)]);
  }

  async upload(
    actor: Actor,
    access: EffectiveAccess,
    file: UploadedSheet | undefined,
  ): Promise<ImportPreview> {
    requirePermission(access, 'lead.import');
    await this.requireEnabled();
    if (!file) throw new BadRequestException({ error: 'file_required' });
    if (!/\.xlsx$/i.test(file.originalname)) throw new BadRequestException({ error: 'xlsx_only' });
    if (file.size > LEAD_IMPORT_LIMITS.maxFileBytes) {
      throw new BadRequestException({ error: 'file_too_large' });
    }
    // Scanned before anything reads it (rule 28, task 2-8); no scanner, no import.
    const scan = await this.scanner.scan(file.buffer);
    if (!scan.clean) throw new BadRequestException({ error: 'file_infected' });
    let rows: string[][];
    try {
      rows = readFirstSheet(new Uint8Array(file.buffer), LEAD_IMPORT_LIMITS);
    } catch (error) {
      if (error instanceof XlsxError) throw new BadRequestException({ error: error.code });
      throw error;
    }
    const [header, ...data] = rows;
    if (!header) throw new BadRequestException({ error: 'empty_sheet' });
    const columns = new Map<LeadImportColumn, number>();
    header.forEach((cell, index) => {
      const key = headerKey(cell);
      const column = LEAD_IMPORT_COLUMNS.find((c) => c.code === key || headerKey(c.title) === key);
      if (column && !columns.has(column.code)) columns.set(column.code, index);
    });
    const missing = LEAD_IMPORT_COLUMNS.filter((c) => c.required && !columns.has(c.code)).map(
      (c) => c.code,
    );
    if (missing.length > 0)
      throw new BadRequestException({ error: 'missing_columns', columns: missing });

    const seen = new Set<string>();
    const parsed = data.map((cells, i) => {
      const get = (code: LeadImportColumn) => {
        const index = columns.get(code);
        return index === undefined ? '' : (cells[index] ?? '').trim();
      };
      const errors: string[] = [];
      const mobile = normalizeMobile(get('mobile'));
      if (mobile === null) errors.push('invalid_mobile');
      else if (seen.has(mobile)) errors.push('duplicate_in_file');
      else seen.add(mobile);
      const rawName = normalizePersianText(get('name'));
      const name = rawName === '' ? null : rawName;
      if (name !== null && (name.length < 2 || name.length > 200)) errors.push('invalid_name');
      const rawNationalId = get('national_id');
      const nationalId = rawNationalId === '' ? null : normalizeNationalId(rawNationalId);
      if (rawNationalId !== '' && nationalId === null) errors.push('invalid_national_id');
      const field = get('treatment_field_code').toLowerCase();
      if (field === '') errors.push('missing_treatment_field');
      else if (!CODE.test(field)) errors.push('invalid_treatment_field');
      const city = get('city_code').toLowerCase();
      if (city !== '' && !CODE.test(city)) errors.push('invalid_city');
      const consent = headerKey(get('sms_consent'));
      if (!YES.has(consent) && !NO.has(consent)) errors.push('invalid_sms_consent');
      return {
        rowNumber: i + 2,
        status: errors.length === 0 ? ('valid' as const) : ('error' as const),
        errors,
        mobile,
        name,
        nationalIdEnc:
          nationalId === null
            ? null
            : this.crypto.fieldCrypto.encrypt(nationalId, IMPORT_ROW_NATIONAL_ID),
        treatmentFieldCode: field === '' ? null : field,
        cityCode: city === '' ? null : city,
        smsConsent: YES.has(consent),
      };
    });

    return this.db.transaction(async (tx) => {
      const valid = parsed.filter((r) => r.status === 'valid');
      const [batch] = await tx
        .insert(leadImportBatches)
        .values({
          status: 'previewed',
          fileName: normalizePersianText(file.originalname).slice(0, 200),
          rowCount: parsed.length,
          validCount: valid.length,
          errorCount: parsed.length - valid.length,
          createdBy: actor.accountId,
        })
        .returning();
      if (!batch) throw new Error('batch insert returned nothing');
      for (let i = 0; i < parsed.length; i += 500) {
        const chunk = parsed.slice(i, i + 500);
        if (chunk.length > 0) {
          await tx.insert(leadImportRows).values(chunk.map((r) => ({ ...r, batchId: batch.id })));
        }
      }
      await this.audit.record(
        {
          actor,
          action: 'lead.import_uploaded',
          entityType: 'lead_import_batch',
          entityId: batch.id,
          after: {
            rowCount: batch.rowCount,
            validCount: batch.validCount,
            errorCount: batch.errorCount,
          },
        },
        tx,
      );
      return this.preview(tx, batch);
    });
  }

  async get(access: EffectiveAccess, batchId: string): Promise<ImportPreview> {
    requirePermission(access, 'lead.import');
    const batch = await this.batch(this.db, batchId);
    return this.preview(this.db, batch);
  }

  /** Commits a previewed batch: the worker processes its valid rows (an outbox event). */
  async commit(actor: Actor, access: EffectiveAccess, batchId: string, reason: string) {
    requirePermission(access, 'lead.import');
    await this.requireEnabled();
    return this.db.transaction(async (tx) => {
      const batch = await this.batch(tx, batchId, true);
      if (batch.status !== 'previewed')
        throw new ConflictException({ error: 'batch_not_previewed' });
      await tx
        .update(leadImportBatches)
        .set({ status: 'committed', committedAt: new Date(), committedBy: actor.accountId })
        .where(eq(leadImportBatches.id, batch.id));
      await this.outbox.publish(
        {
          type: 'lead.import_committed',
          aggregateType: 'lead_import_batch',
          aggregateId: batch.id,
          payload: { batchId: batch.id },
        },
        tx,
      );
      await this.audit.record(
        {
          actor,
          action: 'lead.import_committed',
          entityType: 'lead_import_batch',
          entityId: batch.id,
          before: { status: batch.status },
          after: { status: 'committed' },
          reason,
        },
        tx,
      );
      return { batchId: batch.id, status: 'committed' as const };
    });
  }

  /**
   * Cancels a batch: undoes each record nobody has acted on since (doc 05 §10 test 6) and
   * keeps the rest; returns how many rows were undone and kept.
   */
  async cancel(actor: Actor, access: EffectiveAccess, batchId: string, reason: string) {
    requirePermission(access, 'lead.import');
    return this.db.transaction(async (tx) => {
      const batch = await this.batch(tx, batchId, true);
      if (batch.status === 'cancelled') throw new ConflictException({ error: 'batch_cancelled' });
      const rows = await tx
        .select()
        .from(leadImportRows)
        .where(and(eq(leadImportRows.batchId, batch.id), eq(leadImportRows.status, 'processed')))
        .orderBy(asc(leadImportRows.rowNumber))
        .for('update');
      let undone = 0;
      const kept: number[] = [];
      for (const row of rows) {
        if (await this.undoRow(tx, batch.id, row)) undone++;
        else kept.push(row.rowNumber);
      }
      // Task 9-3 (owner 1405/07/19): the mobiles it added pending to Persons who existed are
      // refused with it, whatever became of the rows, each a decision of its own.
      const { rejected: rejectedMobiles } = await this.mobiles.rejectForImport(
        tx,
        actor,
        batch.id,
        reason,
      );
      await tx
        .update(leadImportRows)
        .set({ status: 'cancelled' })
        .where(and(eq(leadImportRows.batchId, batch.id), eq(leadImportRows.status, 'valid')));
      await tx
        .update(leadImportBatches)
        .set({
          status: 'cancelled',
          cancelledAt: new Date(),
          cancelledBy: actor.accountId,
          cancelReason: reason,
        })
        .where(eq(leadImportBatches.id, batch.id));
      await this.audit.record(
        {
          actor,
          action: 'lead.import_cancelled',
          entityType: 'lead_import_batch',
          entityId: batch.id,
          before: { status: batch.status },
          after: { status: 'cancelled', undone, keptRows: kept, rejectedMobiles },
          reason,
        },
        tx,
      );
      return { batchId: batch.id, undone, keptRows: kept };
    });
  }

  /** The rows, their outcome and their errors, as CSV; spreadsheet formulas neutralized. */
  async report(access: EffectiveAccess, batchId: string): Promise<string> {
    requirePermission(access, 'lead.import');
    const batch = await this.batch(this.db, batchId);
    const rows = await this.db
      .select()
      .from(leadImportRows)
      .where(eq(leadImportRows.batchId, batch.id))
      .orderBy(asc(leadImportRows.rowNumber));
    const lines = [
      ['row', 'status', 'errors', 'mobile', 'name', 'treatment_field_code', 'city_code'],
    ];
    for (const r of rows) {
      lines.push([
        String(r.rowNumber),
        r.status,
        r.errors.join(' '),
        r.mobile ?? '',
        r.name ?? '',
        r.treatmentFieldCode ?? '',
        r.cityCode ?? '',
      ]);
    }
    // A byte-order mark so that spreadsheet apps read the Persian text as UTF-8.
    return `\uFEFF${lines.map((l) => l.map(csvField).join(',')).join('\r\n')}\r\n`;
  }

  // --- helpers ----------------------------------------------------------------------------

  private async requireEnabled() {
    const flag = await this.config.resolve('lead.excel_import_enabled');
    if (!flag.value) throw new ForbiddenException({ error: 'feature_disabled' });
  }

  private async batch(ex: Tx | Database, batchId: string, lock = false): Promise<BatchRow> {
    if (!UUID.test(batchId)) throw new NotFoundException({ error: 'batch_not_found' });
    const query = ex.select().from(leadImportBatches).where(eq(leadImportBatches.id, batchId));
    const [row] = lock ? await query.for('update') : await query;
    if (!row) throw new NotFoundException({ error: 'batch_not_found' });
    return row;
  }

  private async preview(ex: Tx | Database, batch: BatchRow): Promise<ImportPreview> {
    const rows = await ex
      .select({
        rowNumber: leadImportRows.rowNumber,
        status: leadImportRows.status,
        errors: leadImportRows.errors,
        mobile: leadImportRows.mobile,
      })
      .from(leadImportRows)
      .where(eq(leadImportRows.batchId, batch.id))
      .orderBy(asc(leadImportRows.rowNumber));
    const validMobiles = rows.flatMap((r) => (r.status !== 'error' && r.mobile ? [r.mobile] : []));
    const known = await PersonMobiles.countKnown(ex, validMobiles);
    const errors = rows
      .filter((r) => r.errors.length > 0)
      .map((r) => ({ row: r.rowNumber, codes: r.errors }));
    return {
      batchId: batch.id,
      status: batch.status,
      rowCount: batch.rowCount,
      newCount: batch.validCount - known,
      existingCount: known,
      errorCount: batch.errorCount,
      errors,
    };
  }

  /** Undoes one processed row if nobody has acted on what it made; else leaves it. */
  private async undoRow(
    tx: Tx,
    batchId: string,
    row: typeof leadImportRows.$inferSelect,
  ): Promise<boolean> {
    let caseUndone = false;
    if (row.caseId) {
      const [kase] = await tx.select().from(cases).where(eq(cases.id, row.caseId)).for('update');
      if (kase && kase.importBatchId === batchId && kase.deletedAt === null) {
        const [changes] = await tx
          .select({ n: count() })
          .from(caseStatusChanges)
          .where(eq(caseStatusChanges.caseId, kase.id));
        const [intakes] = await tx
          .select({ n: count() })
          .from(caseIntakes)
          .where(eq(caseIntakes.caseId, kase.id));
        const [manual] = await tx
          .select({ n: count() })
          .from(caseAssignments)
          .where(and(eq(caseAssignments.caseId, kase.id), eq(caseAssignments.kind, 'manual')));
        const untouched =
          kase.status === 'new' &&
          (changes?.n ?? 0) === 1 &&
          (intakes?.n ?? 0) === 1 &&
          (manual?.n ?? 0) === 0;
        if (!untouched) return false;
        await tx.update(cases).set({ deletedAt: new Date() }).where(eq(cases.id, kase.id));
        caseUndone = true;
      } else if (kase && kase.importBatchId !== batchId) {
        // The row only added an intake to someone's case: there is nothing of its own to undo,
        // and the intake stays in the history.
        await tx
          .update(leadImportRows)
          .set({ status: 'cancelled' })
          .where(eq(leadImportRows.id, row.id));
        return true;
      }
    }
    if (row.createdPerson && row.personId) {
      const [person] = await tx
        .select()
        .from(persons)
        .where(eq(persons.id, row.personId))
        .for('update');
      const [otherCases] = await tx
        .select({ n: count() })
        .from(cases)
        .where(and(eq(cases.personId, row.personId), isNull(cases.deletedAt)));
      const [otherIntakes] = await tx
        .select({ n: count() })
        .from(caseIntakes)
        .where(
          and(
            eq(caseIntakes.personId, row.personId),
            sql`${caseIntakes.importBatchId} IS DISTINCT FROM ${batchId}`,
          ),
        );
      const [mergedIn] = await tx
        .select({ n: count() })
        .from(persons)
        .where(eq(persons.mergedIntoId, row.personId));
      const untouched =
        person !== undefined &&
        person.deletedAt === null &&
        person.accountLinkedAt === null &&
        person.mergedIntoId === null &&
        person.blockedAt === null &&
        (otherCases?.n ?? 0) === 0 &&
        (otherIntakes?.n ?? 0) === 0 &&
        (mergedIn?.n ?? 0) === 0;
      if (untouched) {
        await PersonMobiles.retireOfPerson(tx, row.personId, new Date());
        await tx.update(persons).set({ deletedAt: new Date() }).where(eq(persons.id, row.personId));
      } else if (!caseUndone) {
        return false;
      }
    } else if (!caseUndone && row.caseId) {
      return false;
    }
    await tx
      .update(leadImportRows)
      .set({ status: 'cancelled' })
      .where(and(eq(leadImportRows.id, row.id), ne(leadImportRows.status, 'cancelled')));
    return true;
  }
}

import { Inject, Injectable, Logger } from '@nestjs/common';
import type { BulkRowValue, createCenterSchema } from '@sepehr/contracts';
import { and, asc, eq, inArray, isNull, sql } from 'drizzle-orm';
import type { z } from 'zod';
import { ACCESS_PORT, type AccessPort, type EffectiveAccess } from '../../common/auth/access.port';
import type { Actor } from '../../common/audit/audit.port';
import {
  WORKPLACE_CALENDAR,
  type WorkplaceCalendar,
} from '../../common/booking/workplace-calendar.port';
import { DATABASE, type Database } from '../../db/database.module';
import { importContext, importErrorCode } from './bulk-import.service';
import { CATALOG_CRYPTO, type CatalogCrypto } from './catalog.crypto';
import {
  branches,
  catalogImportBatches,
  catalogImportRows,
  doctorWorkplaces,
} from './catalog.schema';
import { CenterService } from './center.service';
import { DoctorService } from './doctor.service';

type ImportRow = typeof catalogImportRows.$inferSelect;
type Secret = { enc: string; last4: string };

export interface ImportPassResult {
  readonly batchesProcessed: number;
  readonly created: number;
  readonly applied: number;
  readonly proposed: number;
  readonly failed: number;
}

const REASON = 'ورود گروهی از اکسل';

/**
 * The worker's import job (task 2-9, every 10 seconds), idempotent and outside any outbox
 * transaction; every row is written once, by its own status:
 *
 * 1. Committed batches: their centers (as `draft`, never active: doc 08 §15 test 9) and
 *    branches are created through CenterService, as the uploader with their access now.
 *    Doctor, tariff and schedule rows become `held` (task 2-9 decision 1).
 * 2. Held rows of a center that has since been activated: doctors (DoctorService), then
 *    schedules (booking's WORKPLACE_CALENDAR, one weekly schedule per doctor), each as the
 *    uploader; tariffs become `proposed` for the center's manager to apply (decision 2).
 *
 * A row a service refuses is `failed` with the service's error code; so are the rows that
 * depended on it. Nothing is retried blindly: the report says what to fix.
 */
@Injectable()
export class BulkImportWorker {
  private readonly logger = new Logger(BulkImportWorker.name);

  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(ACCESS_PORT) private readonly accessPort: AccessPort,
    @Inject(CATALOG_CRYPTO) private readonly crypto: CatalogCrypto,
    @Inject(WORKPLACE_CALENDAR) private readonly calendar: WorkplaceCalendar,
    private readonly centerService: CenterService,
    private readonly doctorService: DoctorService,
  ) {}

  async run(): Promise<ImportPassResult> {
    const counts = { batchesProcessed: 0, created: 0, applied: 0, proposed: 0, failed: 0 };
    const committed = await this.db
      .select()
      .from(catalogImportBatches)
      .where(eq(catalogImportBatches.status, 'committed'))
      .orderBy(asc(catalogImportBatches.committedAt));
    for (const batch of committed) {
      await this.processBatch(batch.id, batch.createdBy, counts);
      counts.batchesProcessed++;
    }
    await this.applyHeld(counts);
    return counts;
  }

  // --- 1. centers and branches --------------------------------------------------------

  private async processBatch(
    batchId: string,
    createdBy: string,
    counts: { created: number; failed: number },
  ) {
    const who = await this.uploader(createdBy);
    const rows = await this.rowsOf(batchId, ['valid']);
    const centerIds = new Map<string, string>();
    for (const row of rows.filter((r) => r.sheet === 'centers')) {
      const data = row.data as {
        center: Omit<z.output<typeof createCenterSchema>, 'identifier' | 'sheba'>;
        identifier: Secret;
        sheba?: Secret;
      };
      const input = {
        ...data.center,
        identifier: this.reveal(batchId, row, 'identifier', data.identifier),
        ...(data.sheba ? { sheba: this.reveal(batchId, row, 'sheba', data.sheba) } : {}),
      } as z.output<typeof createCenterSchema>;
      try {
        const center = await this.centerService.create(who.actor, who.access, input);
        centerIds.set(row.ref ?? '', center.id);
        await this.mark(row, { status: 'created', entityId: center.id });
        counts.created++;
      } catch (error) {
        await this.mark(row, { status: 'failed', failure: importErrorCode(error) });
        counts.failed++;
      }
    }
    for (const row of rows.filter((r) => r.sheet === 'branches')) {
      const data = row.data as BulkRowValue<'branches'>;
      const centerId = centerIds.get(data.center_ref);
      if (!centerId) {
        await this.mark(row, { status: 'failed', failure: 'center_not_created' });
        counts.failed++;
        continue;
      }
      try {
        const branch = await this.centerService.createBranch(who.actor, who.access, centerId, {
          name: data.name,
          ...(data.address ? { address: data.address } : {}),
          ...(data.phone ? { phone: data.phone } : {}),
          reason: REASON,
        });
        await this.mark(row, { status: 'created', entityId: branch.id });
        counts.created++;
      } catch (error) {
        await this.mark(row, { status: 'failed', failure: importErrorCode(error) });
        counts.failed++;
      }
    }
    for (const row of rows.filter((r) => ['doctors', 'tariffs', 'schedules'].includes(r.sheet))) {
      const ok = row.centerRef !== null && centerIds.has(row.centerRef);
      await this.mark(
        row,
        ok ? { status: 'held' } : { status: 'failed', failure: 'center_not_created' },
      );
      if (!ok) counts.failed++;
    }
    await this.db
      .update(catalogImportBatches)
      .set({ status: 'processed', processedAt: sql`now()` })
      .where(
        and(eq(catalogImportBatches.id, batchId), eq(catalogImportBatches.status, 'committed')),
      );
  }

  // --- 2. what waited for the center to be active -------------------------------------

  private async applyHeld(counts: { applied: number; proposed: number; failed: number }) {
    // The centers (by batch and row code) with held rows that are active now.
    const { rows: ready } = await this.db.execute(sql`
      SELECT DISTINCT h.batch_id, h.center_ref, c.id AS center_id, b.created_by
      FROM catalog_import_rows h
      JOIN catalog_import_batches b ON b.id = h.batch_id AND b.status = 'processed'
      JOIN catalog_import_rows cr ON cr.batch_id = h.batch_id AND cr.sheet = 'centers'
        AND cr.ref = h.center_ref AND cr.status = 'created'
      JOIN centers c ON c.id = cr.entity_id AND c.status = 'active' AND c.deleted_at IS NULL
      WHERE h.status = 'held'
    `);
    for (const r of ready) {
      await this.applyCenter(
        String(r['batch_id']),
        String(r['center_ref']),
        String(r['center_id']),
        String(r['created_by']),
        counts,
      );
    }
  }

  private async applyCenter(
    batchId: string,
    centerRef: string,
    centerId: string,
    createdBy: string,
    counts: { applied: number; proposed: number; failed: number },
  ) {
    const who = await this.uploader(createdBy);
    const all = await this.rowsOf(batchId, ['held', 'created', 'applied']);
    const held = all.filter((r) => r.status === 'held' && r.centerRef === centerRef);
    const branchIds = new Map(
      all
        .filter((r) => r.sheet === 'branches' && r.entityId)
        .map((r) => [r.ref ?? '', r.entityId as string]),
    );
    const [defaultBranch] = await this.db
      .select({ id: branches.id })
      .from(branches)
      .where(
        and(
          eq(branches.centerId, centerId),
          eq(branches.isDefault, true),
          isNull(branches.deletedAt),
        ),
      );

    // Doctors first: tariffs and schedules of a doctor need their workplace.
    const workplaces = new Map(
      all
        .filter((r) => r.sheet === 'doctors' && r.status === 'applied' && r.entityId)
        .map((r) => [r.ref ?? '', r.entityId as string]),
    );
    for (const row of held.filter((r) => r.sheet === 'doctors')) {
      const data = row.data as Omit<BulkRowValue<'doctors'>, 'national_id'> & {
        nationalId?: Secret;
      };
      const branchId = data.branch_ref === '' ? defaultBranch?.id : branchIds.get(data.branch_ref);
      if (!branchId) {
        await this.fail(row, 'branch_not_created', counts);
        continue;
      }
      try {
        const doctor = await this.doctorService.register(who.actor, who.access, {
          name: data.name,
          medicalCouncilNumber: data.medical_council_number,
          ...(data.nationalId
            ? { nationalId: this.reveal(batchId, row, 'national_id', data.nationalId) }
            : {}),
          ...(data.treatment_field_codes.length
            ? { treatmentFieldCodes: data.treatment_field_codes }
            : {}),
          workplace: { kind: 'branch', branchId },
          reason: REASON,
        });
        const [workplace] = await this.db
          .select({ id: doctorWorkplaces.id })
          .from(doctorWorkplaces)
          .where(
            and(eq(doctorWorkplaces.doctorId, doctor.id), eq(doctorWorkplaces.branchId, branchId)),
          );
        if (!workplace) throw new Error('workplace not found after registration');
        workplaces.set(row.ref ?? '', workplace.id);
        await this.mark(row, { status: 'applied', entityId: workplace.id });
        counts.applied++;
      } catch (error) {
        await this.fail(row, importErrorCode(error), counts);
      }
    }

    // Tariffs: proposed to whoever may set this center's prices (task 2-9 decision 2).
    for (const row of held.filter((r) => r.sheet === 'tariffs')) {
      const data = row.data as { ownerRef: string };
      const workplaceId = workplaces.get(data.ownerRef);
      if (data.ownerRef !== centerRef && !workplaceId) {
        await this.fail(row, 'doctor_not_created', counts);
        continue;
      }
      await this.db
        .update(catalogImportRows)
        .set({
          status: 'proposed',
          data: {
            ...(row.data ?? {}),
            centerId,
            ...(workplaceId ? { ownerWorkplaceId: workplaceId } : {}),
          },
        })
        .where(and(eq(catalogImportRows.id, row.id), eq(catalogImportRows.status, 'held')));
      counts.proposed++;
    }

    // Schedules: one weekly schedule per doctor, all its rows at once.
    const byDoctor = new Map<string, ImportRow[]>();
    for (const row of held.filter((r) => r.sheet === 'schedules')) {
      const ref = (row.data as { doctorRef: string }).doctorRef;
      byDoctor.set(ref, [...(byDoctor.get(ref) ?? []), row]);
    }
    for (const [doctorRef, rows] of byDoctor) {
      const workplaceId = workplaces.get(doctorRef);
      if (!workplaceId) {
        for (const row of rows) await this.fail(row, 'doctor_not_created', counts);
        continue;
      }
      try {
        await this.calendar.replaceSchedule(who.actor, who.access, workplaceId, {
          ranges: rows.map((r) => (r.data as BulkRowValue<'schedules'>).range),
          reason: REASON,
        });
        for (const row of rows) {
          await this.mark(row, { status: 'applied', entityId: workplaceId });
          counts.applied++;
        }
      } catch (error) {
        const code = importErrorCode(error);
        for (const row of rows) await this.fail(row, code, counts);
      }
    }
  }

  // --- helpers --------------------------------------------------------------------------

  /** The uploader, as they are now: a role they lost is not used on their behalf. */
  private async uploader(accountId: string): Promise<{ actor: Actor; access: EffectiveAccess }> {
    const access = await this.accessPort.resolve(accountId);
    return {
      access,
      actor: { accountId, sessionId: null, ip: null, roles: [...access.roles] },
    };
  }

  private reveal(batchId: string, row: ImportRow, field: string, secret: Secret): string {
    return this.crypto.fieldCrypto.decrypt(
      secret.enc,
      importContext(batchId, row.sheet, row.rowNumber, field),
    );
  }

  private rowsOf(batchId: string, statuses: ImportRow['status'][]) {
    return this.db
      .select()
      .from(catalogImportRows)
      .where(
        and(eq(catalogImportRows.batchId, batchId), inArray(catalogImportRows.status, statuses)),
      )
      .orderBy(asc(catalogImportRows.rowNumber));
  }

  /** Moves a row on from the status it was read in; a second writer changes nothing. */
  private async mark(
    row: ImportRow,
    set: { status: ImportRow['status']; entityId?: string; failure?: string },
  ) {
    await this.db
      .update(catalogImportRows)
      .set(set)
      .where(and(eq(catalogImportRows.id, row.id), eq(catalogImportRows.status, row.status)));
  }

  private async fail(row: ImportRow, failure: string, counts: { failed: number }) {
    this.logger.warn(`import row ${row.id} failed: ${failure}`);
    await this.mark(row, { status: 'failed', failure });
    counts.failed++;
  }
}

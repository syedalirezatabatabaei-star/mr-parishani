import { Inject, Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { searchKey, type EventEnvelope } from '@sepehr/contracts';
import { and, asc, eq, lte, sql } from 'drizzle-orm';
import type { SqlExecutor } from '../../common/audit/audit.port';
import { BOOKABLE_SLOTS, type BookableSlots } from '../../common/booking/bookable-slots.port';
import { TARIFF_BOOK, type TariffBook } from '../../common/catalog/tariff-book.port';
import {
  WORKPLACE_DIRECTORY,
  type WorkplaceDirectory,
} from '../../common/catalog/workplace-directory.port';
import { CONFIG, type ConfigPort } from '../../common/config/config.port';
import {
  EVENT_CONSUMERS,
  type EventConsumer,
  type EventConsumerRegistry,
} from '../../common/events/outbox.port';
import { DATABASE, type Database } from '../../db/database.module';
import { searchEntries, searchEntryPrices } from './catalog.schema';

type Tx = Parameters<Parameters<Database['transaction']>[0]>[0];
type Executor = Tx | Database;
type EntryRow = typeof searchEntries.$inferSelect;

const MINUTE_MS = 60_000;
/** Entries per refresher pass; the next pass takes the rest. */
const REFRESH_BATCH = 200;
/** Workplaces per rebuild transaction. */
const REBUILD_BATCH = 100;

/** A price in force at an indexed workplace. Whole rials (rule 1). */
export interface IndexedPrice {
  readonly serviceCode: string;
  readonly isVisit: boolean;
  readonly isFree: boolean;
  readonly minRial: bigint;
  readonly maxRial: bigint;
}

/** What the catalog alone says about a workplace: everything but its free time. */
export interface CatalogPart {
  readonly workplaceId: string;
  readonly doctorId: string;
  readonly centerId: string | null;
  readonly cityCode: string;
  readonly doctorName: string;
  readonly placeName: string | null;
  readonly searchKey: string;
  readonly doctorNameKey: string;
  readonly placeNameKey: string | null;
  readonly treatmentFields: { code: string; name: string }[];
  readonly treatmentFieldCodes: string[];
  readonly serviceCodes: string[];
  readonly creditEnabled: boolean;
  /** The workplace and its doctor exist, and it takes new appointments. */
  readonly listed: boolean;
  readonly prices: readonly IndexedPrice[];
}

export type RefreshOutcome = 'inserted' | 'updated' | 'unchanged' | 'missing';

export interface RebuildReport {
  readonly runId: string;
  readonly mode: 'dry_run' | 'apply';
  readonly workplaces: number;
  readonly inserted: number;
  readonly updated: number;
  readonly unchanged: number;
  readonly listed: number;
  readonly unlisted: number;
}

export const REBUILD_USAGE = 'usage: pnpm catalog:rebuild-search [-- --dry-run | -- --apply]';

/**
 * The command line of `catalog:rebuild-search`: a dry run unless `--apply` is given (task 2-7
 * decision 1). A lone `--` is skipped; anything else unknown, or both modes, is refused.
 */
export function parseRebuildArgs(args: readonly string[]): 'dry_run' | 'apply' {
  const given = args.filter((a) => a !== '--');
  const unknown = given.filter((a) => a !== '--apply' && a !== '--dry-run');
  if (unknown.length > 0 || (given.includes('--apply') && given.includes('--dry-run'))) {
    throw new Error(REBUILD_USAGE);
  }
  return given.includes('--apply') ? 'apply' : 'dry_run';
}

/** When time alone changes an entry: its free time passes, or it grows too old. */
export function refreshDueAt(nextFree: Date | null, now: Date, maxAgeMinutes: number): Date {
  const oldest = new Date(now.getTime() + maxAgeMinutes * MINUTE_MS);
  return nextFree !== null && nextFree < oldest ? nextFree : oldest;
}

const sameStrings = (a: readonly string[], b: readonly string[]) =>
  a.length === b.length && a.every((v, i) => v === b[i]);

/**
 * The public search's index (task 2-7, ADR-028): search_entries, one row per doctor's
 * workplace, and the prices in force there.
 *
 * - The catalog's own part (names, fields, services, prices, listed, credit) is written in
 *   the transaction of the event that changed it, from the catalog's tables.
 * - The free time (`next_free_slot_at`, a hint) comes from booking's BOOKABLE_SLOTS and is
 *   computed by the refresher outside any transaction: an event only marks the entry due
 *   (`pending_changes`), so a slow computation never holds an outbox transaction and a
 *   request made while one runs is never lost.
 * - Each workplace is written under its own advisory lock: two writers never interleave.
 */
@Injectable()
export class SearchIndex {
  private readonly logger = new Logger(SearchIndex.name);

  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(CONFIG) private readonly config: ConfigPort,
    @Inject(WORKPLACE_DIRECTORY) private readonly directory: WorkplaceDirectory,
    @Inject(TARIFF_BOOK) private readonly tariffs: TariffBook,
    @Inject(BOOKABLE_SLOTS) private readonly slots: BookableSlots,
  ) {}

  // --- what the catalog says ------------------------------------------------------------

  /** The catalog's part of a workplace's entry; null if there is no such workplace. */
  async catalogPart(ex: Executor, workplaceId: string, now: Date): Promise<CatalogPart | null> {
    const { rows } = await ex.execute(sql`
      SELECT w.id, w.doctor_id, w.center_id, w.city_code, w.credit_enabled,
             w.deleted_at IS NOT NULL AS workplace_removed,
             d.name AS doctor_name, d.deleted_at IS NOT NULL AS doctor_removed,
             c.name AS center_name, c.status AS center_status
      FROM doctor_workplaces w
      JOIN doctors d ON d.id = w.doctor_id
      LEFT JOIN centers c ON c.id = w.center_id
      WHERE w.id = ${workplaceId}
    `);
    const row = rows[0];
    if (!row) return null;
    const doctorId = String(row['doctor_id']);
    const centerId = (row['center_id'] as string | null) ?? null;
    const doctorName = String(row['doctor_name']);
    const placeName = (row['center_name'] as string | null) ?? null;
    const listed =
      row['workplace_removed'] !== true &&
      row['doctor_removed'] !== true &&
      (centerId === null || row['center_status'] === 'active');

    const fields = await ex.execute(sql`
      SELECT f.code, f.name FROM doctor_treatment_fields df
      JOIN treatment_fields f ON f.code = df.field_code AND f.deleted_at IS NULL
      WHERE df.doctor_id = ${doctorId} AND df.deleted_at IS NULL
      ORDER BY f.code
    `);
    const treatmentFields = fields.rows.map((f) => ({
      code: String(f['code']),
      name: String(f['name']),
    }));

    const prices: IndexedPrice[] = [];
    const serviceNames: string[] = [];
    if (listed) {
      const offerable = await this.directory.offerableServiceCodes(workplaceId, ex);
      const named =
        offerable.length === 0
          ? []
          : (
              await ex.execute(sql`
                SELECT code, name, kind FROM services
                WHERE code IN (${sql.join(
                  offerable.map((c) => sql`${c}`),
                  sql`, `,
                )})
                ORDER BY code
              `)
            ).rows;
      for (const s of named) {
        const code = String(s['code']);
        const quote = await this.tariffs.quote(workplaceId, code, now, ex);
        if (!quote) continue;
        prices.push({
          serviceCode: code,
          isVisit: s['kind'] === 'visit',
          isFree: quote.isFree,
          minRial: quote.minAmountRial,
          maxRial: quote.maxAmountRial,
        });
        serviceNames.push(String(s['name']));
      }
    }

    const text = [
      doctorName,
      placeName ?? '',
      ...treatmentFields.map((f) => f.name),
      ...serviceNames,
    ]
      .filter((t) => t !== '')
      .join(' ');
    return {
      workplaceId,
      doctorId,
      centerId,
      cityCode: String(row['city_code']),
      doctorName,
      placeName,
      searchKey: searchKey(text),
      doctorNameKey: searchKey(doctorName),
      placeNameKey: placeName === null ? null : searchKey(placeName),
      treatmentFields,
      treatmentFieldCodes: treatmentFields.map((f) => f.code),
      serviceCodes: prices.map((p) => p.serviceCode),
      creditEnabled: row['credit_enabled'] === true,
      listed,
      prices,
    };
  }

  // --- what events do -------------------------------------------------------------------

  /**
   * Writes the catalog's part of these workplaces in `tx` (an event's transaction). With
   * `slotsChanged` the free time is marked for the refresher too; a new entry always is.
   * `dueBy` brings a refresh forward to a moment known now (a price that starts later).
   */
  async syncCatalog(
    tx: Tx,
    workplaceIds: readonly string[],
    options: { readonly slotsChanged: boolean; readonly dueBy?: Date },
    now = new Date(),
  ): Promise<void> {
    // One order for every writer, so two transactions never wait on each other in a circle.
    for (const workplaceId of [...new Set(workplaceIds)].sort()) {
      await this.lock(tx, workplaceId);
      const part = await this.catalogPart(tx, workplaceId, now);
      if (!part) continue;
      const due = options.slotsChanged ? now : (options.dueBy ?? null);
      const bump = options.slotsChanged ? 1 : 0;
      const { rows } = await tx.execute(sql`
        INSERT INTO search_entries (
          workplace_id, doctor_id, center_id, city_code, doctor_name, place_name, search_key,
          doctor_name_key, place_name_key, treatment_fields, treatment_field_codes,
          service_codes, credit_enabled, listed, next_free_slot_at, refresh_due_at,
          pending_changes, refreshed_at)
        VALUES (
          ${part.workplaceId}, ${part.doctorId}, ${part.centerId}, ${part.cityCode},
          ${part.doctorName}, ${part.placeName}, ${part.searchKey}, ${part.doctorNameKey},
          ${part.placeNameKey}, ${JSON.stringify(part.treatmentFields)}::jsonb,
          ${this.textArray(part.treatmentFieldCodes)}, ${this.textArray(part.serviceCodes)},
          ${part.creditEnabled}, ${part.listed}, NULL, ${now}, 1, ${now})
        ON CONFLICT (workplace_id) DO UPDATE SET
          doctor_id = EXCLUDED.doctor_id, center_id = EXCLUDED.center_id,
          city_code = EXCLUDED.city_code, doctor_name = EXCLUDED.doctor_name,
          place_name = EXCLUDED.place_name, search_key = EXCLUDED.search_key,
          doctor_name_key = EXCLUDED.doctor_name_key, place_name_key = EXCLUDED.place_name_key,
          treatment_fields = EXCLUDED.treatment_fields,
          treatment_field_codes = EXCLUDED.treatment_field_codes,
          service_codes = EXCLUDED.service_codes, credit_enabled = EXCLUDED.credit_enabled,
          listed = EXCLUDED.listed,
          -- An unlisted workplace has no free time to show, whatever was indexed before.
          next_free_slot_at = CASE WHEN EXCLUDED.listed
            THEN search_entries.next_free_slot_at END,
          pending_changes = search_entries.pending_changes + ${bump},
          refresh_due_at = LEAST(search_entries.refresh_due_at,
            COALESCE(${due}::timestamptz, search_entries.refresh_due_at))
        RETURNING id
      `);
      const entryId = String(rows[0]?.['id']);
      await this.writePrices(tx, entryId, part.prices);
    }
  }

  /**
   * Marks these entries' free time for the refresher: a booking, a calendar or a holiday
   * changed it. Only existing entries; a workplace never indexed waits for its own event or
   * a rebuild.
   */
  async markDue(tx: SqlExecutor, where: ReturnType<typeof sql>): Promise<number> {
    const result = await tx.execute(sql`
      UPDATE search_entries
      SET pending_changes = pending_changes + 1, refresh_due_at = LEAST(refresh_due_at, now())
      WHERE ${where}
    `);
    return (result as { rowCount?: number | null }).rowCount ?? 0;
  }

  // --- the refresher --------------------------------------------------------------------

  /**
   * Refreshes the entries that are due (worker, every 15 seconds): each one's catalog part
   * and free time in full. The earliest due first; the rest wait for the next pass.
   */
  async refreshDue(now = new Date(), limit = REFRESH_BATCH): Promise<{ refreshed: number }> {
    const due = await this.db
      .select({ workplaceId: searchEntries.workplaceId })
      .from(searchEntries)
      .where(lte(searchEntries.refreshDueAt, now))
      .orderBy(asc(searchEntries.refreshDueAt))
      .limit(limit);
    let refreshed = 0;
    for (const { workplaceId } of due) {
      try {
        await this.refresh(workplaceId, now);
        refreshed++;
      } catch (error) {
        // Ids only (rule 30); the entry stays due and the next pass tries again.
        this.logger.error(
          `search refresh of workplace ${workplaceId} failed: ${error instanceof Error ? error.message : 'unknown error'}`,
        );
      }
    }
    return { refreshed };
  }

  /**
   * One workplace's entry in full. The free time is computed first, outside the transaction;
   * a request for a refresh that arrives meanwhile keeps the entry due.
   */
  async refresh(workplaceId: string, now = new Date()): Promise<RefreshOutcome> {
    const [before] = await this.db
      .select({ pending: searchEntries.pendingChanges })
      .from(searchEntries)
      .where(eq(searchEntries.workplaceId, workplaceId));
    const pendingAtStart = before?.pending ?? 0;
    const nextFree = await this.nextFree(workplaceId, now);
    const maxAge = (await this.config.resolve('catalog.search_policy')).value.maxEntryAgeMinutes;
    return this.db.transaction(async (tx) => {
      await this.lock(tx, workplaceId);
      const part = await this.catalogPart(tx, workplaceId, now);
      if (!part) {
        // No such workplace (never so in the application: workplaces are not deleted). The
        // entry is shown nowhere and waits its full age, so it never blocks the queue.
        await tx
          .update(searchEntries)
          .set({
            listed: false,
            nextFreeSlotAt: null,
            pendingChanges: 0,
            refreshDueAt: refreshDueAt(null, now, maxAge),
            refreshedAt: now,
          })
          .where(eq(searchEntries.workplaceId, workplaceId));
        return 'missing';
      }
      const [current] = await tx
        .select()
        .from(searchEntries)
        .where(eq(searchEntries.workplaceId, workplaceId))
        .for('update');
      const next = part.listed ? nextFree : null;
      // Asked again while the free time was computed: stays due for the next pass.
      const meanwhile = current ? current.pendingChanges - pendingAtStart : 0;
      return this.write(tx, part, next, current ?? null, {
        pending: meanwhile > 0 ? meanwhile : 0,
        dueAt: meanwhile > 0 ? now : refreshDueAt(next, now, maxAge),
        now,
      });
    });
  }

  // --- the rebuild ----------------------------------------------------------------------

  /**
   * `pnpm catalog:rebuild-search` (task 2-7 decision 1): every workplace ever registered,
   * compared with its entry. A dry run writes nothing but its report; an apply refreshes
   * every entry that differs. Idempotent: an apply run again finds everything unchanged
   * (unless time moved a free slot meanwhile). Every run is recorded in search_rebuild_runs.
   */
  async rebuild(mode: 'dry_run' | 'apply', now = new Date()): Promise<RebuildReport> {
    const startedAt = new Date();
    const { rows } = await this.db.execute(sql`SELECT id FROM doctor_workplaces ORDER BY id`);
    const ids = rows.map((r) => String(r['id']));
    const counts = { inserted: 0, updated: 0, unchanged: 0, listed: 0, unlisted: 0 };
    for (let i = 0; i < ids.length; i += REBUILD_BATCH) {
      for (const workplaceId of ids.slice(i, i + REBUILD_BATCH)) {
        let outcome: RefreshOutcome;
        let listed: boolean;
        if (mode === 'apply') {
          outcome = await this.refresh(workplaceId, now);
          const [entry] = await this.db
            .select({ listed: searchEntries.listed })
            .from(searchEntries)
            .where(eq(searchEntries.workplaceId, workplaceId));
          listed = entry?.listed ?? false;
        } else {
          const part = await this.catalogPart(this.db, workplaceId, now);
          if (!part) continue;
          const [current] = await this.db
            .select()
            .from(searchEntries)
            .where(eq(searchEntries.workplaceId, workplaceId));
          const next = part.listed ? await this.nextFree(workplaceId, now) : null;
          outcome = !current
            ? 'inserted'
            : (await this.differs(this.db, current, part, next))
              ? 'updated'
              : 'unchanged';
          listed = part.listed;
        }
        if (outcome === 'missing') continue;
        counts[outcome]++;
        counts[listed ? 'listed' : 'unlisted']++;
      }
    }
    const { rows: run } = await this.db.execute(sql`
      INSERT INTO search_rebuild_runs (mode, workplaces, inserted, updated, unchanged, listed,
        unlisted, started_at, finished_at)
      VALUES (${mode}, ${ids.length}, ${counts.inserted}, ${counts.updated}, ${counts.unchanged},
        ${counts.listed}, ${counts.unlisted}, ${startedAt}, ${new Date()})
      RETURNING id
    `);
    return { runId: String(run[0]?.['id']), mode, workplaces: ids.length, ...counts };
  }

  // --- helpers --------------------------------------------------------------------------

  private async nextFree(workplaceId: string, now: Date): Promise<Date | null> {
    const [first] = await this.slots.upcoming(workplaceId, { limit: 1, now });
    return first?.startsAt ?? null;
  }

  /** Serializes the writers of one workplace's entry until the transaction ends. */
  private lock(tx: Tx, workplaceId: string) {
    return tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtextextended(${`search_entry:${workplaceId}`}, 0))`,
    );
  }

  private textArray(values: readonly string[]) {
    return sql`ARRAY[${sql.join(
      values.map((v) => sql`${v}`),
      sql`, `,
    )}]::text[]`;
  }

  /** Writes the whole entry; says whether anything but the bookkeeping changed. */
  private async write(
    tx: Tx,
    part: CatalogPart,
    nextFree: Date | null,
    current: EntryRow | null,
    meta: { readonly pending: number; readonly dueAt: Date; readonly now: Date },
  ): Promise<RefreshOutcome> {
    const changed = current === null || (await this.differs(tx, current, part, nextFree));
    const values = {
      workplaceId: part.workplaceId,
      doctorId: part.doctorId,
      centerId: part.centerId,
      cityCode: part.cityCode,
      doctorName: part.doctorName,
      placeName: part.placeName,
      searchKey: part.searchKey,
      doctorNameKey: part.doctorNameKey,
      placeNameKey: part.placeNameKey,
      treatmentFields: part.treatmentFields,
      treatmentFieldCodes: part.treatmentFieldCodes,
      serviceCodes: part.serviceCodes,
      creditEnabled: part.creditEnabled,
      listed: part.listed,
      nextFreeSlotAt: nextFree,
      refreshDueAt: meta.dueAt,
      pendingChanges: meta.pending,
      refreshedAt: meta.now,
    };
    const [entry] = await tx
      .insert(searchEntries)
      .values(values)
      .onConflictDoUpdate({ target: searchEntries.workplaceId, set: values })
      .returning({ id: searchEntries.id });
    if (!entry) throw new Error('search entry upsert returned nothing');
    await this.writePrices(tx, entry.id, part.prices);
    if (current === null) return 'inserted';
    return changed ? 'updated' : 'unchanged';
  }

  /** The prices offered now; a service no longer offered keeps its row, `offered = false`. */
  private async writePrices(tx: Tx, entryId: string, prices: readonly IndexedPrice[]) {
    for (const p of prices) {
      const values = {
        entryId,
        serviceCode: p.serviceCode,
        isVisit: p.isVisit,
        offered: true,
        isFree: p.isFree,
        minAmountRial: p.minRial,
        maxAmountRial: p.maxRial,
      };
      await tx
        .insert(searchEntryPrices)
        .values(values)
        .onConflictDoUpdate({
          target: [searchEntryPrices.entryId, searchEntryPrices.serviceCode],
          set: values,
        });
    }
    await tx
      .update(searchEntryPrices)
      .set({ offered: false })
      .where(
        and(
          eq(searchEntryPrices.entryId, entryId),
          eq(searchEntryPrices.offered, true),
          prices.length === 0
            ? undefined
            : sql`${searchEntryPrices.serviceCode} <> ALL(${this.textArray(prices.map((p) => p.serviceCode))})`,
        ),
      );
  }

  /** Whether an entry says something other than this part and free time. */
  private async differs(
    ex: Executor,
    current: EntryRow,
    part: CatalogPart,
    nextFree: Date | null,
  ): Promise<boolean> {
    if (
      current.doctorId !== part.doctorId ||
      current.centerId !== part.centerId ||
      current.cityCode !== part.cityCode ||
      current.doctorName !== part.doctorName ||
      current.placeName !== part.placeName ||
      current.searchKey !== part.searchKey ||
      current.doctorNameKey !== part.doctorNameKey ||
      current.placeNameKey !== part.placeNameKey ||
      JSON.stringify(current.treatmentFields) !== JSON.stringify(part.treatmentFields) ||
      !sameStrings(current.treatmentFieldCodes, part.treatmentFieldCodes) ||
      !sameStrings(current.serviceCodes, part.serviceCodes) ||
      current.creditEnabled !== part.creditEnabled ||
      current.listed !== part.listed ||
      (current.nextFreeSlotAt?.getTime() ?? null) !== (nextFree?.getTime() ?? null)
    ) {
      return true;
    }
    const offered = await ex
      .select()
      .from(searchEntryPrices)
      .where(and(eq(searchEntryPrices.entryId, current.id), eq(searchEntryPrices.offered, true)))
      .orderBy(asc(searchEntryPrices.serviceCode));
    return (
      offered.length !== part.prices.length ||
      offered.some((o, i) => {
        const p = part.prices[i];
        return (
          !p ||
          o.serviceCode !== p.serviceCode ||
          o.isVisit !== p.isVisit ||
          o.isFree !== p.isFree ||
          o.minAmountRial !== p.minRial ||
          o.maxAmountRial !== p.maxRial
        );
      })
    );
  }
}

/**
 * The events that change what the search shows (task 2-7 decision 1), and what each does
 * to the index. Runs in the worker, in each event's transaction.
 *
 * - A center's status or name, a doctor's profile or workplaces, a price, the credit flag:
 *   the catalog part of the workplaces concerned is written now (a suspended center's
 *   doctors leave the results as this event is processed); status and profile changes
 *   also mark the free time due.
 * - An appointment taken or freed, a calendar or a holiday changed: the free time of the
 *   workplaces concerned is marked due; the refresher computes it within seconds.
 * - A field or service renamed or retired: every entry is marked due.
 */
@Injectable()
export class SearchIndexConsumer implements EventConsumer, OnModuleInit {
  readonly name = 'catalog.search_index';
  readonly eventTypes = [
    'catalog.center_submitted',
    'catalog.center_activated',
    'catalog.center_suspended',
    'catalog.center_terminated',
    'catalog.center_updated',
    'catalog.doctor_changed',
    'catalog.tariff_changed',
    'catalog.workplace_credit_changed',
    'catalog.catalog_item_changed',
    'booking.calendar_changed',
    'booking.appointment_held',
    'booking.appointment_rejected',
    'booking.appointment_expired',
    'booking.appointment_cancelled',
    'booking.appointment_rescheduled',
    'booking.appointment_no_show',
    'config.holidays_changed',
  ];

  constructor(
    @Inject(EVENT_CONSUMERS) private readonly consumers: EventConsumerRegistry,
    private readonly index: SearchIndex,
  ) {}

  onModuleInit() {
    this.consumers.register(this);
  }

  async handle(event: EventEnvelope, executor: SqlExecutor): Promise<void> {
    const tx = executor as Tx;
    const payload = event.payload as Record<string, unknown>;
    const id = (key: string) => String(payload[key]);
    switch (event.type) {
      case 'catalog.center_submitted':
      case 'catalog.center_activated':
      case 'catalog.center_suspended':
      case 'catalog.center_terminated':
      case 'catalog.center_updated':
        return this.index.syncCatalog(
          tx,
          await this.workplacesOf(tx, 'center_id', id('centerId')),
          {
            slotsChanged: event.type !== 'catalog.center_updated',
          },
        );
      case 'catalog.doctor_changed':
        return this.index.syncCatalog(
          tx,
          await this.workplacesOf(tx, 'doctor_id', id('doctorId')),
          {
            slotsChanged: true,
          },
        );
      case 'catalog.tariff_changed': {
        const workplaceId = payload['workplaceId'] as string | null;
        const ids = workplaceId
          ? [workplaceId]
          : await this.workplacesOf(tx, 'center_id', id('centerId'));
        const effectiveAt = new Date(id('effectiveAt'));
        return this.index.syncCatalog(tx, ids, {
          slotsChanged: false,
          // A price that starts later is shown from then.
          ...(effectiveAt > new Date() ? { dueBy: effectiveAt } : {}),
        });
      }
      case 'catalog.workplace_credit_changed':
        return this.index.syncCatalog(tx, [id('workplaceId')], { slotsChanged: false });
      case 'catalog.catalog_item_changed':
        await this.index.markDue(tx, sql`true`);
        return;
      case 'booking.calendar_changed':
        return this.index.syncCatalog(tx, [id('workplaceId')], { slotsChanged: true });
      case 'config.holidays_changed': {
        const cityCode = payload['cityCode'] as string | null;
        await this.index.markDue(tx, cityCode === null ? sql`true` : sql`city_code = ${cityCode}`);
        return;
      }
      default:
        // An appointment taken or freed: the doctor's time is shared by all their workplaces.
        await this.index.markDue(tx, sql`doctor_id = ${id('doctorId')}`);
    }
  }

  private async workplacesOf(tx: Tx, column: 'center_id' | 'doctor_id', value: string) {
    const { rows } = await tx.execute(
      sql`SELECT id FROM doctor_workplaces WHERE ${sql.identifier(column)} = ${value}`,
    );
    return rows.map((r) => String(r['id']));
  }
}

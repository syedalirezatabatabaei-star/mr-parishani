import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  type PermissionCode,
  type setTariffSchema,
  type tariffPricingSchema,
  VISIT_SERVICE_CODE,
  type tariffListQuerySchema,
  type tariffOwnerSchema,
  type tariffQuoteQuerySchema,
  type withdrawTariffSchema,
} from '@sepehr/contracts';
import { and, asc, eq, isNull, sql } from 'drizzle-orm';
import type { z } from 'zod';
import type { EffectiveAccess } from '../../common/auth/access.port';
import {
  AUDIT_LOG,
  type Actor,
  type AuditLog,
  type SqlExecutor,
} from '../../common/audit/audit.port';
import type { TariffBook, TariffQuote } from '../../common/catalog/tariff-book.port';
import { CONFIG, type ConfigPort } from '../../common/config/config.port';
import { OUTBOX, type OutboxPort } from '../../common/events/outbox.port';
import { DATABASE, type Database } from '../../db/database.module';
import {
  centers,
  centerTreatmentFields,
  doctors,
  doctorSecretaries,
  doctorTreatmentFields,
  doctorWorkplaces,
  services,
  tariffs,
  tariffVersions,
  treatmentFields,
} from './catalog.schema';

type Tx = Parameters<Parameters<Database['transaction']>[0]>[0];
type TariffRow = typeof tariffs.$inferSelect;
type VersionRow = typeof tariffVersions.$inferSelect;
type ServiceRow = typeof services.$inferSelect;
type OwnerInput = z.output<typeof tariffOwnerSchema>;
/**
 * `manage`: the owner's own managers (catalog.manage_tariffs). `network`: the network
 * specialist for a private practice whose doctor has no account
 * (catalog.manage_tariff_for_unaccounted_doctor, task 2-4 decision).
 */
type Via = 'manage' | 'network';
type Mode = 'read' | Via;

const READ: PermissionCode = 'catalog.read_tariffs';
const MANAGE: PermissionCode = 'catalog.manage_tariffs';
const FOR_UNACCOUNTED: PermissionCode = 'catalog.manage_tariff_for_unaccounted_doctor';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface TariffVersionView {
  readonly id: string;
  readonly status: 'offered' | 'withdrawn';
  readonly isFree: boolean;
  /** Rials as decimal strings (JSON has no bigint); null for a withdrawal. */
  readonly minAmountRial: string | null;
  readonly maxAmountRial: string | null;
  readonly effectiveAt: string;
  readonly reason: string;
  readonly cancelledAt: string | null;
  readonly createdAt: string;
}

export interface TariffView {
  readonly id: string;
  readonly serviceCode: string;
  readonly owner: { kind: 'workplace'; workplaceId: string } | { kind: 'center'; centerId: string };
  /** The version in force now, if any. */
  readonly current: TariffVersionView | null;
  /** Versions not started yet and not cancelled, earliest first. */
  readonly upcoming: TariffVersionView[];
}

/** The owner of a tariff as the caller may see or change it. */
interface Owner {
  readonly input: OwnerInput;
  readonly nodePath: string;
  readonly cityCode: string;
  /** The fields whose services this owner may price (the visit is always allowed). */
  readonly fieldCodes: readonly string[];
  /** The audit actor: «on behalf of» the doctor when someone else changes their price. */
  readonly actor: Actor;
}

const versionView = (row: VersionRow): TariffVersionView => ({
  id: row.id,
  status: row.status,
  isFree: row.isFree,
  minAmountRial: row.minAmountRial === null ? null : row.minAmountRial.toString(),
  maxAmountRial: row.maxAmountRial === null ? null : row.maxAmountRial.toString(),
  effectiveAt: row.effectiveAt.toISOString(),
  reason: row.reason,
  cancelledAt: row.cancelledAt?.toISOString() ?? null,
  createdAt: row.createdAt.toISOString(),
});

const ownerOf = (row: TariffRow): TariffView['owner'] =>
  row.ownerKind === 'workplace'
    ? { kind: 'workplace', workplaceId: row.workplaceId ?? '' }
    : { kind: 'center', centerId: row.centerId ?? '' };

/** The ltree label of a node: its id without hyphens (migration 0002). */
const labelOf = (nodeId: string) => nodeId.replaceAll('-', '');

const within = (path: string, by: string) => path === by || path.startsWith(`${by}.`);

const pgError = (error: unknown): { code?: string; constraint?: string } | undefined => {
  const e = error as { code?: string; constraint?: string; cause?: unknown } | null;
  if (e?.code) return e;
  return (e?.cause as { code?: string; constraint?: string } | undefined) ?? undefined;
};

/**
 * Tariffs (task 2-4, doc 08 §4, ADR-024): the price range of a service at one doctor's
 * workplace or at one center, as append-only versions with the moment each starts. A
 * version in force never changes, so whatever was quoted from it stays true (doc 08 §15
 * test 4); only a version not started yet may be cancelled. A workplace's own tariff
 * always wins over its center's.
 *
 * Who changes a price (task 2-4 decisions): the center manager (a center scope) for the
 * center and every workplace in it; a branch manager for the workplaces of their branch;
 * the doctor with an account for their own workplace; their secretary only with what that
 * doctor delegated. The network reads, except that the network specialist prices a private
 * practice whose doctor has no account, until the doctor gets one. What anyone but the
 * doctor does to a doctor's price is audited on the doctor's behalf.
 */
@Injectable()
export class TariffService implements TariffBook {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(AUDIT_LOG) private readonly audit: AuditLog,
    @Inject(OUTBOX) private readonly outbox: OutboxPort,
    @Inject(CONFIG) private readonly config: ConfigPort,
  ) {}

  // --- changing prices ----------------------------------------------------------------

  /** A new version from `effectiveAt` (now if omitted); the series is made on first use. */
  async set(
    actor: Actor,
    access: EffectiveAccess,
    input: z.output<typeof setTariffSchema>,
    via: Via = 'manage',
  ): Promise<TariffView> {
    this.requireVia(access, via);
    return this.db.transaction(async (tx) => {
      const owner = await this.owner(tx, actor, access, input.owner, via);
      const service = await this.priceableService(tx, input.serviceCode, owner);
      if (service.kind === 'visit') await this.refuseVisitWhenInternalOnly();
      if (input.pricing.kind === 'free' && service.kind !== 'visit') {
        throw new BadRequestException({ error: 'only_visit_can_be_free' });
      }
      const tariff = await this.seriesFor(tx, actor, owner, service);
      const before = await this.inForce(tx, tariff.id);
      const version = await this.insertVersion(tx, {
        tariffId: tariff.id,
        status: 'offered',
        isFree: input.pricing.kind === 'free',
        minAmountRial: input.pricing.kind === 'free' ? 0n : input.pricing.minRial,
        maxAmountRial: input.pricing.kind === 'free' ? 0n : input.pricing.maxRial,
        effectiveAt: input.effectiveAt,
        reason: input.reason,
        createdBy: actor.accountId,
      });
      await this.audit.record(
        {
          actor: owner.actor,
          action: 'catalog.tariff_set',
          entityType: 'tariff',
          entityId: tariff.id,
          before: before ? versionView(before) : null,
          after: { serviceCode: service.code, owner: ownerOf(tariff), ...versionView(version) },
          reason: input.reason,
        },
        tx,
      );
      await this.announce(tx, tariff, version.effectiveAt);
      return this.view(tx, tariff, service.code);
    });
  }

  /** The owner stops offering the service from `effectiveAt` (a version, like a price). */
  async withdraw(
    actor: Actor,
    access: EffectiveAccess,
    tariffId: string,
    input: z.output<typeof withdrawTariffSchema>,
    via: Via = 'manage',
  ): Promise<TariffView> {
    this.requireVia(access, via);
    return this.db.transaction(async (tx) => {
      const { tariff, owner, serviceCode } = await this.visibleTariff(
        tx,
        actor,
        access,
        tariffId,
        via,
      );
      if (serviceCode === VISIT_SERVICE_CODE) await this.refuseVisitWhenInternalOnly();
      const before = await this.inForce(tx, tariff.id);
      const version = await this.insertVersion(tx, {
        tariffId: tariff.id,
        status: 'withdrawn',
        isFree: false,
        minAmountRial: null,
        maxAmountRial: null,
        effectiveAt: input.effectiveAt,
        reason: input.reason,
        createdBy: actor.accountId,
      });
      await this.audit.record(
        {
          actor: owner.actor,
          action: 'catalog.tariff_withdrawn',
          entityType: 'tariff',
          entityId: tariff.id,
          before: before ? versionView(before) : null,
          after: { serviceCode, owner: ownerOf(tariff), ...versionView(version) },
          reason: input.reason,
        },
        tx,
      );
      await this.announce(tx, tariff, version.effectiveAt);
      return this.view(tx, tariff, serviceCode);
    });
  }

  /**
   * Cancels a version that has not started (task 2-4 decision). A started one is final and
   * is only replaced by a new version; the database refuses it as well.
   */
  async cancel(
    actor: Actor,
    access: EffectiveAccess,
    versionId: string,
    reason: string,
    via: Via = 'manage',
  ): Promise<TariffView> {
    this.requireVia(access, via);
    if (!UUID.test(versionId)) throw new NotFoundException({ error: 'tariff_version_not_found' });
    return this.db.transaction(async (tx) => {
      const [found] = await tx
        .select({ tariffId: tariffVersions.tariffId })
        .from(tariffVersions)
        .where(eq(tariffVersions.id, versionId));
      if (!found) throw new NotFoundException({ error: 'tariff_version_not_found' });
      const { tariff, owner, serviceCode } = await this.visibleTariff(
        tx,
        actor,
        access,
        found.tariffId,
        via,
      ).catch((error: unknown) => {
        throw error instanceof NotFoundException
          ? new NotFoundException({ error: 'tariff_version_not_found' })
          : error;
      });
      if (serviceCode === VISIT_SERVICE_CODE) await this.refuseVisitWhenInternalOnly();
      const [version] = await tx
        .select({
          row: tariffVersions,
          started: sql<boolean>`${tariffVersions.effectiveAt} <= now()`,
        })
        .from(tariffVersions)
        .where(eq(tariffVersions.id, versionId))
        .for('update');
      if (!version) throw new NotFoundException({ error: 'tariff_version_not_found' });
      if (version.row.cancelledAt !== null) {
        throw new ConflictException({ error: 'tariff_version_cancelled' });
      }
      if (version.started) throw new ConflictException({ error: 'tariff_version_started' });
      const [after] = await tx
        .update(tariffVersions)
        .set({ cancelledAt: sql`now()`, cancelledBy: actor.accountId, cancelReason: reason })
        .where(eq(tariffVersions.id, versionId))
        .returning();
      if (!after) throw new Error('tariff version update returned nothing');
      await this.audit.record(
        {
          actor: owner.actor,
          action: 'catalog.tariff_version_cancelled',
          entityType: 'tariff',
          entityId: tariff.id,
          before: versionView(version.row),
          after: versionView(after),
          reason,
        },
        tx,
      );
      await this.announce(tx, tariff, version.row.effectiveAt);
      return this.view(tx, tariff, serviceCode);
    });
  }

  /**
   * A visit price two people agreed on in the internal panel (owner 1405/07/29, answer i): the
   * second person's approval is the authority, so no owner's manager is asked; the version is
   * written the catalog way (append-only, never in the past) and audited on the doctor's
   * behalf. In the caller's transaction (the proposal's approval). Returns the version's id.
   */
  async setApprovedVisit(
    tx: Tx,
    actor: Actor,
    input: {
      workplaceId: string;
      pricing: z.output<typeof tariffPricingSchema>;
      effectiveAt: Date | null;
      reason: string;
    },
  ): Promise<string> {
    const [row] = await tx
      .select({ workplace: doctorWorkplaces, doctorId: doctors.id, centerStatus: centers.status })
      .from(doctorWorkplaces)
      .innerJoin(doctors, eq(doctors.id, doctorWorkplaces.doctorId))
      .leftJoin(centers, eq(centers.id, doctorWorkplaces.centerId))
      .where(
        and(
          eq(doctorWorkplaces.id, input.workplaceId),
          isNull(doctorWorkplaces.deletedAt),
          isNull(doctors.deletedAt),
        ),
      )
      .for('update', { of: doctorWorkplaces });
    if (!row) throw new NotFoundException({ error: 'workplace_not_found' });
    if (row.centerStatus === 'terminated') {
      throw new ConflictException({ error: 'center_terminated' });
    }
    const owner: Owner = {
      input: { kind: 'workplace', workplaceId: row.workplace.id },
      nodePath: row.workplace.nodePath,
      cityCode: row.workplace.cityCode,
      fieldCodes: [],
      actor: { ...actor, onBehalfOfDoctorId: row.doctorId },
    };
    const service = await this.priceableService(tx, VISIT_SERVICE_CODE, owner);
    const tariff = await this.seriesFor(tx, actor, owner, service);
    const before = await this.inForce(tx, tariff.id);
    const version = await this.insertVersion(tx, {
      tariffId: tariff.id,
      status: 'offered',
      isFree: input.pricing.kind === 'free',
      minAmountRial: input.pricing.kind === 'free' ? 0n : input.pricing.minRial,
      maxAmountRial: input.pricing.kind === 'free' ? 0n : input.pricing.maxRial,
      effectiveAt: input.effectiveAt?.toISOString(),
      reason: input.reason,
      createdBy: actor.accountId,
    });
    await this.audit.record(
      {
        actor: owner.actor,
        action: 'catalog.tariff_set',
        entityType: 'tariff',
        entityId: tariff.id,
        before: before ? versionView(before) : null,
        after: { serviceCode: service.code, owner: ownerOf(tariff), ...versionView(version) },
        reason: input.reason,
      },
      tx,
    );
    await this.announce(tx, tariff, version.effectiveAt);
    return version.id;
  }

  /**
   * Owner 1405/07/29, answer i: with `catalog.visit_tariff_internal_only` on, a visit's price
   * comes only from the internal panel by two people; every other path refuses it.
   */
  private async refuseVisitWhenInternalOnly() {
    const flag = await this.config.resolve('catalog.visit_tariff_internal_only');
    if (flag.value) throw new ForbiddenException({ error: 'visit_tariff_internal_only' });
  }

  /**
   * A price of this owner changes from `effectiveAt` (task 2-7): the public search shows it
   * then, for the workplace or every workplace of the center.
   */
  private announce(tx: Tx, tariff: TariffRow, effectiveAt: Date) {
    return this.outbox.publish(
      {
        type: 'catalog.tariff_changed',
        aggregateType: 'tariff',
        aggregateId: tariff.id,
        payload: {
          tariffId: tariff.id,
          workplaceId: tariff.workplaceId,
          centerId: tariff.centerId,
          effectiveAt: effectiveAt.toISOString(),
        },
      },
      tx,
    );
  }

  // --- reading ------------------------------------------------------------------------

  /** One owner's tariffs, each with its version in force and those to come. */
  async list(
    actor: Actor,
    access: EffectiveAccess,
    query: z.output<typeof tariffListQuerySchema>,
  ): Promise<TariffView[]> {
    this.require(access, READ);
    const input: OwnerInput =
      query.workplaceId !== undefined
        ? { kind: 'workplace', workplaceId: query.workplaceId }
        : { kind: 'center', centerId: query.centerId ?? '' };
    return this.db.transaction(async (tx) => {
      await this.owner(tx, actor, access, input, 'read');
      const rows = await tx
        .select({ tariff: tariffs, serviceCode: services.code })
        .from(tariffs)
        .innerJoin(services, eq(services.id, tariffs.serviceId))
        .where(
          input.kind === 'workplace'
            ? and(eq(tariffs.ownerKind, 'workplace'), eq(tariffs.workplaceId, input.workplaceId))
            : and(eq(tariffs.ownerKind, 'center'), eq(tariffs.centerId, input.centerId)),
        )
        .orderBy(asc(services.code));
      const views: TariffView[] = [];
      for (const row of rows) views.push(await this.view(tx, row.tariff, row.serviceCode));
      return views;
    });
  }

  /** One tariff with every version ever, cancelled ones included. */
  async get(actor: Actor, access: EffectiveAccess, tariffId: string) {
    this.require(access, READ);
    return this.db.transaction(async (tx) => {
      const { tariff, serviceCode } = await this.visibleTariff(tx, actor, access, tariffId, 'read');
      const history = await tx
        .select()
        .from(tariffVersions)
        .where(eq(tariffVersions.tariffId, tariff.id))
        .orderBy(asc(tariffVersions.effectiveAt), asc(tariffVersions.createdAt));
      return { ...(await this.view(tx, tariff, serviceCode)), history: history.map(versionView) };
    });
  }

  /** The price of a service at a workplace the caller covers, as booking would get it. */
  async quoteFor(
    actor: Actor,
    access: EffectiveAccess,
    workplaceId: string,
    query: z.output<typeof tariffQuoteQuerySchema>,
  ) {
    this.require(access, READ);
    await this.db.transaction((tx) =>
      this.owner(tx, actor, access, { kind: 'workplace', workplaceId }, 'read'),
    );
    const quote = await this.quote(
      workplaceId,
      query.serviceCode,
      query.at === undefined ? new Date() : new Date(query.at),
    );
    return quote === null ? null : this.quoteView(quote);
  }

  // --- TARIFF_BOOK ----------------------------------------------------------------------

  async quote(
    workplaceId: string,
    serviceCode: string,
    at: Date,
    tx?: SqlExecutor,
  ): Promise<TariffQuote | null> {
    if (!UUID.test(workplaceId)) return null;
    // The workplace's own tariff whenever it has a version in force (even a withdrawal),
    // else the center's: the center never overrides the workplace (task 2-4 decision).
    // A retired service or field quotes nothing.
    const { rows } = await (tx ?? this.db).execute(sql`
      SELECT v.id, v.tariff_id, v.status, v.is_free, v.min_amount_rial::text AS min_rial,
             v.max_amount_rial::text AS max_rial, v.effective_at, v.owner_kind,
             s.id AS service_id, s.code AS service_code, s.cost_kind
      FROM doctor_workplaces w
      JOIN services s ON s.code = ${serviceCode} AND s.deleted_at IS NULL
      LEFT JOIN treatment_fields f ON f.id = s.field_id
      JOIN LATERAL (
        SELECT cv.*, t.owner_kind
        FROM tariffs t
        JOIN LATERAL (
          SELECT * FROM tariff_versions tv
          WHERE tv.tariff_id = t.id AND tv.cancelled_at IS NULL AND tv.effective_at <= ${at}
          ORDER BY tv.effective_at DESC
          LIMIT 1
        ) cv ON true
        WHERE t.service_id = s.id
          AND ((t.owner_kind = 'workplace' AND t.workplace_id = w.id)
            OR (t.owner_kind = 'center' AND t.center_id = w.center_id))
        ORDER BY t.owner_kind = 'workplace' DESC
        LIMIT 1
      ) v ON true
      WHERE w.id = ${workplaceId} AND w.deleted_at IS NULL
        AND (s.field_id IS NULL OR f.deleted_at IS NULL)
    `);
    const row = rows[0];
    if (!row || row['status'] !== 'offered') return null;
    return {
      tariffVersionId: String(row['id']),
      tariffId: String(row['tariff_id']),
      source: row['owner_kind'] === 'workplace' ? 'workplace' : 'center',
      serviceId: String(row['service_id']),
      serviceCode: String(row['service_code']),
      costKind: row['cost_kind'] === 'material' ? 'material' : 'wage',
      isFree: row['is_free'] === true,
      minAmountRial: BigInt(String(row['min_rial'])),
      maxAmountRial: BigInt(String(row['max_rial'])),
      effectiveAt: new Date(row['effective_at'] as string | Date),
    };
  }

  async version(tariffVersionId: string): Promise<TariffQuote | null> {
    if (!UUID.test(tariffVersionId)) return null;
    const [row] = await this.db
      .select({ version: tariffVersions, tariff: tariffs, service: services })
      .from(tariffVersions)
      .innerJoin(tariffs, eq(tariffs.id, tariffVersions.tariffId))
      .innerJoin(services, eq(services.id, tariffs.serviceId))
      .where(eq(tariffVersions.id, tariffVersionId));
    if (!row || row.version.status !== 'offered') return null;
    return {
      tariffVersionId: row.version.id,
      tariffId: row.tariff.id,
      source: row.tariff.ownerKind,
      serviceId: row.service.id,
      serviceCode: row.service.code,
      costKind: row.service.costKind,
      isFree: row.version.isFree,
      minAmountRial: row.version.minAmountRial ?? 0n,
      maxAmountRial: row.version.maxAmountRial ?? 0n,
      effectiveAt: row.version.effectiveAt,
    };
  }

  // --- helpers ------------------------------------------------------------------------

  private require(access: EffectiveAccess, permission: PermissionCode) {
    if (!access.permissions.has(permission)) {
      throw new ForbiddenException({ error: 'permission_required', permission });
    }
  }

  private requireVia(access: EffectiveAccess, via: Via) {
    this.require(access, via === 'network' ? FOR_UNACCOUNTED : MANAGE);
  }

  private quoteView(quote: TariffQuote) {
    return {
      ...quote,
      minAmountRial: quote.minAmountRial.toString(),
      maxAmountRial: quote.maxAmountRial.toString(),
      effectiveAt: quote.effectiveAt.toISOString(),
    };
  }

  /**
   * The owner if the caller may see it (else 404, rule 13) and, for `manage`, change its
   * prices (else 403). Locks the owner row when managing, so the versions of its tariffs
   * are written one at a time.
   */
  private async owner(
    tx: Tx,
    actor: Actor,
    access: EffectiveAccess,
    input: OwnerInput,
    mode: Mode,
  ): Promise<Owner> {
    return input.kind === 'workplace'
      ? this.workplaceOwner(tx, actor, access, input, mode)
      : this.centerOwner(tx, actor, access, input, mode);
  }

  private async workplaceOwner(
    tx: Tx,
    actor: Actor,
    access: EffectiveAccess,
    input: { kind: 'workplace'; workplaceId: string },
    mode: Mode,
  ): Promise<Owner> {
    if (!UUID.test(input.workplaceId))
      throw new NotFoundException({ error: 'workplace_not_found' });
    const query = tx
      .select({ workplace: doctorWorkplaces, doctor: doctors, centerStatus: centers.status })
      .from(doctorWorkplaces)
      .innerJoin(doctors, eq(doctors.id, doctorWorkplaces.doctorId))
      .leftJoin(centers, eq(centers.id, doctorWorkplaces.centerId))
      .where(
        and(
          eq(doctorWorkplaces.id, input.workplaceId),
          isNull(doctorWorkplaces.deletedAt),
          isNull(doctors.deletedAt),
        ),
      );
    const [row] =
      mode === 'read' ? await query : await query.for('update', { of: doctorWorkplaces });
    if (!row) throw new NotFoundException({ error: 'workplace_not_found' });
    const { workplace, doctor } = row;
    const covers = access.scopes.some((scope) => {
      if (scope.kind === 'global') return true;
      if (scope.kind === 'city') return scope.code === workplace.cityCode;
      if (scope.kind === 'center' || scope.kind === 'branch' || scope.kind === 'doctor') {
        return within(workplace.nodePath, scope.path);
      }
      return false;
    });
    if (!covers) throw new NotFoundException({ error: 'workplace_not_found' });

    let ownerActor = actor;
    if (mode === 'network') {
      // Task 2-4 decision: only a private practice, only while the doctor has no account
      // (then the doctor decides), and only the network of that city.
      if (workplace.centerId !== null) {
        throw new ForbiddenException({ error: 'private_practice_only' });
      }
      if (doctor.accountId !== null) throw new ConflictException({ error: 'doctor_has_account' });
      const network = access.scopes.some(
        (scope) =>
          scope.kind === 'global' || (scope.kind === 'city' && scope.code === workplace.cityCode),
      );
      if (!network) throw new ForbiddenException({ error: 'network_only' });
      ownerActor = { ...actor, onBehalfOfDoctorId: doctor.id };
    } else if (mode === 'manage') {
      if (row.centerStatus === 'terminated') {
        throw new ConflictException({ error: 'center_terminated' });
      }
      const isDoctor = doctor.accountId !== null && doctor.accountId === actor.accountId;
      if (!isDoctor) {
        // The center manager, or a branch manager for the workplaces of their branch.
        const manager = access.scopes.some(
          (scope) =>
            (scope.kind === 'center' || scope.kind === 'branch') &&
            within(workplace.nodePath, scope.path),
        );
        if (!manager) await this.requireDelegatedSecretary(tx, actor, doctor, workplace.id);
        ownerActor = { ...actor, onBehalfOfDoctorId: doctor.id };
      }
    }
    const fields = await tx
      .select({ code: doctorTreatmentFields.fieldCode })
      .from(doctorTreatmentFields)
      .where(
        and(eq(doctorTreatmentFields.doctorId, doctor.id), isNull(doctorTreatmentFields.deletedAt)),
      );
    return {
      input,
      nodePath: workplace.nodePath,
      cityCode: workplace.cityCode,
      fieldCodes: fields.map((f) => f.code),
      actor: ownerActor,
    };
  }

  /**
   * Anyone else changing a doctor's price must be that workplace's own secretary, whose
   * doctor has an account and so delegated the permission themselves (task 2-4 decision:
   * never from the center manager's delegation for a doctor without one).
   */
  private async requireDelegatedSecretary(
    tx: Tx,
    actor: Actor,
    doctor: typeof doctors.$inferSelect,
    workplaceId: string,
  ) {
    if (actor.accountId === null) throw new ForbiddenException({ error: 'tariff_managers_only' });
    const [secretary] = await tx
      .select({ id: doctorSecretaries.id })
      .from(doctorSecretaries)
      .where(
        and(
          eq(doctorSecretaries.workplaceId, workplaceId),
          eq(doctorSecretaries.accountId, actor.accountId),
          isNull(doctorSecretaries.deletedAt),
        ),
      );
    if (!secretary) throw new ForbiddenException({ error: 'tariff_managers_only' });
    if (doctor.accountId === null) {
      throw new ForbiddenException({ error: 'doctor_delegation_required' });
    }
  }

  private async centerOwner(
    tx: Tx,
    actor: Actor,
    access: EffectiveAccess,
    input: { kind: 'center'; centerId: string },
    mode: Mode,
  ): Promise<Owner> {
    if (!UUID.test(input.centerId)) throw new NotFoundException({ error: 'center_not_found' });
    const query = tx
      .select()
      .from(centers)
      .where(and(eq(centers.id, input.centerId), isNull(centers.deletedAt)));
    const [center] = mode === 'read' ? await query : await query.for('update');
    if (!center) throw new NotFoundException({ error: 'center_not_found' });
    const path = labelOf(center.nodeId);
    // The network by city, the center's own manager, a branch manager of it. A doctor
    // reads the price their workplace falls back to through the quote, not here.
    const covers = access.scopes.some((scope) => {
      if (scope.kind === 'global') return true;
      if (scope.kind === 'city') return scope.code === center.cityCode;
      if (scope.kind === 'center' || scope.kind === 'branch') return within(scope.path, path);
      return false;
    });
    if (!covers) throw new NotFoundException({ error: 'center_not_found' });
    if (mode === 'network') throw new ForbiddenException({ error: 'private_practice_only' });
    if (mode === 'manage') {
      // A center's own tariff: its center manager only, never a branch manager.
      const manager = access.scopes.some((scope) => scope.kind === 'center' && scope.path === path);
      if (!manager) throw new ForbiddenException({ error: 'tariff_managers_only' });
      if (center.status === 'terminated') {
        throw new ConflictException({ error: 'center_terminated' });
      }
    }
    const fields = await tx
      .select({ code: centerTreatmentFields.fieldCode })
      .from(centerTreatmentFields)
      .where(
        and(eq(centerTreatmentFields.centerId, center.id), isNull(centerTreatmentFields.deletedAt)),
      );
    return {
      input,
      nodePath: path,
      cityCode: center.cityCode,
      fieldCodes: fields.map((f) => f.code),
      actor,
    };
  }

  /** A tariff by id with its owner as the caller may see or change it; otherwise 404. */
  private async visibleTariff(
    tx: Tx,
    actor: Actor,
    access: EffectiveAccess,
    tariffId: string,
    mode: Mode,
  ): Promise<{ tariff: TariffRow; owner: Owner; serviceCode: string }> {
    if (!UUID.test(tariffId)) throw new NotFoundException({ error: 'tariff_not_found' });
    const [row] = await tx
      .select({ tariff: tariffs, serviceCode: services.code })
      .from(tariffs)
      .innerJoin(services, eq(services.id, tariffs.serviceId))
      .where(eq(tariffs.id, tariffId));
    if (!row) throw new NotFoundException({ error: 'tariff_not_found' });
    const owner = await this.owner(tx, actor, access, ownerOf(row.tariff), mode).catch(
      (error: unknown) => {
        throw error instanceof NotFoundException
          ? new NotFoundException({ error: 'tariff_not_found' })
          : error;
      },
    );
    return { tariff: row.tariff, owner, serviceCode: row.serviceCode };
  }

  /**
   * A service this owner may price: active, in an active field, and in one of the owner's
   * fields; the visit anywhere. Centers and doctors never add services (task 2-4
   * decision): a missing one is asked of the network.
   */
  private async priceableService(tx: Tx, code: string, owner: Owner): Promise<ServiceRow> {
    const [row] = await tx
      .select({
        service: services,
        fieldCode: treatmentFields.code,
        fieldGone: treatmentFields.deletedAt,
      })
      .from(services)
      .leftJoin(treatmentFields, eq(treatmentFields.id, services.fieldId))
      .where(and(eq(services.code, code), isNull(services.deletedAt)))
      .for('share', { of: services });
    if (!row || row.fieldGone) throw new NotFoundException({ error: 'service_not_found' });
    if (row.service.kind !== 'visit' && !owner.fieldCodes.includes(row.fieldCode ?? '')) {
      throw new ConflictException({ error: 'service_outside_fields', fieldCode: row.fieldCode });
    }
    return row.service;
  }

  /** The owner's series for the service, made on first use. The owner row is locked. */
  private async seriesFor(
    tx: Tx,
    actor: Actor,
    owner: Owner,
    service: ServiceRow,
  ): Promise<TariffRow> {
    const ownerCondition =
      owner.input.kind === 'workplace'
        ? and(eq(tariffs.ownerKind, 'workplace'), eq(tariffs.workplaceId, owner.input.workplaceId))
        : and(eq(tariffs.ownerKind, 'center'), eq(tariffs.centerId, owner.input.centerId));
    const [existing] = await tx
      .select()
      .from(tariffs)
      .where(and(ownerCondition, eq(tariffs.serviceId, service.id)));
    if (existing) return existing;
    const [row] = await tx
      .insert(tariffs)
      .values({
        serviceId: service.id,
        ownerKind: owner.input.kind,
        workplaceId: owner.input.kind === 'workplace' ? owner.input.workplaceId : null,
        centerId: owner.input.kind === 'center' ? owner.input.centerId : null,
        nodePath: owner.nodePath,
        cityCode: owner.cityCode,
        createdBy: actor.accountId,
      })
      .returning();
    if (!row) throw new Error('tariff insert returned nothing');
    return row;
  }

  private async insertVersion(
    tx: Tx,
    values: Omit<typeof tariffVersions.$inferInsert, 'effectiveAt'> & {
      effectiveAt: string | undefined;
    },
  ): Promise<VersionRow> {
    try {
      const [row] = await tx
        .insert(tariffVersions)
        .values({
          ...values,
          effectiveAt: values.effectiveAt === undefined ? sql`now()` : new Date(values.effectiveAt),
        })
        .returning();
      if (!row) throw new Error('tariff version insert returned nothing');
      return row;
    } catch (error) {
      const pg = pgError(error);
      if (pg?.code === '23505' && pg.constraint === 'tariff_versions_effective_key') {
        throw new ConflictException({ error: 'tariff_version_exists_at_that_time' });
      }
      // The trigger: a start in the past (nothing else reaches it past the checks above).
      if (pg?.code === '23514') throw new BadRequestException({ error: 'effective_in_past' });
      throw error;
    }
  }

  /** The version in force now, whatever its status. */
  private async inForce(tx: Tx, tariffId: string): Promise<VersionRow | null> {
    const [row] = await tx
      .select()
      .from(tariffVersions)
      .where(
        and(
          eq(tariffVersions.tariffId, tariffId),
          isNull(tariffVersions.cancelledAt),
          sql`${tariffVersions.effectiveAt} <= now()`,
        ),
      )
      .orderBy(sql`${tariffVersions.effectiveAt} DESC`)
      .limit(1);
    return row ?? null;
  }

  private async view(tx: Tx, tariff: TariffRow, serviceCode: string): Promise<TariffView> {
    const current = await this.inForce(tx, tariff.id);
    const upcoming = await tx
      .select()
      .from(tariffVersions)
      .where(
        and(
          eq(tariffVersions.tariffId, tariff.id),
          isNull(tariffVersions.cancelledAt),
          sql`${tariffVersions.effectiveAt} > now()`,
        ),
      )
      .orderBy(asc(tariffVersions.effectiveAt));
    return {
      id: tariff.id,
      serviceCode,
      owner: ownerOf(tariff),
      current: current ? versionView(current) : null,
      upcoming: upcoming.map(versionView),
    };
  }
}

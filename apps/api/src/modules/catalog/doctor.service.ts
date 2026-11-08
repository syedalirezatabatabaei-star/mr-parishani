import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  type addWorkplaceSchema,
  type createDoctorSchema,
  type createSecretarySchema,
  type delegateSecretarySchema,
  type linkDoctorAccountSchema,
  type PermissionCode,
  type setWorkplaceCreditSchema,
  type updateDoctorSchema,
  type workplaceSchema,
  type ScopedWorkplace,
} from '@sepehr/contracts';
import { and, asc, eq, inArray, isNull, like, or, sql, type SQL } from 'drizzle-orm';
import type { z } from 'zod';
import type { EffectiveAccess, ResolvedScope } from '../../common/auth/access.port';
import { ORG_TREE, type OrgTreePort } from '../../common/auth/org-tree.port';
import { AUDIT_LOG, type Actor, type AuditLog } from '../../common/audit/audit.port';
import { OUTBOX, type OutboxPort } from '../../common/events/outbox.port';
import { CONFIG, type ConfigPort } from '../../common/config/config.port';
import { DATABASE, type Database } from '../../db/database.module';
import { lastFour } from '../../security/blind-index';
import { CATALOG_CRYPTO, type CatalogCrypto, DOCTOR_NATIONAL_ID } from './catalog.crypto';
import { requireActiveFieldCodes } from './field-codes';
import {
  branches,
  centers,
  doctors,
  doctorSecretaries,
  doctorTreatmentFields,
  doctorWorkplaces,
} from './catalog.schema';

type Tx = Parameters<Parameters<Database['transaction']>[0]>[0];
type DoctorRow = typeof doctors.$inferSelect;
type WorkplaceRow = typeof doctorWorkplaces.$inferSelect;
type SecretaryRow = typeof doctorSecretaries.$inferSelect;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface DoctorView {
  readonly id: string;
  readonly name: string;
  /** Public: shown on the profile (doc 08 §10). */
  readonly medicalCouncilNumber: string;
  /** Only the last four digits ever leave the service (rule 27). */
  readonly nationalIdLast4: string | null;
  readonly hasAccount: boolean;
}

export interface WorkplaceView {
  readonly id: string;
  readonly nodeId: string;
  /** Both null for a private practice. */
  readonly centerId: string | null;
  readonly branchId: string | null;
  readonly cityCode: string;
  /** Takes Sepehr credit (task 2-7 decision 2). */
  readonly creditEnabled: boolean;
}

export interface SecretaryView {
  readonly id: string;
  readonly workplaceId: string;
  readonly nodeId: string;
  readonly name: string;
}

const doctorView = (row: DoctorRow): DoctorView => ({
  id: row.id,
  name: row.name,
  medicalCouncilNumber: row.medicalCouncilNumber,
  nationalIdLast4: row.nationalIdLast4,
  hasAccount: row.accountId !== null,
});

const workplaceView = (row: WorkplaceRow): WorkplaceView => ({
  id: row.id,
  nodeId: row.nodeId,
  centerId: row.centerId,
  branchId: row.branchId,
  cityCode: row.cityCode,
  creditEnabled: row.creditEnabled,
});

const secretaryView = (row: SecretaryRow): SecretaryView => ({
  id: row.id,
  workplaceId: row.workplaceId,
  nodeId: row.nodeId,
  name: row.name,
});

/** The ltree label of a node: its id without hyphens (migration 0002). */
const labelOf = (nodeId: string) => nodeId.replaceAll('-', '');

const within = (path: string, by: string) => path === by || path.startsWith(`${by}.`);

const pgError = (error: unknown): { code?: string; constraint?: string } | undefined => {
  const e = error as { code?: string; constraint?: string; cause?: unknown } | null;
  if (e?.code) return e;
  return (e?.cause as { code?: string; constraint?: string } | undefined) ?? undefined;
};

/**
 * Doctors, their workplaces and secretaries (task 2-3, doc 08 §2, ADR-023). A doctor has
 * one provider profile, with or without an account, and one node on org_nodes per
 * workplace. Who sees a doctor is decided by the workplaces: the network by city, a center
 * or branch manager for what is under them, the doctor (and their secretary) for their own
 * node; anyone else gets 404 (rule 13). Whatever a secretary or a center manager does for
 * a doctor is recorded as done on that doctor's behalf.
 */
@Injectable()
export class DoctorService {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(ORG_TREE) private readonly tree: OrgTreePort,
    @Inject(AUDIT_LOG) private readonly audit: AuditLog,
    @Inject(CATALOG_CRYPTO) private readonly crypto: CatalogCrypto,
    @Inject(OUTBOX) private readonly outbox: OutboxPort,
    @Inject(CONFIG) private readonly config: ConfigPort,
  ) {}

  // --- registration -------------------------------------------------------------------

  /**
   * A new doctor with their first workplace: the network anywhere in its city, a center or
   * branch manager at their own branch. A private practice is registered by the network.
   */
  async register(
    actor: Actor,
    access: EffectiveAccess,
    input: z.output<typeof createDoctorSchema>,
  ): Promise<DoctorView> {
    this.require(access, 'catalog.manage_doctors');
    return this.db.transaction(async (tx) => {
      const place = await this.placeFor(tx, access, input.workplace);
      if (input.nationalId !== undefined) await this.nationalIdFree(tx, input.nationalId, null);
      const [row] = await this.uniqueWrite(() =>
        tx
          .insert(doctors)
          .values({
            name: input.name,
            medicalCouncilNumber: input.medicalCouncilNumber,
            ...(input.nationalId === undefined ? {} : this.encryptNationalId(input.nationalId)),
            createdBy: actor.accountId,
          })
          .returning(),
      );
      if (!row) throw new Error('doctor insert returned nothing');
      const workplace = await this.insertWorkplace(tx, actor, access, row, place, input.reason);
      if (input.treatmentFieldCodes) await this.setFields(tx, row.id, input.treatmentFieldCodes);
      // Owner 1405/07/27 (ADR-046): the contract term at this workplace, proposed with the
      // doctor; in force once a second person approves it in the settlement rates.
      if (input.contractTerm) {
        await this.config.proposeForRecord(
          actor,
          {
            key: 'settlement.provider_contract',
            scope: { level: 'doctor', ref: workplace.nodeId },
            value: input.contractTerm,
            reason: `مدت قرارداد پزشک «${input.name}»، با ثبت پزشک`,
          },
          tx,
        );
      }
      await this.audit.record(
        {
          actor,
          action: 'catalog.doctor_registered',
          entityType: 'doctor',
          entityId: row.id,
          after: {
            ...doctorView(row),
            workplace: workplaceView(workplace),
            treatmentFieldCodes: input.treatmentFieldCodes ?? [],
          },
          reason: input.reason,
        },
        tx,
      );
      await this.announce(tx, row.id);
      return doctorView(row);
    });
  }

  /** Another workplace of a known doctor: the network only, covering both. */
  async addWorkplace(
    actor: Actor,
    access: EffectiveAccess,
    id: string,
    input: z.output<typeof addWorkplaceSchema>,
  ): Promise<WorkplaceView> {
    this.require(access, 'catalog.manage_doctors');
    return this.db.transaction(async (tx) => {
      const { doctor, workplaces } = await this.visibleDoctor(tx, access, id, true);
      if (!this.coveredByNetwork(access, workplaces)) {
        throw new ForbiddenException({ error: 'network_only' });
      }
      const place = await this.placeFor(tx, access, input.workplace, true);
      const workplace = await this.insertWorkplace(tx, actor, access, doctor, place, input.reason);
      await this.audit.record(
        {
          actor,
          action: 'catalog.doctor_workplace_added',
          entityType: 'doctor',
          entityId: doctor.id,
          after: workplaceView(workplace),
          reason: input.reason,
        },
        tx,
      );
      await this.announce(tx, doctor.id);
      return workplaceView(workplace);
    });
  }

  /**
   * Links a doctor who had no account to an existing center-kind account: the network
   * only. Every workplace node gets the account and the doctor role on that node.
   */
  async linkAccount(
    actor: Actor,
    access: EffectiveAccess,
    id: string,
    input: z.output<typeof linkDoctorAccountSchema>,
  ): Promise<DoctorView> {
    this.require(access, 'catalog.manage_doctors');
    return this.db.transaction(async (tx) => {
      const { doctor, workplaces } = await this.visibleDoctor(tx, access, id, true);
      if (!this.coveredByNetwork(access, workplaces)) {
        throw new ForbiddenException({ error: 'network_only' });
      }
      if (doctor.accountId !== null) throw new ConflictException({ error: 'doctor_has_account' });
      const [after] = await this.uniqueWrite(() =>
        tx
          .update(doctors)
          .set({ accountId: input.accountId })
          .where(eq(doctors.id, doctor.id))
          .returning(),
      );
      for (const workplace of workplaces) {
        await this.tree.attachDoctorAccount(
          actor,
          workplace.nodeId,
          input.accountId,
          input.reason,
          tx,
        );
      }
      await this.audit.record(
        {
          actor,
          action: 'catalog.doctor_account_linked',
          entityType: 'doctor',
          entityId: doctor.id,
          before: { accountId: null },
          after: { accountId: input.accountId },
          reason: input.reason,
        },
        tx,
      );
      if (!after) throw new Error('doctor update returned nothing');
      return doctorView(after);
    });
  }

  // --- reading ------------------------------------------------------------------------

  async list(access: EffectiveAccess): Promise<DoctorView[]> {
    this.require(access, 'catalog.read_doctors');
    const scope = this.scopeFilter(access);
    if (scope === null) return [];
    const ids = await this.db
      .selectDistinct({ doctorId: doctorWorkplaces.doctorId })
      .from(doctorWorkplaces)
      .where(and(isNull(doctorWorkplaces.deletedAt), ...(scope === true ? [] : [scope])));
    if (ids.length === 0) return [];
    const rows = await this.db
      .select()
      .from(doctors)
      .where(
        and(
          inArray(
            doctors.id,
            ids.map((r) => r.doctorId),
          ),
          isNull(doctors.deletedAt),
        ),
      )
      .orderBy(asc(doctors.createdAt));
    return rows.map(doctorView);
  }

  /**
   * The workplaces the caller covers, with the doctor's, center's and branch's names
   * (task 2-11: the center panel chooses one). Not an audited view: names only, no person.
   */
  async workplacesInScope(access: EffectiveAccess): Promise<ScopedWorkplace[]> {
    const scope = this.scopeFilter(access);
    if (scope === null) return [];
    const rows = await this.db
      .select({
        workplaceId: doctorWorkplaces.id,
        doctorId: doctors.id,
        doctorName: doctors.name,
        centerId: doctorWorkplaces.centerId,
        placeName: centers.name,
        branchId: doctorWorkplaces.branchId,
        branchName: branches.name,
        cityCode: doctorWorkplaces.cityCode,
      })
      .from(doctorWorkplaces)
      .innerJoin(doctors, eq(doctors.id, doctorWorkplaces.doctorId))
      .leftJoin(centers, eq(centers.id, doctorWorkplaces.centerId))
      .leftJoin(branches, eq(branches.id, doctorWorkplaces.branchId))
      .where(
        and(
          isNull(doctorWorkplaces.deletedAt),
          isNull(doctors.deletedAt),
          ...(scope === true ? [] : [scope]),
        ),
      )
      .orderBy(asc(doctors.name), asc(doctorWorkplaces.createdAt));
    return rows.map((r) => ({
      workplaceId: r.workplaceId,
      doctor: { id: r.doctorId, name: r.doctorName },
      centerId: r.centerId,
      placeName: r.placeName,
      branchId: r.branchId,
      branchName: r.branchName,
      cityCode: r.cityCode,
    }));
  }

  /**
   * One doctor with every workplace (public anyway on the profile, doc 08 §10), and the
   * secretaries of the workplaces the caller covers.
   */
  async get(actor: Actor, access: EffectiveAccess, id: string) {
    this.require(access, 'catalog.read_doctors');
    const { doctor, workplaces } = await this.db.transaction((tx) =>
      this.visibleDoctor(tx, access, id),
    );
    const covered = workplaces.filter((w) => this.coversWorkplace(access, w));
    const [fields, secretaries] = await Promise.all([
      this.db
        .select({ code: doctorTreatmentFields.fieldCode })
        .from(doctorTreatmentFields)
        .where(
          and(eq(doctorTreatmentFields.doctorId, id), isNull(doctorTreatmentFields.deletedAt)),
        ),
      covered.length === 0
        ? Promise.resolve([])
        : this.db
            .select()
            .from(doctorSecretaries)
            .where(
              and(
                inArray(
                  doctorSecretaries.workplaceId,
                  covered.map((w) => w.id),
                ),
                isNull(doctorSecretaries.deletedAt),
              ),
            )
            .orderBy(asc(doctorSecretaries.createdAt)),
    ]);
    await this.audit.recordView(actor, 'doctor', id);
    return {
      ...doctorView(doctor),
      treatmentFieldCodes: fields.map((f) => f.code).sort(),
      workplaces: workplaces.map(workplaceView),
      secretaries: secretaries.map(secretaryView),
    };
  }

  // --- the profile --------------------------------------------------------------------

  /**
   * The name and fields: whoever manages every workplace of the doctor (the doctor, their
   * secretary, their only center's manager) or the network. The council number and the
   * national ID: the network only.
   */
  async update(
    actor: Actor,
    access: EffectiveAccess,
    id: string,
    input: z.output<typeof updateDoctorSchema>,
  ): Promise<DoctorView> {
    this.require(access, 'catalog.manage_doctors');
    return this.db.transaction(async (tx) => {
      const { doctor, workplaces } = await this.visibleDoctor(tx, access, id, true);
      const network = this.coveredByNetwork(access, workplaces);
      const identity = input.medicalCouncilNumber !== undefined || input.nationalId !== undefined;
      if (identity && !network) throw new ForbiddenException({ error: 'network_only' });
      if (!network && !workplaces.every((w) => this.coversWorkplace(access, w))) {
        throw new ForbiddenException({ error: 'other_workplaces' });
      }

      const set: Partial<typeof doctors.$inferInsert> = {};
      if (input.name !== undefined) set.name = input.name;
      if (input.medicalCouncilNumber !== undefined) {
        set.medicalCouncilNumber = input.medicalCouncilNumber;
      }
      if (input.nationalId !== undefined) {
        await this.nationalIdFree(tx, input.nationalId, id);
        Object.assign(set, this.encryptNationalId(input.nationalId));
      }
      let after = doctor;
      if (Object.keys(set).length > 0) {
        const [row] = await this.uniqueWrite(() =>
          tx.update(doctors).set(set).where(eq(doctors.id, id)).returning(),
        );
        if (!row) throw new Error('doctor update returned nothing');
        after = row;
      }
      if (input.treatmentFieldCodes !== undefined) {
        await this.setFields(tx, id, input.treatmentFieldCodes);
      }
      await this.audit.record(
        {
          actor: this.actingFor(actor, access, doctor, workplaces),
          action: 'catalog.doctor_updated',
          entityType: 'doctor',
          entityId: id,
          before: doctorView(doctor),
          after: { ...doctorView(after), treatmentFieldCodes: input.treatmentFieldCodes },
          reason: input.reason,
        },
        tx,
      );
      await this.announce(tx, id);
      return doctorView(after);
    });
  }

  // --- credit ---------------------------------------------------------------------------

  /**
   * Whether this workplace takes Sepehr credit (task 2-7 decision 2): the network specialist
   * for a workplace of their city (a global scope anywhere); audited; the public search
   * filters on it. TODO(decision): the level it belongs at, and whether the contract module
   * derives it later.
   */
  async setCredit(
    actor: Actor,
    access: EffectiveAccess,
    workplaceId: string,
    input: z.output<typeof setWorkplaceCreditSchema>,
  ): Promise<WorkplaceView> {
    this.require(access, 'catalog.manage_workplace_credit');
    return this.db.transaction(async (tx) => {
      const { workplace } = await this.visibleWorkplace(tx, access, workplaceId);
      if (!this.coveredByNetwork(access, [workplace])) {
        throw new ForbiddenException({ error: 'network_only' });
      }
      const [locked] = await tx
        .select()
        .from(doctorWorkplaces)
        .where(eq(doctorWorkplaces.id, workplace.id))
        .for('update');
      if (!locked) throw new NotFoundException({ error: 'workplace_not_found' });
      if (locked.creditEnabled === input.enabled) return workplaceView(locked);
      const [after] = await tx
        .update(doctorWorkplaces)
        .set({ creditEnabled: input.enabled })
        .where(eq(doctorWorkplaces.id, locked.id))
        .returning();
      if (!after) throw new Error('workplace update returned nothing');
      await this.audit.record(
        {
          actor,
          action: 'catalog.workplace_credit_changed',
          entityType: 'doctor_workplace',
          entityId: after.id,
          before: { creditEnabled: locked.creditEnabled },
          after: { creditEnabled: after.creditEnabled },
          reason: input.reason,
        },
        tx,
      );
      await this.outbox.publish(
        {
          type: 'catalog.workplace_credit_changed',
          aggregateType: 'doctor_workplace',
          aggregateId: after.id,
          payload: { workplaceId: after.id, creditEnabled: after.creditEnabled },
        },
        tx,
      );
      return workplaceView(after);
    });
  }

  /**
   * For the public profile (task 2-8): the doctor, if `access` may edit their profile — the
   * same people as update(): the network (a global or city scope over a workplace), or
   * whoever manages every workplace of the doctor. Otherwise 404 (not visible) or 403.
   * `auditActor` records «on behalf of» the doctor as update() does.
   */
  async profileEditor(
    tx: Tx,
    actor: Actor,
    access: EffectiveAccess,
    doctorId: string,
  ): Promise<{ doctor: DoctorRow; network: boolean; auditActor: Actor }> {
    const { doctor, workplaces } = await this.visibleDoctor(tx, access, doctorId, true);
    const network = this.coveredByNetwork(access, workplaces);
    if (!network && !workplaces.every((w) => this.coversWorkplace(access, w))) {
      throw new ForbiddenException({ error: 'other_workplaces' });
    }
    return { doctor, network, auditActor: this.actingFor(actor, access, doctor, workplaces) };
  }

  /** Whether the network (a global or city scope) covers one of the doctor's workplaces. */
  async networkCovers(tx: Tx, access: EffectiveAccess, doctorId: string): Promise<boolean> {
    const { workplaces } = await this.visibleDoctor(tx, access, doctorId);
    return this.coveredByNetwork(access, workplaces);
  }

  /** The doctor's profile or workplaces changed: the public search re-indexes them (2-7). */
  private announce(tx: Tx, doctorId: string) {
    return this.outbox.publish(
      {
        type: 'catalog.doctor_changed',
        aggregateType: 'doctor',
        aggregateId: doctorId,
        payload: { doctorId },
      },
      tx,
    );
  }

  // --- secretaries --------------------------------------------------------------------

  /**
   * A secretary of one doctor at one workplace (task 2-3 decision), operating an existing
   * center-kind account: added by the doctor, their center or branch manager, or the
   * network. What the secretary may do is a separate step (delegate).
   */
  async createSecretary(
    actor: Actor,
    access: EffectiveAccess,
    input: z.output<typeof createSecretarySchema>,
  ): Promise<SecretaryView> {
    this.require(access, 'catalog.manage_doctors');
    return this.db.transaction(async (tx) => {
      const { doctor, workplace } = await this.visibleWorkplace(tx, access, input.workplaceId);
      this.requireOverSecretaries(actor, access, doctor, workplace);
      const node = await this.tree.createNode(
        actor,
        access,
        {
          kind: 'secretary',
          parentId: workplace.nodeId,
          name: input.name,
          cityCode: null,
          accountId: input.accountId,
          reason: input.reason,
        },
        tx,
      );
      const [row] = await tx
        .insert(doctorSecretaries)
        .values({
          workplaceId: workplace.id,
          nodeId: node.id,
          accountId: input.accountId,
          name: input.name,
          createdBy: actor.accountId,
        })
        .returning();
      if (!row) throw new Error('secretary insert returned nothing');
      await this.audit.record(
        {
          actor: this.actingFor(actor, access, doctor, [workplace]),
          action: 'catalog.doctor_secretary_added',
          entityType: 'doctor',
          entityId: doctor.id,
          after: secretaryView(row),
          reason: input.reason,
        },
        tx,
      );
      return secretaryView(row);
    });
  }

  /**
   * What the secretary of a doctor without an account may do (task 2-3 decision): decided
   * by the center or branch manager (or the network, e.g. for a private practice), never
   * more than the doctor role nor than they hold, and recorded on the doctor's behalf. A
   * doctor with an account decides alone, through the access API.
   */
  async delegate(
    actor: Actor,
    access: EffectiveAccess,
    secretaryId: string,
    input: z.output<typeof delegateSecretarySchema>,
  ): Promise<{ id: string }> {
    this.require(access, 'catalog.manage_doctors');
    if (!UUID.test(secretaryId)) throw new NotFoundException({ error: 'secretary_not_found' });
    return this.db.transaction(async (tx) => {
      const [secretary] = await tx
        .select()
        .from(doctorSecretaries)
        .where(and(eq(doctorSecretaries.id, secretaryId), isNull(doctorSecretaries.deletedAt)));
      if (!secretary) throw new NotFoundException({ error: 'secretary_not_found' });
      const { doctor, workplace } = await this.visibleWorkplace(
        tx,
        access,
        secretary.workplaceId,
      ).catch((error: unknown) => {
        throw error instanceof NotFoundException
          ? new NotFoundException({ error: 'secretary_not_found' })
          : error;
      });
      if (doctor.accountId !== null) throw new ConflictException({ error: 'doctor_decides' });
      if (!this.managesAbove(access, workplace)) {
        throw new ForbiddenException({ error: 'center_manager_or_network_only' });
      }
      return this.tree.assignSecretaryRoleForDoctor(
        { ...actor, onBehalfOfDoctorId: doctor.id },
        access,
        secretary.nodeId,
        input,
        tx,
      );
    });
  }

  // --- helpers ------------------------------------------------------------------------

  private require(access: EffectiveAccess, permission: PermissionCode) {
    if (!access.permissions.has(permission)) {
      throw new ForbiddenException({ error: 'permission_required', permission });
    }
  }

  private coversWorkplace(access: EffectiveAccess, workplace: WorkplaceRow): boolean {
    return access.scopes.some((scope) => this.scopeCovers(scope, workplace));
  }

  private scopeCovers(scope: ResolvedScope, workplace: WorkplaceRow): boolean {
    if (scope.kind === 'global') return true;
    if (scope.kind === 'city') return scope.code === workplace.cityCode;
    if (scope.kind === 'center' || scope.kind === 'branch' || scope.kind === 'doctor') {
      return within(workplace.nodePath, scope.path);
    }
    return false;
  }

  /** Whether the network (a global or city scope) covers any of these workplaces. */
  private coveredByNetwork(access: EffectiveAccess, workplaces: readonly WorkplaceRow[]) {
    return workplaces.some((w) =>
      access.scopes.some(
        (scope) => scope.kind === 'global' || (scope.kind === 'city' && scope.code === w.cityCode),
      ),
    );
  }

  /** A scope above the doctor's own node: the network, or the center or branch manager. */
  private managesAbove(access: EffectiveAccess, workplace: WorkplaceRow): boolean {
    return access.scopes.some(
      (scope) =>
        scope.kind === 'global' ||
        (scope.kind === 'city' && scope.code === workplace.cityCode) ||
        ((scope.kind === 'center' || scope.kind === 'branch') &&
          within(workplace.nodePath, scope.path)),
    );
  }

  /** Adding secretaries: the doctor's own account, or someone above the doctor's node. */
  private requireOverSecretaries(
    actor: Actor,
    access: EffectiveAccess,
    doctor: DoctorRow,
    workplace: WorkplaceRow,
  ) {
    const isDoctor = doctor.accountId !== null && doctor.accountId === actor.accountId;
    if (!isDoctor && !this.managesAbove(access, workplace)) {
      throw new ForbiddenException({ error: 'doctor_or_manager_only' });
    }
  }

  /**
   * The actor for the audit trail: «on behalf of» the doctor when someone else acts for
   * them from inside the practice (a secretary, a center or branch manager). The network
   * acts on its own account.
   */
  private actingFor(
    actor: Actor,
    access: EffectiveAccess,
    doctor: DoctorRow,
    workplaces: readonly WorkplaceRow[],
  ): Actor {
    if (doctor.accountId !== null && doctor.accountId === actor.accountId) return actor;
    if (this.coveredByNetwork(access, workplaces)) return actor;
    return { ...actor, onBehalfOfDoctorId: doctor.id };
  }

  /** Which workplaces `access` covers: true for all, null for none, else a condition. */
  private scopeFilter(access: EffectiveAccess): SQL | true | null {
    const parts: SQL[] = [];
    const cities: string[] = [];
    for (const scope of access.scopes) {
      if (scope.kind === 'global') return true;
      if (scope.kind === 'city') cities.push(scope.code);
      if (scope.kind === 'center' || scope.kind === 'branch' || scope.kind === 'doctor') {
        // Paths are hex labels joined by dots: no LIKE wildcard can occur in them.
        parts.push(
          or(
            eq(doctorWorkplaces.nodePath, scope.path),
            like(doctorWorkplaces.nodePath, `${scope.path}.%`),
          ) as SQL,
        );
      }
    }
    if (cities.length > 0) parts.push(inArray(doctorWorkplaces.cityCode, cities));
    if (parts.length === 0) return null;
    return parts.length === 1 ? (parts[0] as SQL) : (or(...parts) as SQL);
  }

  /** The doctor and their workplaces if `access` covers one of them; otherwise 404. */
  private async visibleDoctor(
    tx: Tx,
    access: EffectiveAccess,
    id: string,
    lock = false,
  ): Promise<{ doctor: DoctorRow; workplaces: WorkplaceRow[] }> {
    if (!UUID.test(id)) throw new NotFoundException({ error: 'doctor_not_found' });
    const query = tx
      .select()
      .from(doctors)
      .where(and(eq(doctors.id, id), isNull(doctors.deletedAt)));
    const [doctor] = lock ? await query.for('update') : await query;
    if (!doctor) throw new NotFoundException({ error: 'doctor_not_found' });
    const workplaces = await tx
      .select()
      .from(doctorWorkplaces)
      .where(and(eq(doctorWorkplaces.doctorId, id), isNull(doctorWorkplaces.deletedAt)))
      .orderBy(asc(doctorWorkplaces.createdAt));
    if (!workplaces.some((w) => this.coversWorkplace(access, w))) {
      throw new NotFoundException({ error: 'doctor_not_found' });
    }
    return { doctor, workplaces };
  }

  /** One workplace the caller covers, with its doctor; otherwise 404. */
  private async visibleWorkplace(tx: Tx, access: EffectiveAccess, workplaceId: string) {
    if (!UUID.test(workplaceId)) throw new NotFoundException({ error: 'workplace_not_found' });
    const [workplace] = await tx
      .select()
      .from(doctorWorkplaces)
      .where(and(eq(doctorWorkplaces.id, workplaceId), isNull(doctorWorkplaces.deletedAt)));
    if (!workplace || !this.coversWorkplace(access, workplace)) {
      throw new NotFoundException({ error: 'workplace_not_found' });
    }
    const [doctor] = await tx
      .select()
      .from(doctors)
      .where(and(eq(doctors.id, workplace.doctorId), isNull(doctors.deletedAt)))
      .for('update');
    if (!doctor) throw new NotFoundException({ error: 'workplace_not_found' });
    return { doctor, workplace };
  }

  /**
   * Where a new workplace goes, if the caller may put a doctor there: a branch of an
   * active center they cover (the network, or its center or branch manager), or a private
   * practice in a city of the network's. `networkOnly` refuses the managers.
   */
  private async placeFor(
    tx: Tx,
    access: EffectiveAccess,
    workplace: z.output<typeof workplaceSchema>,
    networkOnly = false,
  ): Promise<{
    parentNodeId: string | null;
    cityCode: string;
    centerId: string | null;
    branchId: string | null;
  }> {
    const network = (city: string) =>
      access.scopes.some(
        (scope) => scope.kind === 'global' || (scope.kind === 'city' && scope.code === city),
      );
    if (workplace.kind === 'private_practice') {
      if (!network(workplace.cityCode)) throw new ForbiddenException({ error: 'network_only' });
      return { parentNodeId: null, cityCode: workplace.cityCode, centerId: null, branchId: null };
    }
    const [row] = await tx
      .select({ branch: branches, center: centers })
      .from(branches)
      .innerJoin(centers, eq(centers.id, branches.centerId))
      .where(
        and(
          eq(branches.id, workplace.branchId),
          isNull(branches.deletedAt),
          isNull(centers.deletedAt),
        ),
      )
      .for('share');
    if (!row) throw new NotFoundException({ error: 'branch_not_found' });
    const branchPath = `${labelOf(row.center.nodeId)}.${labelOf(row.branch.nodeId)}`;
    const manager = access.scopes.some(
      (scope) =>
        (scope.kind === 'center' || scope.kind === 'branch') && within(branchPath, scope.path),
    );
    if (!network(row.center.cityCode) && !(manager && !networkOnly)) {
      if (!manager) throw new NotFoundException({ error: 'branch_not_found' });
      throw new ForbiddenException({ error: 'network_only' });
    }
    // Only an active center takes doctors (doc 08 §3).
    if (row.center.status !== 'active') {
      throw new ConflictException({ error: 'center_not_active', status: row.center.status });
    }
    return {
      parentNodeId: row.branch.nodeId,
      cityCode: row.center.cityCode,
      centerId: row.center.id,
      branchId: row.branch.id,
    };
  }

  private async insertWorkplace(
    tx: Tx,
    actor: Actor,
    access: EffectiveAccess,
    doctor: DoctorRow,
    place: {
      parentNodeId: string | null;
      cityCode: string;
      centerId: string | null;
      branchId: string | null;
    },
    reason: string,
  ): Promise<WorkplaceRow> {
    const node = await this.tree.createNode(
      actor,
      access,
      {
        kind: 'doctor',
        parentId: place.parentNodeId,
        name: doctor.name,
        cityCode: place.parentNodeId === null ? place.cityCode : null,
        reason,
      },
      tx,
    );
    let row: WorkplaceRow | undefined;
    try {
      [row] = await tx
        .insert(doctorWorkplaces)
        .values({
          doctorId: doctor.id,
          nodeId: node.id,
          nodePath: node.path,
          centerId: place.centerId,
          branchId: place.branchId,
          cityCode: node.cityCode,
          createdBy: actor.accountId,
        })
        .returning();
    } catch (error) {
      const pg = pgError(error);
      if (
        pg?.code === '23505' &&
        (pg.constraint === 'doctor_workplaces_branch_key' ||
          pg.constraint === 'doctor_workplaces_private_key')
      ) {
        throw new ConflictException({ error: 'workplace_exists' });
      }
      throw error;
    }
    if (!row) throw new Error('workplace insert returned nothing');
    if (doctor.accountId !== null) {
      await this.tree.attachDoctorAccount(actor, node.id, doctor.accountId, reason, tx);
    }
    return row;
  }

  /** Replaces the doctor's treatment fields: removed ones are soft-deleted (rule 7). */
  private async setFields(tx: Tx, doctorId: string, codes: readonly string[]) {
    const current = await tx
      .select({ id: doctorTreatmentFields.id, code: doctorTreatmentFields.fieldCode })
      .from(doctorTreatmentFields)
      .where(
        and(eq(doctorTreatmentFields.doctorId, doctorId), isNull(doctorTreatmentFields.deletedAt)),
      );
    const gone = current.filter((row) => !codes.includes(row.code)).map((row) => row.id);
    if (gone.length > 0) {
      await tx
        .update(doctorTreatmentFields)
        .set({ deletedAt: new Date() })
        .where(inArray(doctorTreatmentFields.id, gone));
    }
    const added = codes.filter((code) => !current.some((row) => row.code === code));
    // Only new choices are checked: codes kept from before 2-4 stay (expand only).
    await requireActiveFieldCodes(tx, added);
    if (added.length > 0) {
      await tx
        .insert(doctorTreatmentFields)
        .values(added.map((fieldCode) => ({ doctorId, fieldCode })));
    }
  }

  private encryptNationalId(nationalId: string) {
    return {
      // Bound to the column, not to a node: a doctor has several.
      nationalIdEnc: this.crypto.fieldCrypto.encrypt(nationalId, DOCTOR_NATIONAL_ID),
      nationalIdIndex: this.crypto.blindIndex.of('national_id', nationalId),
      nationalIdLast4: lastFour(nationalId),
    };
  }

  /**
   * ADR-042: no other live doctor holds this national ID under any key of the ring (the
   * unique index sees only equal indexes, so not one written under an older key during a
   * rotation). One national ID at a time: a lock on its index under the ring's lowest key.
   */
  private async nationalIdFree(tx: Tx, nationalId: string, self: string | null) {
    const { blindIndex } = this.crypto;
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(
      ${`catalog.doctor_national_id:${blindIndex.stableOf('national_id', nationalId)}`}, 0))`);
    const taken = await tx
      .select({ id: doctors.id })
      .from(doctors)
      .where(
        and(
          inArray(doctors.nationalIdIndex, blindIndex.allOf('national_id', nationalId)),
          isNull(doctors.deletedAt),
        ),
      );
    if (taken.some((row) => row.id !== self)) {
      throw new ConflictException({ error: 'duplicate_national_id' });
    }
  }

  /** A duplicate council number, national ID or account becomes a clear 409. */
  private async uniqueWrite(write: () => Promise<DoctorRow[]>): Promise<DoctorRow[]> {
    try {
      return await write();
    } catch (error) {
      const pg = pgError(error);
      if (pg?.code === '23505') {
        const conflicts: Record<string, string> = {
          doctors_medical_council_number_key: 'duplicate_medical_council_number',
          doctors_national_id_index_key: 'duplicate_national_id',
          doctors_account_id_key: 'account_has_doctor',
        };
        const known = pg.constraint ? conflicts[pg.constraint] : undefined;
        if (known) throw new ConflictException({ error: known });
      }
      if (pg?.code === '23514') throw new BadRequestException({ error: 'invalid_value' });
      throw error;
    }
  }
}

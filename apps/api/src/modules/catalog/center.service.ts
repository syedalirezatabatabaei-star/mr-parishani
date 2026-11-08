import { FINANCIAL_STEP_UP, type FinancialStepUp } from '../../common/auth/step-up.port';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  type CenterDocumentStatus,
  type CenterPersonType,
  type CenterStatus,
  type createBranchSchema,
  type createCenterSchema,
  type PermissionCode,
  type proposeBankAccountSchema,
  type updateBranchSchema,
  type updateCenterSchema,
} from '@sepehr/contracts';
import { and, asc, eq, inArray, isNull, or, sql, type SQL } from 'drizzle-orm';
import type { z } from 'zod';
import type { EffectiveAccess } from '../../common/auth/access.port';
import { ORG_TREE, type OrgTreePort } from '../../common/auth/org-tree.port';
import {
  AUDIT_LOG,
  type Actor,
  type AuditLog,
  type SqlExecutor,
} from '../../common/audit/audit.port';
import type { CenterDirectory, PayoutAccount } from '../../common/catalog/center-directory.port';
import { CONFIG, type ConfigPort } from '../../common/config/config.port';
import { OUTBOX, type OutboxPort } from '../../common/events/outbox.port';
import { DATABASE, type Database } from '../../db/database.module';
import { lastFour } from '../../security/blind-index';
import {
  CATALOG_CRYPTO,
  type CatalogCrypto,
  centerIdentifierContext,
  centerShebaContext,
} from './catalog.crypto';
import { requireActiveFieldCodes } from './field-codes';
import {
  branches,
  centerChangeRequests,
  centerDocuments,
  centerStatusChanges,
  centers,
  centerTreatmentFields,
} from './catalog.schema';

type Tx = Parameters<Parameters<Database['transaction']>[0]>[0];
type CenterRow = typeof centers.$inferSelect;
type BranchRow = typeof branches.$inferSelect;
type RequestRow = typeof centerChangeRequests.$inferSelect;
type RequestKind = RequestRow['kind'];

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Who may decide each kind of two-person request (task 2-2 decisions). */
const APPROVER: Record<RequestKind, PermissionCode> = {
  activation: 'catalog.approve_center_activation',
  reactivation: 'catalog.approve_center_activation',
  bank_account: 'catalog.approve_bank_account_change',
};

/**
 * The domain event of entering each status (doc 08 §14), named `module.what_happened` as
 * every event of the repository (ADR-022).
 */
const STATUS_EVENT: Partial<Record<CenterStatus, string>> = {
  under_review: 'catalog.center_submitted',
  active: 'catalog.center_activated',
  suspended: 'catalog.center_suspended',
  terminated: 'catalog.center_terminated',
};

/** What each status lets anyone change directly (doc 08 §3). */
const EDITABLE: Record<CenterStatus, ReadonlySet<string>> = {
  draft: new Set(['all']),
  needs_fix: new Set(['all']),
  // «ویرایش محدود» while under review: contact details only.
  under_review: new Set(['phone']),
  // Identity is fixed and a bank account is a two-person request; the rest may change.
  active: new Set(['details']),
  suspended: new Set(['details']),
  terminated: new Set(),
};

export interface CenterView {
  readonly id: string;
  readonly nodeId: string;
  readonly personType: CenterPersonType;
  readonly name: string;
  readonly cityCode: string;
  readonly address: string | null;
  readonly location: { latitude: number; longitude: number } | null;
  readonly phone: string | null;
  readonly licenseNumber: string | null;
  /** Only the last four digits ever leave the service (rule 27). */
  readonly identifierLast4: string;
  readonly shebaLast4: string | null;
  readonly accountHolderName: string | null;
  readonly status: CenterStatus;
  readonly firstActivatedAt: string | null;
}

export interface BranchView {
  readonly id: string;
  readonly nodeId: string;
  readonly centerId: string;
  readonly name: string;
  readonly isDefault: boolean;
  readonly address: string | null;
  readonly location: { latitude: number; longitude: number } | null;
  readonly phone: string | null;
  readonly parking: BranchRow['parking'];
  readonly nearestMetro: string | null;
  readonly nearestBrt: string | null;
  readonly routeNote: string | null;
}

export interface CenterRequestView {
  readonly id: string;
  readonly centerId: string;
  readonly kind: RequestKind;
  readonly status: RequestRow['status'];
  readonly shebaLast4: string | null;
  readonly accountHolderName: string | null;
  readonly reason: string;
  readonly proposedBy: string;
  readonly decidedBy: string | null;
  readonly decidedAt: string | null;
  readonly decisionNote: string | null;
}

const locationOf = (row: { latitudeE6: number | null; longitudeE6: number | null }) =>
  row.latitudeE6 === null || row.longitudeE6 === null
    ? null
    : { latitude: row.latitudeE6 / 1_000_000, longitude: row.longitudeE6 / 1_000_000 };

const centerView = (row: CenterRow): CenterView => ({
  id: row.id,
  nodeId: row.nodeId,
  personType: row.personType,
  name: row.name,
  cityCode: row.cityCode,
  address: row.address,
  location: locationOf(row),
  phone: row.phone,
  licenseNumber: row.licenseNumber,
  identifierLast4: row.identifierLast4,
  shebaLast4: row.shebaLast4,
  accountHolderName: row.accountHolderName,
  status: row.status,
  firstActivatedAt: row.firstActivatedAt?.toISOString() ?? null,
});

const branchView = (row: BranchRow): BranchView => ({
  id: row.id,
  nodeId: row.nodeId,
  centerId: row.centerId,
  name: row.name,
  isDefault: row.isDefault,
  address: row.address,
  location: locationOf(row),
  phone: row.phone,
  parking: row.parking,
  nearestMetro: row.nearestMetro,
  nearestBrt: row.nearestBrt,
  routeNote: row.routeNote,
});

const requestView = (row: RequestRow): CenterRequestView => ({
  id: row.id,
  centerId: row.centerId,
  kind: row.kind,
  status: row.status,
  shebaLast4: row.shebaLast4,
  accountHolderName: row.accountHolderName,
  reason: row.reason,
  proposedBy: row.proposedBy,
  decidedBy: row.decidedBy,
  decidedAt: row.decidedAt?.toISOString() ?? null,
  decisionNote: row.decisionNote,
});

/** The ltree label of a node: its id without hyphens (migration 0002). */
const labelOf = (nodeId: string) => nodeId.replaceAll('-', '');
const nodeIdOfLabel = (label: string) =>
  `${label.slice(0, 8)}-${label.slice(8, 12)}-${label.slice(12, 16)}-${label.slice(16, 20)}-${label.slice(20)}`;

const pgError = (error: unknown): { code?: string; constraint?: string } | undefined => {
  const e = error as { code?: string; constraint?: string; cause?: unknown } | null;
  if (e?.code) return e;
  return (e?.cause as { code?: string; constraint?: string } | undefined) ?? undefined;
};

/**
 * Centers and branches (task 2-2, doc 08 §2–3, ADR-022): registration with automatic
 * checks, the document checklist, the status machine, two-person activation and bank
 * account changes, and suspension. Every change is audited with masked identifiers; the
 * database guards the status machine and the two-person rule as well.
 */
@Injectable()
export class CenterService implements CenterDirectory {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(ORG_TREE) private readonly tree: OrgTreePort,
    @Inject(CONFIG) private readonly config: ConfigPort,
    @Inject(OUTBOX) private readonly outbox: OutboxPort,
    @Inject(AUDIT_LOG) private readonly audit: AuditLog,
    @Inject(CATALOG_CRYPTO) private readonly crypto: CatalogCrypto,
    @Inject(FINANCIAL_STEP_UP) private readonly stepUp: FinancialStepUp,
  ) {}

  // --- CENTER_DIRECTORY ---------------------------------------------------------------

  async isBookable(nodeId: string): Promise<boolean> {
    if (!UUID.test(nodeId)) return false;
    const rows = await this.db.execute(sql`
      SELECT c.status FROM centers c
      WHERE c.deleted_at IS NULL
        AND (c.node_id = ${nodeId} OR EXISTS (
          SELECT 1 FROM branches b
          WHERE b.center_id = c.id AND b.node_id = ${nodeId} AND b.deleted_at IS NULL))
    `);
    return rows.rows[0]?.['status'] === 'active';
  }

  async contractParties(): Promise<{
    centers: string[];
    workplaces: { nodeId: string; centerNodeId: string | null }[];
  }> {
    const centersOf = await this.db.execute(sql`
      SELECT node_id FROM centers WHERE status = 'active' AND deleted_at IS NULL ORDER BY node_id
    `);
    const workplaces = await this.db.execute(sql`
      SELECT w.node_id, c.node_id AS center_node_id
      FROM doctor_workplaces w LEFT JOIN centers c ON c.id = w.center_id
      WHERE w.deleted_at IS NULL
        AND (w.center_id IS NULL OR (c.status = 'active' AND c.deleted_at IS NULL))
      ORDER BY w.node_id
    `);
    return {
      centers: centersOf.rows.map((r) => r['node_id'] as string),
      workplaces: workplaces.rows.map((r) => ({
        nodeId: r['node_id'] as string,
        centerNodeId: (r['center_node_id'] as string | null) ?? null,
      })),
    };
  }

  async payoutAccount(centerId: string, tx?: SqlExecutor): Promise<PayoutAccount | null> {
    if (!UUID.test(centerId)) return null;
    const rows = await (tx ?? this.db).execute(sql`
      SELECT node_id, sheba_enc, account_holder_name FROM centers
      WHERE id = ${centerId} AND deleted_at IS NULL
    `);
    const row = rows.rows[0];
    const enc = row?.['sheba_enc'] as string | null | undefined;
    if (!row || !enc) return null;
    return {
      sheba: this.crypto.fieldCrypto.decrypt(enc, this.shebaContext(row['node_id'] as string)),
      accountHolder: (row['account_holder_name'] as string | null) ?? null,
    };
  }

  // --- registration -------------------------------------------------------------------

  async create(
    actor: Actor,
    access: EffectiveAccess,
    input: z.output<typeof createCenterSchema>,
  ): Promise<CenterView> {
    this.require(access, 'catalog.manage_centers');
    return this.db.transaction(async (tx) => {
      const reason = 'ثبت مرکز';
      const node = await this.tree.createNode(
        actor,
        access,
        { kind: 'center', parentId: null, name: input.name, cityCode: input.cityCode, reason },
        tx,
      );
      await this.identifierFree(tx, input.personType, input.identifier, null);
      if (input.sheba !== undefined) await this.shebaFree(tx, input.sheba, null);
      const identifier = this.encryptIdentifier(node.id, input.personType, input.identifier);
      const bank = input.sheba === undefined ? null : this.encryptSheba(node.id, input.sheba);
      const row = await this.insertUnique(() =>
        tx
          .insert(centers)
          .values({
            nodeId: node.id,
            personType: input.personType,
            name: input.name,
            cityCode: node.cityCode,
            address: input.address ?? null,
            latitudeE6: input.location?.latitude ?? null,
            longitudeE6: input.location?.longitude ?? null,
            phone: input.phone ?? null,
            licenseNumber: input.licenseNumber ?? null,
            ...identifier,
            ...(bank ?? {}),
            accountHolderName: input.accountHolderName ?? null,
            createdBy: actor.accountId,
          })
          .returning(),
      );

      // A single-branch center has one default branch (doc 08 §2).
      const branchName = input.defaultBranchName ?? input.name;
      const branchNode = await this.tree.createNode(
        actor,
        access,
        { kind: 'branch', parentId: node.id, name: branchName, cityCode: null, reason },
        tx,
      );
      await tx.insert(branches).values({
        nodeId: branchNode.id,
        centerId: row.id,
        name: branchName,
        isDefault: true,
        address: input.address ?? null,
        latitudeE6: input.location?.latitude ?? null,
        longitudeE6: input.location?.longitude ?? null,
        phone: input.phone ?? null,
      });
      if (input.treatmentFieldCodes) {
        await this.setFields(tx, row.id, input.treatmentFieldCodes);
      }
      // Owner 1405/07/27 (ADR-046): the contract term, proposed with the center; in force once
      // a second person approves it in the settlement rates.
      if (input.contractTerm) {
        await this.config.proposeForRecord(
          actor,
          {
            key: 'settlement.provider_contract',
            scope: { level: 'center', ref: node.id },
            value: input.contractTerm,
            reason: `مدت قرارداد مرکز «${input.name}»، با ثبت مرکز`,
          },
          tx,
        );
      }
      await this.audit.record(
        {
          actor,
          action: 'catalog.center_created',
          entityType: 'center',
          entityId: row.id,
          after: { ...centerView(row), treatmentFieldCodes: input.treatmentFieldCodes ?? [] },
        },
        tx,
      );
      return centerView(row);
    });
  }

  async update(
    actor: Actor,
    access: EffectiveAccess,
    id: string,
    input: z.output<typeof updateCenterSchema>,
  ): Promise<CenterView> {
    this.require(access, 'catalog.manage_centers');
    return this.db.transaction(async (tx) => {
      const before = await this.lockCenter(tx, access, id, 'manage');
      const editable = EDITABLE[before.status];
      const changing = Object.entries(input)
        .filter(([key, value]) => key !== 'reason' && value !== undefined)
        .map(([key]) => key);
      const identity = ['personType', 'identifier', 'sheba', 'accountHolderName'];
      const refused = changing.filter((key) => {
        if (editable.has('all')) return false;
        if (identity.includes(key)) return true;
        if (editable.has('details')) return false;
        return !editable.has(key);
      });
      if (refused.length > 0) {
        throw new ConflictException({
          error:
            before.firstActivatedAt && refused.some((k) => identity.includes(k))
              ? 'use_two_person_request'
              : 'not_editable_in_status',
          status: before.status,
          fields: refused,
        });
      }

      const set: Partial<typeof centers.$inferInsert> = {};
      if (input.name !== undefined) set.name = input.name;
      if (input.address !== undefined) set.address = input.address;
      if (input.location !== undefined) {
        set.latitudeE6 = input.location.latitude;
        set.longitudeE6 = input.location.longitude;
      }
      if (input.phone !== undefined) set.phone = input.phone;
      if (input.licenseNumber !== undefined) set.licenseNumber = input.licenseNumber;
      if (input.personType !== undefined && input.identifier !== undefined) {
        await this.identifierFree(tx, input.personType, input.identifier, id);
        set.personType = input.personType;
        Object.assign(
          set,
          this.encryptIdentifier(before.nodeId, input.personType, input.identifier),
        );
      }
      if (input.sheba !== undefined) {
        await this.shebaFree(tx, input.sheba, id);
        Object.assign(set, this.encryptSheba(before.nodeId, input.sheba));
        set.accountHolderName = input.accountHolderName ?? null;
      }
      let after = before;
      if (Object.keys(set).length > 0) {
        after = await this.insertUnique(() =>
          tx.update(centers).set(set).where(eq(centers.id, id)).returning(),
        );
      }
      if (input.name !== undefined && input.name !== before.name) {
        await this.tree.renameNode(actor, access, before.nodeId, input.name, input.reason, tx);
      }
      if (input.treatmentFieldCodes !== undefined) {
        await this.setFields(tx, id, input.treatmentFieldCodes);
      }
      await this.audit.record(
        {
          actor,
          action: 'catalog.center_updated',
          entityType: 'center',
          entityId: id,
          before: centerView(before),
          after: { ...centerView(after), treatmentFieldCodes: input.treatmentFieldCodes },
          reason: input.reason,
        },
        tx,
      );
      // Its name is on the search results of its doctors (task 2-7).
      if (after.name !== before.name) {
        await this.outbox.publish(
          {
            type: 'catalog.center_updated',
            aggregateType: 'center',
            aggregateId: id,
            payload: { centerId: id, centerNodeId: before.nodeId },
          },
          tx,
        );
      }
      return centerView(after);
    });
  }

  // --- branches -----------------------------------------------------------------------

  async createBranch(
    actor: Actor,
    access: EffectiveAccess,
    centerId: string,
    input: z.output<typeof createBranchSchema>,
  ): Promise<BranchView> {
    this.require(access, 'catalog.manage_centers');
    return this.db.transaction(async (tx) => {
      const center = await this.lockCenter(tx, access, centerId, 'manage');
      if (center.status === 'terminated') {
        throw new ConflictException({ error: 'not_editable_in_status', status: center.status });
      }
      const node = await this.tree.createNode(
        actor,
        access,
        {
          kind: 'branch',
          parentId: center.nodeId,
          name: input.name,
          cityCode: null,
          reason: input.reason,
        },
        tx,
      );
      const [row] = await tx
        .insert(branches)
        .values({ nodeId: node.id, centerId, ...this.branchValues(input), name: input.name })
        .returning();
      if (!row) throw new Error('branch insert returned nothing');
      await this.audit.record(
        {
          actor,
          action: 'catalog.branch_created',
          entityType: 'branch',
          entityId: row.id,
          after: branchView(row),
          reason: input.reason,
        },
        tx,
      );
      return branchView(row);
    });
  }

  /** A branch's details and access information; its own manager may change them too. */
  async updateBranch(
    actor: Actor,
    access: EffectiveAccess,
    branchId: string,
    input: z.output<typeof updateBranchSchema>,
  ): Promise<BranchView> {
    this.require(access, 'catalog.manage_centers');
    if (!UUID.test(branchId)) throw new NotFoundException({ error: 'branch_not_found' });
    return this.db.transaction(async (tx) => {
      const [before] = await tx
        .select()
        .from(branches)
        .where(and(eq(branches.id, branchId), isNull(branches.deletedAt)))
        .for('update');
      if (!before) throw new NotFoundException({ error: 'branch_not_found' });
      const center = await this.centerRow(tx, before.centerId);
      if (!center || !this.coversBranch(access, center, before)) {
        throw new NotFoundException({ error: 'branch_not_found' });
      }
      if (center.status === 'terminated') {
        throw new ConflictException({ error: 'not_editable_in_status', status: center.status });
      }
      const values = this.branchValues(input);
      const [after] = await tx
        .update(branches)
        .set({ ...values, ...(input.name === undefined ? {} : { name: input.name }) })
        .where(eq(branches.id, branchId))
        .returning();
      if (!after) throw new Error('branch update returned nothing');
      if (input.name !== undefined && input.name !== before.name) {
        await this.tree.renameNode(actor, access, before.nodeId, input.name, input.reason, tx);
      }
      await this.audit.record(
        {
          actor,
          action: 'catalog.branch_updated',
          entityType: 'branch',
          entityId: branchId,
          before: branchView(before),
          after: branchView(after),
          reason: input.reason,
        },
        tx,
      );
      return branchView(after);
    });
  }

  // --- reading ------------------------------------------------------------------------

  async list(access: EffectiveAccess, status?: CenterStatus): Promise<CenterView[]> {
    this.require(access, 'catalog.read_centers');
    const where: SQL[] = [isNull(centers.deletedAt)];
    if (status) where.push(eq(centers.status, status));
    const scope = this.scopeFilter(access);
    if (scope === null) return [];
    if (scope !== true) where.push(scope);
    const rows = await this.db
      .select()
      .from(centers)
      .where(and(...where))
      .orderBy(asc(centers.createdAt));
    return rows.map((row) => this.viewFor(access, row));
  }

  /** One center with its branches, fields, documents against the checklist, and requests. */
  async get(actor: Actor, access: EffectiveAccess, id: string) {
    this.require(access, 'catalog.read_centers');
    const center = await this.db.transaction((tx) => this.visibleCenter(tx, access, id, 'read'));
    const [branchRows, fieldRows, documentRows, requestRows, checklist] = await Promise.all([
      this.db
        .select()
        .from(branches)
        .where(and(eq(branches.centerId, id), isNull(branches.deletedAt)))
        .orderBy(asc(branches.createdAt)),
      this.db
        .select({ code: centerTreatmentFields.fieldCode })
        .from(centerTreatmentFields)
        .where(
          and(eq(centerTreatmentFields.centerId, id), isNull(centerTreatmentFields.deletedAt)),
        ),
      this.db
        .select()
        .from(centerDocuments)
        .where(and(eq(centerDocuments.centerId, id), isNull(centerDocuments.deletedAt))),
      this.db
        .select()
        .from(centerChangeRequests)
        .where(eq(centerChangeRequests.centerId, id))
        .orderBy(asc(centerChangeRequests.createdAt)),
      this.checklistFor(center),
    ]);
    await this.audit.recordView(actor, 'center', id);
    // A branch (or doctor) scope sees its own branch of the center, not the center's
    // other branches, documents, requests or bank account (doc 08 §2, rule 13).
    if (!this.covers(access, center, 'manage')) {
      return {
        ...this.viewFor(access, center),
        branches: branchRows
          .filter((branch) => this.coversBranch(access, center, branch))
          .map(branchView),
        treatmentFieldCodes: fieldRows.map((f) => f.code).sort(),
        documents: [],
        requests: [],
      };
    }
    const status = new Map(documentRows.map((d) => [d.code, d]));
    return {
      ...centerView(center),
      branches: branchRows.map(branchView),
      treatmentFieldCodes: fieldRows.map((f) => f.code).sort(),
      documents: checklist.items.map((item) => ({
        code: item.code,
        title: item.title,
        status: status.get(item.code)?.status ?? null,
        note: status.get(item.code)?.note ?? null,
      })),
      requests: requestRows.map(requestView),
    };
  }

  /** The full Sheba, for accounting; recorded in the access log (doc 04 §7). */
  async bankAccount(actor: Actor, access: EffectiveAccess, id: string) {
    this.require(access, 'catalog.view_bank_account');
    const center = await this.db.transaction((tx) => this.visibleCenter(tx, access, id, 'read'));
    await this.audit.recordView(actor, 'center_bank_account', id);
    return {
      sheba: center.shebaEnc
        ? this.crypto.fieldCrypto.decrypt(center.shebaEnc, this.shebaContext(center.nodeId))
        : null,
      accountHolderName: center.accountHolderName,
    };
  }

  // --- documents ----------------------------------------------------------------------

  /**
   * Sets one checklist document's status. «Received» is the registrant's; «verified» and
   * «incomplete» are the reviewer's. Files come with task 2-8, reusing these statuses.
   */
  async setDocumentStatus(
    actor: Actor,
    access: EffectiveAccess,
    id: string,
    code: string,
    input: { status: CenterDocumentStatus; note?: string | undefined },
  ) {
    this.require(
      access,
      input.status === 'received' ? 'catalog.manage_centers' : 'catalog.review_centers',
    );
    return this.db.transaction(async (tx) => {
      const center = await this.lockCenter(
        tx,
        access,
        id,
        input.status === 'received' ? 'manage' : 'network',
      );
      if (center.status === 'terminated') {
        throw new ConflictException({ error: 'not_editable_in_status', status: center.status });
      }
      const checklist = await this.checklistFor(center);
      if (!checklist.items.some((item) => item.code === code)) {
        throw new BadRequestException({
          error: 'unknown_document',
          allowed: checklist.items.map((i) => i.code),
        });
      }
      const [before] = await tx
        .select()
        .from(centerDocuments)
        .where(
          and(
            eq(centerDocuments.centerId, id),
            eq(centerDocuments.code, code),
            isNull(centerDocuments.deletedAt),
          ),
        );
      const values = { status: input.status, note: input.note ?? null, updatedBy: actor.accountId };
      const [after] = before
        ? await tx
            .update(centerDocuments)
            .set(values)
            .where(eq(centerDocuments.id, before.id))
            .returning()
        : await tx
            .insert(centerDocuments)
            .values({ centerId: id, code, ...values })
            .returning();
      await this.audit.record(
        {
          actor,
          action: 'catalog.center_document_status_set',
          entityType: 'center',
          entityId: id,
          before: before ? { code, status: before.status } : null,
          after: { code, status: after?.status, note: after?.note },
          reason: input.note ?? null,
        },
        tx,
      );
      return { code, status: input.status, note: input.note ?? null };
    });
  }

  // --- the status machine -------------------------------------------------------------

  /**
   * draft or needs_fix → under_review, after the automatic checks (doc 08 §3): the
   * identifiers were checked by their algorithms and for duplicates when entered; here a
   * bank account and every document of the checklist must be in, none incomplete.
   */
  async submit(actor: Actor, access: EffectiveAccess, id: string, reason: string) {
    this.require(access, 'catalog.manage_centers');
    return this.db.transaction(async (tx) => {
      const center = await this.lockCenter(tx, access, id, 'manage');
      if (center.status !== 'draft' && center.status !== 'needs_fix') {
        throw new ConflictException({ error: 'invalid_transition', status: center.status });
      }
      const checklist = await this.checklistFor(center);
      const docs = await this.documentStatuses(tx, id);
      const missing = checklist.items
        .filter((item) => {
          const status = docs.get(item.code);
          return status !== 'received' && status !== 'verified';
        })
        .map((item) => item.code);
      const problems: string[] = [];
      if (!center.shebaEnc) problems.push('bank_account_missing');
      if (missing.length > 0) problems.push('documents_missing');
      if (problems.length > 0) {
        throw new ConflictException({ error: 'automatic_checks_failed', problems, missing });
      }
      await tx
        .update(centers)
        .set({ checklistConfigVersionId: checklist.versionId })
        .where(eq(centers.id, id));
      return this.transition(tx, actor, center, 'under_review', reason, null);
    });
  }

  /** under_review → needs_fix: a gap or a mismatch found in review. */
  async returnForFix(actor: Actor, access: EffectiveAccess, id: string, reason: string) {
    this.require(access, 'catalog.review_centers');
    return this.db.transaction(async (tx) => {
      const center = await this.lockCenter(tx, access, id, 'network');
      if (center.status !== 'under_review') {
        throw new ConflictException({ error: 'invalid_transition', status: center.status });
      }
      return this.transition(tx, actor, center, 'needs_fix', reason, null);
    });
  }

  /**
   * Step one of an activation (under_review, every document verified) or a reactivation
   * (suspended). A second person with catalog.approve_center_activation decides.
   */
  async proposeActivation(actor: Actor, access: EffectiveAccess, id: string, reason: string) {
    this.require(access, 'catalog.review_centers');
    return this.db.transaction(async (tx) => {
      const center = await this.lockCenter(tx, access, id, 'network');
      let kind: RequestKind;
      if (center.status === 'under_review') {
        kind = 'activation';
        const unverified = await this.unverifiedDocuments(tx, center);
        if (unverified.length > 0) {
          throw new ConflictException({ error: 'documents_not_verified', unverified });
        }
      } else if (center.status === 'suspended') {
        kind = 'reactivation';
      } else {
        throw new ConflictException({ error: 'invalid_transition', status: center.status });
      }
      return this.propose(tx, actor, center, { kind, reason });
    });
  }

  /** active → suspended: no new bookings; existing items settle as before (doc 08 §3). */
  async suspend(actor: Actor, access: EffectiveAccess, id: string, reason: string) {
    this.require(access, 'catalog.suspend_center');
    return this.db.transaction(async (tx) => {
      const center = await this.lockCenter(tx, access, id, 'network');
      if (center.status !== 'active') {
        throw new ConflictException({ error: 'invalid_transition', status: center.status });
      }
      // TODO(2-6): the booking module consumes catalog.center_suspended and moves the
      // center's future appointments to the «needs relocation» queue, never deleting them
      // (doc 08 §15 test 5, ADR-022).
      return this.transition(tx, actor, center, 'suspended', reason, null);
    });
  }

  /** active or suspended → terminated: only reports and settling earlier items remain. */
  async terminate(actor: Actor, access: EffectiveAccess, id: string, reason: string) {
    this.require(access, 'catalog.suspend_center');
    return this.db.transaction(async (tx) => {
      const center = await this.lockCenter(tx, access, id, 'network');
      if (center.status !== 'active' && center.status !== 'suspended') {
        throw new ConflictException({ error: 'invalid_transition', status: center.status });
      }
      // TODO(2-6): as for a suspension, catalog.center_terminated moves future appointments
      // to the relocation queue.
      return this.transition(tx, actor, center, 'terminated', reason, null);
    });
  }

  // --- bank account after activation --------------------------------------------------

  /**
   * Step one of a new bank account for an activated center (doc 04 §5): proposed by the
   * network specialist or the center's manager, decided by accounting (task 2-2 decision).
   */
  async proposeBankAccount(
    actor: Actor,
    access: EffectiveAccess,
    id: string,
    input: z.output<typeof proposeBankAccountSchema>,
  ) {
    this.require(access, 'catalog.manage_centers');
    // ADR-052: a new Sheba is asked with the asker's own SMS code.
    await this.stepUp.assert(actor, {
      type: 'bank_account_change',
      id,
      amountRial: null,
      step: 'request',
    });
    return this.db.transaction(async (tx) => {
      const center = await this.lockCenter(tx, access, id, 'manage');
      if (!center.firstActivatedAt) {
        // Before the first activation the bank account is edited directly.
        throw new ConflictException({ error: 'edit_directly_before_activation' });
      }
      if (center.status === 'terminated') {
        throw new ConflictException({ error: 'not_editable_in_status', status: center.status });
      }
      const bank = this.encryptSheba(center.nodeId, input.sheba);
      // Under every key (ADR-042): this center's own Sheba too, indexed under an older one.
      const taken = await this.shebaFree(tx, input.sheba, id);
      if (taken.length > 0 && center.accountHolderName === input.accountHolderName) {
        throw new ConflictException({ error: 'bank_account_unchanged' });
      }
      return this.propose(tx, actor, center, {
        kind: 'bank_account',
        reason: input.reason,
        ...bank,
        accountHolderName: input.accountHolderName,
      });
    });
  }

  // --- two-person decisions -----------------------------------------------------------

  async listRequests(access: EffectiveAccess): Promise<CenterRequestView[]> {
    this.require(access, 'catalog.read_centers');
    // Requests are the whole center's business: not for a branch or doctor scope.
    const scope = this.scopeFilter(access, false);
    if (scope === null) return [];
    const rows = await this.db
      .select({ request: centerChangeRequests })
      .from(centerChangeRequests)
      .innerJoin(centers, eq(centers.id, centerChangeRequests.centerId))
      .where(and(eq(centerChangeRequests.status, 'proposed'), ...(scope === true ? [] : [scope])))
      .orderBy(asc(centerChangeRequests.createdAt));
    return rows.map((r) => requestView(r.request));
  }

  /**
   * Approves or rejects a two-person request. The proposer never decides, whatever roles
   * they hold (task 2-2 decision; the database checks it too).
   */
  async decide(
    actor: Actor,
    access: EffectiveAccess,
    requestId: string,
    approve: boolean,
    note?: string,
  ): Promise<CenterRequestView> {
    if (!UUID.test(requestId)) throw new NotFoundException({ error: 'request_not_found' });
    if (!actor.accountId) throw new ForbiddenException({ error: 'account_required' });
    return this.db.transaction(async (tx) => {
      const [found] = await tx
        .select({ centerId: centerChangeRequests.centerId })
        .from(centerChangeRequests)
        .where(eq(centerChangeRequests.id, requestId));
      if (!found) throw new NotFoundException({ error: 'request_not_found' });
      // The center first, as every other change does, then the request; a request of a
      // center out of scope does not exist (rule 13).
      const center = await this.visibleCenter(tx, access, found.centerId, 'read', true).catch(
        (error: unknown) => {
          throw error instanceof NotFoundException
            ? new NotFoundException({ error: 'request_not_found' })
            : error;
        },
      );
      const [request] = await tx
        .select()
        .from(centerChangeRequests)
        .where(eq(centerChangeRequests.id, requestId))
        .for('update');
      if (!request) throw new NotFoundException({ error: 'request_not_found' });
      this.require(access, APPROVER[request.kind]);
      if (!this.covers(access, center, 'network')) {
        throw new ForbiddenException({ error: 'out_of_scope' });
      }
      if (request.status !== 'proposed') throw new ConflictException({ error: 'already_decided' });
      if (request.proposedBy === actor.accountId) {
        throw new ForbiddenException({ error: 'second_person_required' });
      }
      if (approve && request.kind === 'bank_account') {
        // ADR-052: the approver's own SMS code for this Sheba change.
        await this.stepUp.assert(actor, {
          type: 'bank_account_change',
          id: requestId,
          amountRial: null,
          step: 'approve',
        });
      }
      if (approve && request.kind === 'activation') {
        // Documents may have changed since the proposal: approve only what is verified now.
        const unverified = await this.unverifiedDocuments(tx, center);
        if (unverified.length > 0) {
          throw new ConflictException({ error: 'documents_not_verified', unverified });
        }
      }

      const [decided] = await tx
        .update(centerChangeRequests)
        .set({
          status: approve ? 'approved' : 'rejected',
          decidedBy: actor.accountId,
          decidedAt: sql`now()`,
          decisionNote: note ?? null,
        })
        .where(eq(centerChangeRequests.id, requestId))
        .returning();
      if (!decided) throw new Error('request update returned nothing');

      if (approve) {
        if (request.kind === 'bank_account') {
          // Taken by another center since the proposal, under any key (ADR-042)?
          if (request.shebaEnc) {
            const sheba = this.crypto.fieldCrypto.decrypt(
              request.shebaEnc,
              this.shebaContext(center.nodeId),
            );
            await this.shebaFree(tx, sheba, center.id);
          }
          const before = centerView(center);
          const [after] = await this.insertUniqueAll(() =>
            tx
              .update(centers)
              .set({
                shebaEnc: request.shebaEnc,
                shebaIndex: request.shebaIndex,
                shebaLast4: request.shebaLast4,
                accountHolderName: request.accountHolderName,
              })
              .where(eq(centers.id, center.id))
              .returning(),
          );
          await this.audit.record(
            {
              actor,
              action: 'catalog.center_bank_account_changed',
              entityType: 'center',
              entityId: center.id,
              before: {
                shebaLast4: before.shebaLast4,
                accountHolderName: before.accountHolderName,
              },
              after: { shebaLast4: after?.shebaLast4, accountHolderName: after?.accountHolderName },
              reason: request.reason,
            },
            tx,
          );
        } else {
          const expected = request.kind === 'activation' ? 'under_review' : 'suspended';
          if (center.status !== expected) {
            throw new ConflictException({ error: 'center_status_changed', status: center.status });
          }
          await this.transition(tx, actor, center, 'active', request.reason, request.id);
        }
      }
      await this.audit.record(
        {
          actor,
          action: approve ? 'catalog.center_request_approved' : 'catalog.center_request_rejected',
          entityType: 'center_change_request',
          entityId: requestId,
          before: { status: 'proposed' },
          after: requestView(decided),
          reason: note ?? null,
        },
        tx,
      );
      return requestView(decided);
    });
  }

  // --- helpers ------------------------------------------------------------------------

  private require(access: EffectiveAccess, permission: PermissionCode) {
    if (!access.permissions.has(permission)) {
      throw new ForbiddenException({ error: 'permission_required', permission });
    }
  }

  /**
   * Which centers `access` covers: true for all, null for none, else a condition. A
   * center, branch or doctor scope covers the center at the root of its path.
   */
  private scopeFilter(access: EffectiveAccess, belowCenter = true): SQL | true | null {
    const cities: string[] = [];
    const roots = new Set<string>();
    for (const scope of access.scopes) {
      if (scope.kind === 'global') return true;
      if (scope.kind === 'city') cities.push(scope.code);
      if (
        scope.kind === 'center' ||
        (belowCenter && (scope.kind === 'branch' || scope.kind === 'doctor'))
      ) {
        const root = scope.path.split('.')[0];
        if (root) roots.add(nodeIdOfLabel(root));
      }
    }
    const parts: SQL[] = [];
    if (cities.length > 0) parts.push(inArray(centers.cityCode, cities));
    if (roots.size > 0) parts.push(inArray(centers.nodeId, [...roots]));
    if (parts.length === 0) return null;
    return parts.length === 1 ? (parts[0] as SQL) : (or(...parts) as SQL);
  }

  /**
   * Whether `access` may act on the whole center: `read` for any scope that reaches it;
   * `manage` for its network (global or its city) or its own center scope; `network` for
   * the network only (reviews, suspensions, decisions).
   */
  private covers(
    access: EffectiveAccess,
    center: CenterRow,
    level: 'read' | 'manage' | 'network',
  ): boolean {
    const root = labelOf(center.nodeId);
    return access.scopes.some((scope) => {
      if (scope.kind === 'global') return true;
      if (scope.kind === 'city') return scope.code === center.cityCode;
      if (level === 'network') return false;
      if (scope.kind === 'center') return scope.path === root;
      if (level === 'manage') return false;
      return (
        (scope.kind === 'branch' || scope.kind === 'doctor') && scope.path.split('.')[0] === root
      );
    });
  }

  private coversBranch(access: EffectiveAccess, center: CenterRow, branch: BranchRow): boolean {
    if (this.covers(access, center, 'manage')) return true;
    const path = `${labelOf(center.nodeId)}.${labelOf(branch.nodeId)}`;
    return access.scopes.some((scope) => scope.kind === 'branch' && scope.path === path);
  }

  /** The center as `access` may see it: without the bank account below the center level. */
  private viewFor(access: EffectiveAccess, center: CenterRow): CenterView {
    const view = centerView(center);
    return this.covers(access, center, 'manage')
      ? view
      : { ...view, shebaLast4: null, accountHolderName: null };
  }

  private async centerRow(tx: Tx, id: string): Promise<CenterRow | undefined> {
    const [row] = await tx
      .select()
      .from(centers)
      .where(and(eq(centers.id, id), isNull(centers.deletedAt)));
    return row;
  }

  /** The center if `access` covers it; otherwise 404, never 403 (rule 13). */
  private async visibleCenter(
    tx: Tx,
    access: EffectiveAccess,
    id: string,
    level: 'read' | 'manage' | 'network',
    lock = false,
  ): Promise<CenterRow> {
    if (!UUID.test(id)) throw new NotFoundException({ error: 'center_not_found' });
    const query = tx
      .select()
      .from(centers)
      .where(and(eq(centers.id, id), isNull(centers.deletedAt)));
    const [row] = lock ? await query.for('update') : await query;
    if (!row || !this.covers(access, row, 'read')) {
      throw new NotFoundException({ error: 'center_not_found' });
    }
    if (!this.covers(access, row, level)) throw new ForbiddenException({ error: 'out_of_scope' });
    return row;
  }

  /** Every change to a center waits for the one before it. */
  private lockCenter(
    tx: Tx,
    access: EffectiveAccess,
    id: string,
    level: 'manage' | 'network',
  ): Promise<CenterRow> {
    return this.visibleCenter(tx, access, id, level, true);
  }

  private async transition(
    tx: Tx,
    actor: Actor,
    center: CenterRow,
    to: CenterStatus,
    reason: string,
    requestId: string | null,
  ): Promise<CenterView> {
    const [after] = await tx
      .update(centers)
      .set({
        status: to,
        ...(to === 'active' && !center.firstActivatedAt ? { firstActivatedAt: sql`now()` } : {}),
      })
      .where(eq(centers.id, center.id))
      .returning();
    if (!after) throw new Error('center update returned nothing');
    await tx.insert(centerStatusChanges).values({
      centerId: center.id,
      fromStatus: center.status,
      toStatus: to,
      reason,
      changedBy: actor.accountId,
      requestId,
    });
    await this.audit.record(
      {
        actor,
        action: 'catalog.center_status_changed',
        entityType: 'center',
        entityId: center.id,
        before: { status: center.status },
        after: { status: to, requestId },
        reason,
      },
      tx,
    );
    // A request made for the status the center just left is no longer what was proposed:
    // an activation after a new round of review, or anything of a terminated center.
    if (to === 'needs_fix') await this.withdraw(tx, actor, center.id, ['activation'], reason);
    if (to === 'terminated') {
      await this.withdraw(
        tx,
        actor,
        center.id,
        ['activation', 'reactivation', 'bank_account'],
        reason,
      );
    }
    const event = STATUS_EVENT[to];
    if (event) {
      await this.outbox.publish(
        {
          type: event,
          aggregateType: 'center',
          aggregateId: center.id,
          payload: { centerId: center.id, centerNodeId: center.nodeId },
        },
        tx,
      );
    }
    return centerView(after);
  }

  private async withdraw(
    tx: Tx,
    actor: Actor,
    centerId: string,
    kinds: RequestKind[],
    reason: string,
  ) {
    const withdrawn = await tx
      .update(centerChangeRequests)
      .set({
        status: 'withdrawn',
        decidedBy: actor.accountId,
        decidedAt: sql`now()`,
        decisionNote: reason,
      })
      .where(
        and(
          eq(centerChangeRequests.centerId, centerId),
          eq(centerChangeRequests.status, 'proposed'),
          inArray(centerChangeRequests.kind, kinds),
        ),
      )
      .returning();
    for (const row of withdrawn) {
      await this.audit.record(
        {
          actor,
          action: 'catalog.center_request_withdrawn',
          entityType: 'center_change_request',
          entityId: row.id,
          before: { status: 'proposed' },
          after: requestView(row),
          reason,
        },
        tx,
      );
    }
  }

  private async propose(
    tx: Tx,
    actor: Actor,
    center: CenterRow,
    request: {
      kind: RequestKind;
      reason: string;
      shebaEnc?: string;
      shebaIndex?: string;
      shebaLast4?: string;
      accountHolderName?: string;
    },
  ): Promise<CenterRequestView> {
    if (!actor.accountId) throw new ForbiddenException({ error: 'account_required' });
    const rows = await tx
      .insert(centerChangeRequests)
      .values({ centerId: center.id, proposedBy: actor.accountId, ...request })
      .onConflictDoNothing()
      .returning();
    const row = rows[0];
    if (!row) throw new ConflictException({ error: 'request_already_open', kind: request.kind });
    await this.audit.record(
      {
        actor,
        action: 'catalog.center_request_proposed',
        entityType: 'center_change_request',
        entityId: row.id,
        after: requestView(row),
        reason: request.reason,
      },
      tx,
    );
    return requestView(row);
  }

  private async checklistFor(center: CenterRow) {
    const resolved = center.checklistConfigVersionId
      ? await this.config.getVersion(
          'catalog.center_document_checklist',
          center.checklistConfigVersionId,
        )
      : await this.config.resolve('catalog.center_document_checklist');
    return { items: resolved.value[center.personType], versionId: resolved.versionId };
  }

  private async unverifiedDocuments(tx: Tx, center: CenterRow): Promise<string[]> {
    const checklist = await this.checklistFor(center);
    const docs = await this.documentStatuses(tx, center.id);
    return checklist.items
      .filter((item) => docs.get(item.code) !== 'verified')
      .map((item) => item.code);
  }

  private async documentStatuses(tx: Tx, centerId: string) {
    const rows = await tx
      .select({ code: centerDocuments.code, status: centerDocuments.status })
      .from(centerDocuments)
      .where(and(eq(centerDocuments.centerId, centerId), isNull(centerDocuments.deletedAt)));
    return new Map(rows.map((r) => [r.code, r.status]));
  }

  /** Replaces the center's treatment fields: removed ones are soft-deleted (rule 7). */
  private async setFields(tx: Tx, centerId: string, codes: readonly string[]) {
    const current = await tx
      .select({ id: centerTreatmentFields.id, code: centerTreatmentFields.fieldCode })
      .from(centerTreatmentFields)
      .where(
        and(eq(centerTreatmentFields.centerId, centerId), isNull(centerTreatmentFields.deletedAt)),
      );
    const gone = current.filter((row) => !codes.includes(row.code)).map((row) => row.id);
    if (gone.length > 0) {
      await tx
        .update(centerTreatmentFields)
        .set({ deletedAt: sql`now()` })
        .where(inArray(centerTreatmentFields.id, gone));
    }
    const added = codes.filter((code) => !current.some((row) => row.code === code));
    // Only new choices are checked: codes kept from before 2-4 stay (expand only).
    await requireActiveFieldCodes(tx, added);
    if (added.length > 0) {
      await tx
        .insert(centerTreatmentFields)
        .values(added.map((fieldCode) => ({ centerId, fieldCode })));
    }
  }

  private branchValues(input: z.output<typeof updateBranchSchema>) {
    const values: Partial<typeof branches.$inferInsert> = {};
    if (input.address !== undefined) values.address = input.address;
    if (input.location !== undefined) {
      values.latitudeE6 = input.location.latitude;
      values.longitudeE6 = input.location.longitude;
    }
    if (input.phone !== undefined) values.phone = input.phone;
    if (input.parking !== undefined) values.parking = input.parking;
    if (input.nearestMetro !== undefined) values.nearestMetro = input.nearestMetro;
    if (input.nearestBrt !== undefined) values.nearestBrt = input.nearestBrt;
    if (input.routeNote !== undefined) values.routeNote = input.routeNote;
    return values;
  }

  // --- encrypted identifiers (rule 27) ------------------------------------------------

  private identifierContext = centerIdentifierContext;
  private shebaContext = centerShebaContext;

  private encryptIdentifier(nodeId: string, type: CenterPersonType, identifier: string) {
    return {
      identifierEnc: this.crypto.fieldCrypto.encrypt(identifier, this.identifierContext(nodeId)),
      identifierIndex: this.crypto.blindIndex.of(
        type === 'natural' ? 'national_id' : 'legal_id',
        identifier,
      ),
      identifierLast4: lastFour(identifier),
    };
  }

  private encryptSheba(nodeId: string, sheba: string) {
    return {
      shebaEnc: this.crypto.fieldCrypto.encrypt(sheba, this.shebaContext(nodeId)),
      shebaIndex: this.crypto.blindIndex.of('sheba', sheba),
      shebaLast4: lastFour(sheba),
    };
  }

  /**
   * ADR-042: no other live center holds this identifier under any key of the ring (the unique
   * index sees only equal indexes, so not one written under an older key during a rotation).
   * One identifier at a time: a lock on its index under the ring's lowest key.
   */
  private async identifierFree(
    tx: Tx,
    type: CenterPersonType,
    identifier: string,
    self: string | null,
  ) {
    const domain = type === 'natural' ? 'national_id' : 'legal_id';
    const { blindIndex } = this.crypto;
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(
      ${`catalog.center_identifier:${blindIndex.stableOf(domain, identifier)}`}, 0))`);
    const taken = await tx
      .select({ id: centers.id })
      .from(centers)
      .where(
        and(
          inArray(centers.identifierIndex, blindIndex.allOf(domain, identifier)),
          isNull(centers.deletedAt),
        ),
      );
    if (taken.some((row) => row.id !== self)) {
      throw new ConflictException({ error: 'duplicate_identifier' });
    }
  }

  /**
   * ADR-042, as identifierFree for a Sheba: refused if another live center holds it under any
   * key; the live centers holding it (this one included) otherwise.
   */
  private async shebaFree(tx: Tx, sheba: string, self: string | null) {
    const { blindIndex } = this.crypto;
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(
      ${`catalog.center_sheba:${blindIndex.stableOf('sheba', sheba)}`}, 0))`);
    const taken = await tx
      .select({ id: centers.id })
      .from(centers)
      .where(
        and(
          inArray(centers.shebaIndex, blindIndex.allOf('sheba', sheba)),
          isNull(centers.deletedAt),
        ),
      );
    if (taken.some((row) => row.id !== self)) {
      throw new ConflictException({ error: 'duplicate_sheba' });
    }
    return taken;
  }

  /** A duplicate identifier or Sheba (the blind-index unique keys) becomes a clear 409. */
  private async insertUnique(write: () => Promise<CenterRow[]>): Promise<CenterRow> {
    const [row] = await this.insertUniqueAll(write);
    if (!row) throw new Error('center write returned nothing');
    return row;
  }

  private async insertUniqueAll(write: () => Promise<CenterRow[]>): Promise<CenterRow[]> {
    try {
      return await write();
    } catch (error) {
      const pg = pgError(error);
      if (pg?.code === '23505' && pg.constraint === 'centers_identifier_index_key') {
        throw new ConflictException({ error: 'duplicate_identifier' });
      }
      if (pg?.code === '23505' && pg.constraint === 'centers_sheba_index_key') {
        throw new ConflictException({ error: 'duplicate_sheba' });
      }
      throw error;
    }
  }
}

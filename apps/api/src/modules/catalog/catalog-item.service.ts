import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  type createServiceSchema,
  type createTreatmentFieldSchema,
  type PermissionCode,
  type updateServiceSchema,
  type updateTreatmentFieldSchema,
} from '@sepehr/contracts';
import { and, asc, eq, isNull, sql } from 'drizzle-orm';
import type { z } from 'zod';
import type { EffectiveAccess } from '../../common/auth/access.port';
import { AUDIT_LOG, type Actor, type AuditLog } from '../../common/audit/audit.port';
import { OUTBOX, type OutboxPort } from '../../common/events/outbox.port';
import { DATABASE, type Database } from '../../db/database.module';
import { services, treatmentFields } from './catalog.schema';

type Tx = Parameters<Parameters<Database['transaction']>[0]>[0];
type FieldRow = typeof treatmentFields.$inferSelect;
type ServiceRow = typeof services.$inferSelect;

const MANAGE: PermissionCode = 'catalog.manage_catalog';
const CODE = /^[a-z][a-z0-9_]{1,62}$/;

export interface TreatmentFieldView {
  readonly code: string;
  readonly name: string;
  readonly sortOrder: number;
}

export interface ServiceView {
  readonly code: string;
  readonly name: string;
  readonly kind: 'standard' | 'visit';
  /** ADR-050: the doctor's wage or materials. */
  readonly costKind: 'wage' | 'material';
  /** Null for the visit, which belongs to no field. */
  readonly fieldCode: string | null;
}

const fieldView = (row: FieldRow): TreatmentFieldView => ({
  code: row.code,
  name: row.name,
  sortOrder: row.sortOrder,
});

const pgError = (error: unknown): { code?: string; constraint?: string } | undefined => {
  const e = error as { code?: string; constraint?: string; cause?: unknown } | null;
  if (e?.code) return e;
  return (e?.cause as { code?: string; constraint?: string } | undefined) ?? undefined;
};

/**
 * Treatment fields and their services (task 2-4, doc 08 §4, ADR-024). The lists are public
 * (booking and profile pages show them); only the network manager and the system admin
 * change them (task 2-4 decision), one person, every change audited with its reason.
 * Centers and doctors only pick from them. A code is for ever: retiring is a soft delete
 * and the code is never reused.
 */
@Injectable()
export class CatalogItemService {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(AUDIT_LOG) private readonly audit: AuditLog,
    @Inject(OUTBOX) private readonly outbox: OutboxPort,
  ) {}

  // --- reading (public) ---------------------------------------------------------------

  async listFields(): Promise<TreatmentFieldView[]> {
    const rows = await this.db
      .select()
      .from(treatmentFields)
      .where(isNull(treatmentFields.deletedAt))
      .orderBy(asc(treatmentFields.sortOrder), asc(treatmentFields.name));
    return rows.map(fieldView);
  }

  /** Active services, the visit first; with `fieldCode`, that field's and the visit. */
  async listServices(fieldCode?: string): Promise<ServiceView[]> {
    const rows = await this.db
      .select({ service: services, fieldCode: treatmentFields.code })
      .from(services)
      .leftJoin(treatmentFields, eq(treatmentFields.id, services.fieldId))
      .where(
        and(
          isNull(services.deletedAt),
          sql`(${services.fieldId} IS NULL OR ${treatmentFields.deletedAt} IS NULL)`,
          ...(fieldCode === undefined
            ? []
            : [sql`(${services.kind} = 'visit' OR ${treatmentFields.code} = ${fieldCode})`]),
        ),
      )
      .orderBy(
        sql`${services.kind} = 'visit' DESC`,
        asc(treatmentFields.sortOrder),
        asc(services.name),
      );
    return rows.map((r) => this.serviceView(r.service, r.fieldCode));
  }

  // --- fields -------------------------------------------------------------------------

  async createField(
    actor: Actor,
    access: EffectiveAccess,
    input: z.output<typeof createTreatmentFieldSchema>,
  ): Promise<TreatmentFieldView> {
    this.require(access);
    return this.db.transaction(async (tx) => {
      const [row] = await this.unique(() =>
        tx
          .insert(treatmentFields)
          .values({
            code: input.code,
            name: input.name,
            sortOrder: input.sortOrder ?? 0,
            createdBy: actor.accountId,
          })
          .returning(),
      );
      if (!row) throw new Error('field insert returned nothing');
      await this.audit.record(
        {
          actor,
          action: 'catalog.treatment_field_created',
          entityType: 'treatment_field',
          entityId: row.id,
          after: fieldView(row),
          reason: input.reason,
        },
        tx,
      );
      return fieldView(row);
    });
  }

  async updateField(
    actor: Actor,
    access: EffectiveAccess,
    code: string,
    input: z.output<typeof updateTreatmentFieldSchema>,
  ): Promise<TreatmentFieldView> {
    this.require(access);
    return this.db.transaction(async (tx) => {
      const before = await this.activeField(tx, code);
      const set: Partial<typeof treatmentFields.$inferInsert> = {};
      if (input.name !== undefined) set.name = input.name;
      if (input.sortOrder !== undefined) set.sortOrder = input.sortOrder;
      let after = before;
      if (Object.keys(set).length > 0) {
        const [row] = await this.unique(() =>
          tx.update(treatmentFields).set(set).where(eq(treatmentFields.id, before.id)).returning(),
        );
        if (!row) throw new Error('field update returned nothing');
        after = row;
      }
      await this.audit.record(
        {
          actor,
          action: 'catalog.treatment_field_updated',
          entityType: 'treatment_field',
          entityId: before.id,
          before: fieldView(before),
          after: fieldView(after),
          reason: input.reason,
        },
        tx,
      );
      await this.announce(tx, 'treatment_field', before.code);
      return fieldView(after);
    });
  }

  /**
   * Retires a field: centers and doctors can no longer pick it, and its services take no
   * new price and quote nothing (ADR-024). Stored choices and prices stay, as history.
   */
  async retireField(
    actor: Actor,
    access: EffectiveAccess,
    code: string,
    reason: string,
  ): Promise<void> {
    this.require(access);
    await this.db.transaction(async (tx) => {
      const before = await this.activeField(tx, code);
      await tx
        .update(treatmentFields)
        .set({ deletedAt: sql`now()` })
        .where(eq(treatmentFields.id, before.id));
      await this.audit.record(
        {
          actor,
          action: 'catalog.treatment_field_retired',
          entityType: 'treatment_field',
          entityId: before.id,
          before: fieldView(before),
          reason,
        },
        tx,
      );
      await this.announce(tx, 'treatment_field', before.code);
    });
  }

  // --- services -----------------------------------------------------------------------

  async createService(
    actor: Actor,
    access: EffectiveAccess,
    input: z.output<typeof createServiceSchema>,
  ): Promise<ServiceView> {
    this.require(access);
    return this.db.transaction(async (tx) => {
      // The field must stay active until the service is in.
      const field = await this.activeField(tx, input.fieldCode, true);
      const [row] = await this.unique(() =>
        tx
          .insert(services)
          .values({
            fieldId: field.id,
            code: input.code,
            name: input.name,
            kind: 'standard',
            costKind: input.costKind ?? 'wage',
            createdBy: actor.accountId,
          })
          .returning(),
      );
      if (!row) throw new Error('service insert returned nothing');
      const view = this.serviceView(row, field.code);
      await this.audit.record(
        {
          actor,
          action: 'catalog.service_created',
          entityType: 'service',
          entityId: row.id,
          after: view,
          reason: input.reason,
        },
        tx,
      );
      return view;
    });
  }

  async updateService(
    actor: Actor,
    access: EffectiveAccess,
    code: string,
    input: z.output<typeof updateServiceSchema>,
  ): Promise<ServiceView> {
    this.require(access);
    return this.db.transaction(async (tx) => {
      const { service: before, fieldCode } = await this.activeService(tx, code);
      let after = before;
      if (input.name !== undefined || input.costKind !== undefined) {
        const [row] = await this.unique(() =>
          tx
            .update(services)
            .set({
              ...(input.name === undefined ? {} : { name: input.name }),
              ...(input.costKind === undefined ? {} : { costKind: input.costKind }),
            })
            .where(eq(services.id, before.id))
            .returning(),
        );
        if (!row) throw new Error('service update returned nothing');
        after = row;
      }
      await this.audit.record(
        {
          actor,
          action: 'catalog.service_updated',
          entityType: 'service',
          entityId: before.id,
          before: this.serviceView(before, fieldCode),
          after: this.serviceView(after, fieldCode),
          reason: input.reason,
        },
        tx,
      );
      await this.announce(tx, 'service', before.code);
      return this.serviceView(after, fieldCode);
    });
  }

  /** Retires a service; the visit never (the database refuses it too). */
  async retireService(
    actor: Actor,
    access: EffectiveAccess,
    code: string,
    reason: string,
  ): Promise<void> {
    this.require(access);
    await this.db.transaction(async (tx) => {
      const { service, fieldCode } = await this.activeService(tx, code);
      if (service.kind === 'visit') throw new ConflictException({ error: 'visit_is_permanent' });
      await tx
        .update(services)
        .set({ deletedAt: sql`now()` })
        .where(eq(services.id, service.id));
      await this.audit.record(
        {
          actor,
          action: 'catalog.service_retired',
          entityType: 'service',
          entityId: service.id,
          before: this.serviceView(service, fieldCode),
          reason,
        },
        tx,
      );
      await this.announce(tx, 'service', service.code);
    });
  }

  /**
   * A field or service was renamed or retired: every search entry that shows it changes
   * (task 2-7). A new one changes none until a doctor picks it or a price is set.
   */
  private announce(tx: Tx, kind: 'treatment_field' | 'service', code: string) {
    return this.outbox.publish(
      {
        type: 'catalog.catalog_item_changed',
        aggregateType: kind,
        aggregateId: code,
        payload: { kind, code },
      },
      tx,
    );
  }

  // --- helpers ------------------------------------------------------------------------

  private require(access: EffectiveAccess) {
    if (!access.permissions.has(MANAGE)) {
      throw new ForbiddenException({ error: 'permission_required', permission: MANAGE });
    }
  }

  private serviceView(row: ServiceRow, fieldCode: string | null): ServiceView {
    return { code: row.code, name: row.name, kind: row.kind, costKind: row.costKind, fieldCode };
  }

  private async activeField(tx: Tx, code: string, share = false): Promise<FieldRow> {
    if (!CODE.test(code)) throw new NotFoundException({ error: 'treatment_field_not_found' });
    const query = tx
      .select()
      .from(treatmentFields)
      .where(and(eq(treatmentFields.code, code), isNull(treatmentFields.deletedAt)));
    const [row] = share ? await query.for('share') : await query.for('update');
    if (!row) throw new NotFoundException({ error: 'treatment_field_not_found' });
    return row;
  }

  private async activeService(
    tx: Tx,
    code: string,
  ): Promise<{ service: ServiceRow; fieldCode: string | null }> {
    if (!CODE.test(code)) throw new NotFoundException({ error: 'service_not_found' });
    const [row] = await tx
      .select({ service: services, fieldCode: treatmentFields.code })
      .from(services)
      .leftJoin(treatmentFields, eq(treatmentFields.id, services.fieldId))
      .where(and(eq(services.code, code), isNull(services.deletedAt)))
      .for('update', { of: services });
    if (!row) throw new NotFoundException({ error: 'service_not_found' });
    return row;
  }

  /** A code or name already in use becomes a clear 409. */
  private async unique<T>(write: () => Promise<T>): Promise<T> {
    try {
      return await write();
    } catch (error) {
      const pg = pgError(error);
      if (pg?.code === '23505') {
        const conflicts: Record<string, string> = {
          treatment_fields_code_key: 'duplicate_code',
          treatment_fields_name_key: 'duplicate_name',
          services_code_key: 'duplicate_code',
          services_name_key: 'duplicate_name',
        };
        const known = pg.constraint ? conflicts[pg.constraint] : undefined;
        if (known) throw new ConflictException({ error: known });
      }
      if (pg?.code === '23514') throw new BadRequestException({ error: 'invalid_value' });
      throw error;
    }
  }
}

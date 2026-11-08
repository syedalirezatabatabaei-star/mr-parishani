import {
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type {
  FormationDepositState,
  FormationDepositView,
  PermissionCode,
  recordFormationDepositRefundSchema,
  recordFormationDepositSchema,
} from '@sepehr/contracts';
import { and, eq, isNull } from 'drizzle-orm';
import type { z } from 'zod';
import type { EffectiveAccess } from '../../common/auth/access.port';
import { AUDIT_LOG, type Actor, type AuditLog } from '../../common/audit/audit.port';
import { CONFIG, type ConfigPort } from '../../common/config/config.port';
import {
  PROFORMA_DIRECTORY,
  type ProformaDirectory,
} from '../../common/proforma/proforma-directory.port';
import { WALLET, type WalletPort } from '../../common/wallet/wallet.port';
import { DATABASE, type Database } from '../../db/database.module';
import { creditApplications, creditFormationDeposits } from './credit.schema';

type DepositRow = typeof creditFormationDeposits.$inferSelect;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const RECORD: PermissionCode = 'credit.record_formation_deposit';
const READ: PermissionCode = 'credit.read_applications';

/** Only the last four characters of a bank reference leave the database (audit and view). */
const last4 = (value: string) => value.slice(-4);

const isUniqueViolation = (error: unknown) => {
  const e = error as { code?: string; cause?: { code?: string } } | null;
  return e?.code === '23505' || e?.cause?.code === '23505';
};

/**
 * The formation deposit (owner 1405/07/29, answer f): the pilot records its details only, with
 * no ledger row and nothing in the purse; the `deposit.held` account comes after the pilot with
 * its own ADR. Its amount is `credit.formation_deposit_rial`, "0" meaning off, and is locked on
 * the record with the configuration version (rule 16); case completion never types it.
 *
 * It is not refunded once the introduction letter is issued. TODO(decision): the system has no
 * such letter; the default is the purse's charge, the line it already draws for refunding the
 * origination fee (owner 4.7). Recording a refund locks the application FOR UPDATE, as a
 * cancellation does, so funding (FOR SHARE) and a refund never cross.
 */
@Injectable()
export class FormationDepositService {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(AUDIT_LOG) private readonly audit: AuditLog,
    @Inject(CONFIG) private readonly config: ConfigPort,
    @Inject(PROFORMA_DIRECTORY) private readonly proformas: ProformaDirectory,
    @Inject(WALLET) private readonly wallet: WalletPort,
  ) {}

  async state(
    access: EffectiveAccess,
    creditApplicationId: string,
  ): Promise<FormationDepositState> {
    if (!access.permissions.has(RECORD) && !access.permissions.has(READ)) {
      throw new ForbiddenException({ error: 'permission_required' });
    }
    await this.reachable(access, creditApplicationId);
    const configured = await this.config.resolve('credit.formation_deposit_rial');
    const row = await this.current(creditApplicationId);
    return {
      deposit: row ? await this.view(row) : null,
      configuredAmountRial: configured.value,
    };
  }

  async record(
    actor: Actor,
    access: EffectiveAccess,
    creditApplicationId: string,
    input: z.output<typeof recordFormationDepositSchema>,
  ): Promise<FormationDepositView> {
    this.require(access);
    const app = await this.reachable(access, creditApplicationId);
    const configured = await this.config.resolve('credit.formation_deposit_rial');
    const amount = BigInt(configured.value);
    if (amount <= 0n) throw new ConflictException({ error: 'formation_deposit_off' });
    const row = await this.db
      .transaction(async (tx) => {
        const [made] = await tx
          .insert(creditFormationDeposits)
          .values({
            creditApplicationId: app.id,
            amountRial: amount,
            configVersionId: configured.versionId,
            paidOn: input.paidOn,
            bankReference: input.bankReference,
            note: input.note ?? null,
            recordedBy: this.accountOf(actor),
          })
          .returning();
        if (!made) throw new Error('formation deposit insert returned nothing');
        await this.audit.record(
          {
            actor,
            action: 'credit.formation_deposit_recorded',
            entityType: 'credit_application',
            entityId: app.id,
            before: null,
            after: {
              depositId: made.id,
              amountRial: amount.toString(),
              configVersionId: configured.versionId,
              paidOn: input.paidOn,
              bankReferenceLast4: last4(input.bankReference),
            },
            reason: input.note ?? 'ثبت مشخصات بیعانه تشکیل',
          },
          tx,
        );
        return made;
      })
      .catch((error: unknown) => {
        if (isUniqueViolation(error)) throw new ConflictException({ error: 'deposit_exists' });
        throw error;
      });
    return this.view(row);
  }

  async recordRefund(
    actor: Actor,
    access: EffectiveAccess,
    creditApplicationId: string,
    input: z.output<typeof recordFormationDepositRefundSchema>,
  ): Promise<FormationDepositView> {
    this.require(access);
    const app = await this.reachable(access, creditApplicationId);
    const row = await this.db.transaction(async (tx) => {
      // The application first, as a cancellation locks it: funding holds it FOR SHARE.
      await tx
        .select({ id: creditApplications.id })
        .from(creditApplications)
        .where(eq(creditApplications.id, app.id))
        .for('update');
      const [deposit] = await tx
        .select()
        .from(creditFormationDeposits)
        .where(
          and(
            eq(creditFormationDeposits.creditApplicationId, app.id),
            isNull(creditFormationDeposits.deletedAt),
          ),
        )
        .for('update');
      if (!deposit) throw new NotFoundException({ error: 'deposit_not_found' });
      if (deposit.refundedAt !== null) throw new ConflictException({ error: 'already_refunded' });
      if (await this.wallet.purseOfApplication(app.id, tx)) {
        throw new ConflictException({ error: 'deposit_non_refundable' });
      }
      if (input.refundedOn < deposit.paidOn) {
        throw new ConflictException({ error: 'refund_before_payment' });
      }
      const [after] = await tx
        .update(creditFormationDeposits)
        .set({
          refundedOn: input.refundedOn,
          refundReference: input.refundReference,
          refundReason: input.reason,
          refundedBy: this.accountOf(actor),
          refundedAt: new Date(),
        })
        .where(eq(creditFormationDeposits.id, deposit.id))
        .returning();
      if (!after) throw new Error('formation deposit update returned nothing');
      await this.audit.record(
        {
          actor,
          action: 'credit.formation_deposit_refund_recorded',
          entityType: 'credit_application',
          entityId: app.id,
          before: { depositId: deposit.id, refunded: false },
          after: {
            depositId: deposit.id,
            refunded: true,
            refundedOn: input.refundedOn,
            refundReferenceLast4: last4(input.refundReference),
          },
          reason: input.reason,
        },
        tx,
      );
      return after;
    });
    return this.view(row);
  }

  // --- helpers -------------------------------------------------------------------------

  private require(access: EffectiveAccess) {
    if (!access.permissions.has(RECORD)) {
      throw new ForbiddenException({ error: 'permission_required', permission: RECORD });
    }
  }

  /** Only a person records a deposit (staff always have an account). */
  private accountOf(actor: Actor): string {
    if (actor.accountId === null) throw new ForbiddenException({ error: 'staff_only' });
    return actor.accountId;
  }

  private async current(creditApplicationId: string) {
    const [row] = await this.db
      .select()
      .from(creditFormationDeposits)
      .where(
        and(
          eq(creditFormationDeposits.creditApplicationId, creditApplicationId),
          isNull(creditFormationDeposits.deletedAt),
        ),
      );
    return row ?? null;
  }

  private async view(row: DepositRow): Promise<FormationDepositView> {
    const funded = (await this.wallet.purseOfApplication(row.creditApplicationId)) !== null;
    return {
      id: row.id,
      creditApplicationId: row.creditApplicationId,
      amountRial: row.amountRial.toString(),
      paidOn: row.paidOn,
      bankReferenceLast4: last4(row.bankReference),
      note: row.note,
      recordedAt: row.createdAt.toISOString(),
      refund:
        row.refundedAt === null
          ? null
          : {
              refundedOn: row.refundedOn ?? '',
              refundReferenceLast4: last4(row.refundReference ?? ''),
              reason: row.refundReason ?? '',
              recordedAt: row.refundedAt.toISOString(),
            },
      refundable: row.refundedAt === null && !funded,
    };
  }

  /** Staff reach an application of their city (its proforma's), or any with a global scope. */
  private async reachable(access: EffectiveAccess, creditApplicationId: string) {
    const missing = () => new NotFoundException({ error: 'credit_application_not_found' });
    if (!UUID.test(creditApplicationId)) throw missing();
    const [app] = await this.db
      .select()
      .from(creditApplications)
      .where(eq(creditApplications.id, creditApplicationId));
    if (!app || app.deletedAt) throw missing();
    if (access.scopes.some((s) => s.kind === 'global')) return app;
    const proforma = await this.proformas.proforma(app.proformaId);
    const cities = access.scopes.flatMap((s) => (s.kind === 'city' ? [s.code] : []));
    if (!proforma || !cities.includes(proforma.cityCode)) throw missing();
    return app;
  }
}

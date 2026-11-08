import { Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { payableDue, rateValue, serviceFee } from '@sepehr/contracts';
import { sql } from 'drizzle-orm';
import {
  AUDIT_LOG,
  type Actor,
  type AuditLog,
  type SqlExecutor,
} from '../../common/audit/audit.port';
import {
  WORKPLACE_DIRECTORY,
  type WorkplaceDirectory,
} from '../../common/catalog/workplace-directory.port';
import { CONFIG, type ConfigPort } from '../../common/config/config.port';
import { OUTBOX, type OutboxPort } from '../../common/events/outbox.port';
import { assertIncomeEntity } from '../../common/ledger/income-entities';
import { LEDGER, type LedgerPort } from '../../common/ledger/ledger.port';
import {
  SERVICE_DELIVERIES,
  type ServiceDeliveries,
} from '../../common/service/service-deliveries.port';
import { WALLET, type WalletPort } from '../../common/wallet/wallet.port';
import { DATABASE, type Database } from '../../db/database.module';

/** The settlement module's own actor for what the worker does on its own. */
export const SETTLEMENT_ACTOR: Actor = {
  accountId: null,
  sessionId: null,
  ip: null,
  roles: ['settlement'],
};

/** The keys of one service's steps (rule 5): `settlement:{authorizationId}:{step}`. */
export const settlementKey = (authorizationId: string, step: 'finalize' | 'fee') =>
  `settlement:${authorizationId}:${step}`;

export interface Accrued {
  readonly payableId: string;
  readonly created: boolean;
}

/**
 * A doctor's payable and the credit service's fee (task 5-1 [financial]; doc 06 §1, §3;
 * doc 14 الف, ب; owner 1405/07/14). For each service that became final, once:
 *
 *   1. phase 1's finalize moves it on the purse's chain to the doctor (Dr
 *      purse.consumed_pending / Cr doctor.payable, owner the doctor's node); the purse is
 *      locked FOR UPDATE there, so two deliveries of one event wait for each other;
 *   2. the contract cycle and the fee rate, resolved for the service's doctor, center and
 *      treatment field AT the moment it became final, are locked on the records (rule 16);
 *      a change later moves only services after it (CLAUDE.md §4);
 *   3. the fee: a percent rounded down to the rial, or a fixed amount; when above 0, Dr
 *      doctor.fee_receivable (the doctor's node) / Cr company.fee_income, Aramesh only
 *      (ADR-007); 0 posts nothing but still locks its rate on its row;
 *   4. the payable and the fee, due on the Tehran day + the cycle in Jalali months, stored
 *      in UTC.
 */
@Injectable()
export class SettlementService {
  private readonly logger = new Logger(SettlementService.name);

  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(AUDIT_LOG) private readonly audit: AuditLog,
    @Inject(OUTBOX) private readonly outbox: OutboxPort,
    @Inject(CONFIG) private readonly config: ConfigPort,
    @Inject(LEDGER) private readonly ledger: LedgerPort,
    @Inject(WALLET) private readonly wallet: WalletPort,
    @Inject(SERVICE_DELIVERIES) private readonly deliveries: ServiceDeliveries,
    @Inject(WORKPLACE_DIRECTORY) private readonly workplaces: WorkplaceDirectory,
  ) {}

  async accrue(actor: Actor, authorizationId: string, tx?: SqlExecutor): Promise<Accrued> {
    const run = async (ex: SqlExecutor): Promise<Accrued> => {
      const service = await this.deliveries.finalized(authorizationId, ex);
      if (!service) throw new NotFoundException({ error: 'service_not_final' });

      // 1. The purse's lock first: everything after it is serialized per purse.
      const moved = await this.wallet.finalize(
        actor,
        service.purseId,
        {
          idempotencyKey: settlementKey(service.authorizationId, 'finalize'),
          authorizationId: service.authorizationId,
          amountRial: service.amountRial,
        },
        ex,
      );
      const earlier = await ex.execute(sql`
        SELECT id FROM doctor_payables WHERE service_delivery_id = ${service.authorizationId}
      `);
      const done = earlier.rows[0]?.['id'] as string | undefined;
      if (done) return { payableId: done, created: false };
      if (!moved.journalEntryId) throw new Error('finalize posted nothing');

      // 2. What the doctor's contract says, as of the moment the service became final.
      const workplace = await this.workplaces.workplace(service.workplaceId, ex);
      if (!workplace) throw new NotFoundException({ error: 'workplace_not_found' });
      const purse = await this.wallet.summary(service.purseId, ex);
      const scope = {
        doctorNodeId: service.doctorNodeId,
        centerNodeId: service.centerNodeId,
        treatmentFieldCode: service.treatmentFieldCode,
      };
      const [cycle, rate] = await Promise.all([
        this.config.resolve('settlement.contract_cycle_months', scope, service.finalizedAt),
        this.config.resolve('settlement.credit_service_fee', scope, service.finalizedAt),
      ]);
      const due = payableDue(service.finalizedAt, cycle.value);

      // 3. The fee.
      const fee = serviceFee(service.amountRial, rate.value);
      let feeJournal: string | null = null;
      if (fee > 0n) {
        assertIncomeEntity(purse.entityId);
        const receivable = await this.ledger.openAccount(
          {
            entityId: purse.entityId,
            code: 'doctor.fee_receivable',
            name: 'کارمزد قابل دریافت از پزشک',
            kind: 'asset',
            ownerType: 'doctor',
            ownerId: service.doctorNodeId,
          },
          ex,
        );
        const income = await this.ledger.openAccount(
          {
            entityId: purse.entityId,
            code: 'company.fee_income',
            name: 'درآمد کارمزد',
            kind: 'income',
            ownerType: 'company',
            ownerId: null,
          },
          ex,
        );
        feeJournal = (
          await this.ledger.postJournal(
            actor,
            {
              entityId: purse.entityId,
              eventType: 'settlement.credit_service_fee',
              occurredAt: service.finalizedAt,
              idempotencyKey: settlementKey(service.authorizationId, 'fee'),
              caseId: purse.caseId,
              creditApplicationId: service.creditApplicationId,
              lines: [
                { accountId: receivable.id, direction: 'debit', amountRial: fee },
                { accountId: income.id, direction: 'credit', amountRial: fee },
              ],
            },
            ex,
          )
        ).id;
      }

      // 4. The records, the rate and the cycle locked on them.
      const made = await ex.execute(sql`
        INSERT INTO doctor_payables (
          service_delivery_id, doctor_id, doctor_node_id, center_id, workplace_id, case_id,
          purse_id, entity_id, amount_rial, finalized_at, contract_cycle_months,
          cycle_config_version_id, due_at, wallet_operation_id, journal_entry_id
        ) VALUES (
          ${service.authorizationId}, ${workplace.doctorId}, ${service.doctorNodeId},
          ${workplace.centerId}, ${service.workplaceId}, ${purse.caseId}, ${service.purseId},
          ${purse.entityId}, ${service.amountRial}, ${service.finalizedAt}, ${cycle.value},
          ${cycle.versionId}, ${due.dueAt}, ${moved.operationId}, ${moved.journalEntryId}
        )
        RETURNING id
      `);
      const payableId = made.rows[0]?.['id'] as string;
      await ex.execute(sql`
        INSERT INTO service_fees (
          kind, doctor_payable_id, doctor_id, doctor_node_id, entity_id, basis, rate_value,
          config_version_id, amount_rial, due_at, journal_entry_id
        ) VALUES (
          'credit', ${payableId}, ${workplace.doctorId}, ${service.doctorNodeId},
          ${purse.entityId}, ${rate.value.basis}, ${rateValue(rate.value)}, ${rate.versionId},
          ${fee}, ${due.dueAt}, ${feeJournal}
        )
      `);
      await this.audit.record(
        {
          actor,
          action: 'settlement.payable_accrued',
          entityType: 'doctor_payable',
          entityId: payableId,
          after: {
            serviceDeliveryId: service.authorizationId,
            amountRial: service.amountRial.toString(),
            feeRial: fee.toString(),
            feeBasis: rate.value.basis,
            feeRate: rateValue(rate.value),
            cycleMonths: cycle.value,
            dueAt: due.dueAt.toISOString(),
          },
        },
        ex,
      );
      await this.outbox.publish(
        {
          type: 'settlement.payable_accrued',
          aggregateType: 'doctor_payable',
          aggregateId: payableId,
          payload: {
            payableId,
            serviceDeliveryId: service.authorizationId,
            doctorNodeId: service.doctorNodeId,
            amountRial: service.amountRial.toString(),
            feeRial: fee.toString(),
            dueAt: due.dueAt.toISOString(),
          },
        },
        ex,
      );
      return { payableId, created: true };
    };
    return tx ? run(tx) : this.db.transaction((own) => run(own));
  }

  /**
   * What may be paid now (task 5-2; 5-4's statement reads it): a doctor's payables and fees
   * that are due. One held by a dispute (on_hold) is never among them (doc 02 §8 test 7).
   */
  async payableItems(
    doctorNodeId: string,
    tx?: SqlExecutor,
  ): Promise<{ payables: string[]; fees: string[] }> {
    const ex = tx ?? this.db;
    const payables = await ex.execute(sql`
      SELECT id FROM doctor_payables WHERE doctor_node_id = ${doctorNodeId} AND status = 'due'
      ORDER BY due_at, id
    `);
    const fees = await ex.execute(sql`
      SELECT id FROM service_fees WHERE doctor_node_id = ${doctorNodeId} AND status = 'due'
      ORDER BY due_at, id
    `);
    return {
      payables: payables.rows.map((r) => r['id'] as string),
      fees: fees.rows.map((r) => r['id'] as string),
    };
  }

  /**
   * The daily move accrued → due, once the due moment has come (doc 14 ب): only forward,
   * only through the state machine (rule 8). Returns how many moved.
   */
  async markDue(now = new Date()): Promise<{ payables: number; fees: number }> {
    return this.db.transaction(async (tx) => {
      const payables = await tx.execute(sql`
        UPDATE doctor_payables SET status = 'due'
        WHERE status = 'accrued' AND due_at <= ${now}
        RETURNING id
      `);
      const fees = await tx.execute(sql`
        UPDATE service_fees SET status = 'due'
        WHERE status = 'accrued' AND due_at <= ${now}
        RETURNING id
      `);
      return { payables: payables.rows.length, fees: fees.rows.length };
    });
  }

  /**
   * Every service final before this task, each in its own transaction (owner: once, by
   * CLI). Running it again makes nothing. Counts only (rule 30).
   */
  async backfill(actor: Actor): Promise<{ seen: number; made: number; failed: number }> {
    let after: string | null = null;
    let seen = 0;
    let made = 0;
    let failed = 0;
    for (;;) {
      const page = await this.deliveries.finalizedAfter(after, 200);
      if (page.length === 0) break;
      for (const service of page) {
        seen += 1;
        try {
          if ((await this.accrue(actor, service.authorizationId)).created) made += 1;
        } catch (error) {
          failed += 1;
          this.logger.error(`payable not made: ${(error as Error).message}`);
        }
      }
      after = page.at(-1)?.authorizationId ?? null;
    }
    return { seen, made, failed };
  }
}

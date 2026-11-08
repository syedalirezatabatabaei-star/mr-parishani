import { FINANCIAL_STEP_UP, type FinancialStepUp } from '../../common/auth/step-up.port';
import {
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import {
  gregorianDayOf,
  payableDue,
  providerContractEnded,
  providerContractEndsOn,
  rateValue,
  serviceFee,
  toJalali,
  type CashServiceSource,
  type CashServiceStatus,
  type CashServiceView,
  type PermissionCode,
  type RecordCashService,
} from '@sepehr/contracts';
import { sql } from 'drizzle-orm';
import type { EffectiveAccess } from '../../common/auth/access.port';
import { AUDIT_LOG, type Actor, type AuditLog } from '../../common/audit/audit.port';
import {
  REFERRAL_DIRECTORY,
  type ReferralDirectory,
} from '../../common/booking/referral-directory.port';
import {
  WORKPLACE_DIRECTORY,
  type WorkplaceDirectory,
  type WorkplaceRecord,
} from '../../common/catalog/workplace-directory.port';
import { CONFIG, type ConfigPort } from '../../common/config/config.port';
import { OUTBOX, type OutboxPort } from '../../common/events/outbox.port';
import { LEAD_CASES, type LeadCases } from '../../common/lead/lead-cases.port';
import { assertIncomeEntity } from '../../common/ledger/income-entities';
import { LEDGER, type LedgerPort } from '../../common/ledger/ledger.port';
import { DATABASE, type Database } from '../../db/database.module';

type Tx = Parameters<Parameters<Database['transaction']>[0]>[0];

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const notFound = () => new NotFoundException({ error: 'cash_service_not_found' });
const conflict = (error: string, detail?: Record<string, unknown>) =>
  new ConflictException({ error, ...detail });

const RECORD: PermissionCode = 'settlement.record_cash_service';
const CONFIRM: PermissionCode = 'settlement.confirm_cash_service';
/** The doctor's side: whoever authorizes services at the workplace (the doctor, a secretary). */
const DOCTOR: PermissionCode = 'service.authorize';

/** The key of a cash fee's document (rule 5). */
export const cashFeeKey = (cashServiceId: string) => `settlement:cash:${cashServiceId}:fee`;

/** The first moment of a Tehran day given as YYYY-MM-DD (Iran keeps +03:30 all year). */
const tehranStart = (day: string) => new Date(`${day}T00:00:00+03:30`);

interface Row {
  id: string;
  referral_id: string;
  /** The referral's case, if any: whose advisor may see it (R18). */
  case_id: string | null;
  doctor_id: string;
  doctor_node_id: string;
  workplace_id: string;
  center_node_id: string;
  treatment_field_code: string;
  service_date: string;
  amount_rial: string;
  source: CashServiceSource;
  status: CashServiceStatus;
  recorded_by: string;
  recorded_at: string;
  decided_at: string | null;
  decision_reason: string | null;
  idempotency_key: string;
}

const iso = (c: string) =>
  `to_char(${c} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS ${c}`;
const COLUMNS =
  sql.raw(`id, referral_id, case_id, doctor_id, doctor_node_id, workplace_id, center_node_id,
  treatment_field_code, service_date::text AS service_date, amount_rial::text AS amount_rial,
  source, status, recorded_by, ${iso('recorded_at')}, ${iso('decided_at')}, decision_reason,
  idempotency_key`);

/**
 * Cash services and their fee (task 5-3 [financial]; doc 06 §4; doc 14 ت; client answers
 * 1405/07/10 §3; ADR-037):
 *
 * - recorded only with a referral to this very doctor, on a day not before it and not ahead
 *   of today; at any time after it (no window, no attribution by time);
 * - the doctor's side (who authorizes services at the workplace) declares it: confirmed at
 *   once; an advisor or accounting records it: it waits for the doctor's side or accounting,
 *   never the one who recorded it; the doctor's side may dispute such a record, and then only
 *   accounting decides it;
 * - confirmed, it gets its fee: the cash rate and the cycle resolved for the doctor, center
 *   and treatment field on the service's day and locked on the fee; due on that day + the
 *   cycle, in UTC; above 0, Dr doctor.fee_receivable / Cr company.fee_income (Aramesh only).
 *
 * Locks: the cash service FOR UPDATE, then its fee (unique per service).
 */
@Injectable()
export class CashServiceService {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(AUDIT_LOG) private readonly audit: AuditLog,
    @Inject(OUTBOX) private readonly outbox: OutboxPort,
    @Inject(CONFIG) private readonly config: ConfigPort,
    @Inject(LEDGER) private readonly ledger: LedgerPort,
    @Inject(REFERRAL_DIRECTORY) private readonly referrals: ReferralDirectory,
    @Inject(WORKPLACE_DIRECTORY) private readonly workplaces: WorkplaceDirectory,
    @Inject(LEAD_CASES) private readonly leads: LeadCases,
    @Inject(FINANCIAL_STEP_UP) private readonly stepUp: FinancialStepUp,
  ) {}

  async record(
    actor: Actor,
    access: EffectiveAccess,
    input: RecordCashService,
    now = new Date(),
  ): Promise<CashServiceView> {
    const referral = await this.referrals.referral(input.referralId);
    if (!referral) throw new NotFoundException({ error: 'referral_not_found' });
    const workplace = await this.workplaces.workplace(input.workplaceId ?? referral.workplaceId);
    // Owner: only with a referral to this very doctor.
    if (!workplace || workplace.doctorId !== referral.doctorId) {
      throw conflict('no_referral_to_this_doctor');
    }
    const doctorSide = this.isDoctorSide(access, workplace);
    if (!doctorSide && !access.permissions.has(RECORD)) {
      throw new ForbiddenException({ error: 'permission_required', permission: RECORD });
    }
    // R18 (owner 1405/07/18): beyond a city, an advisor's own scope reaches only the referrals
    // of the cases assigned to it now; anything else, or a referral without a case, is not found.
    const byOwnCase = !doctorSide && !this.inCity(access, workplace);
    if (byOwnCase && !(await this.ownsCase(actor, access, referral.caseId))) throw notFound();
    const today = gregorianDayOf(toJalali(now));
    if (input.serviceDate > today) {
      throw new UnprocessableEntityException({ error: 'service_date_in_future' });
    }
    if (input.serviceDate < gregorianDayOf(toJalali(referral.referredAt))) {
      throw conflict('service_before_referral');
    }
    const field = await this.fieldOf(referral.caseId, workplace);
    // ADR-046 (owner 1405/07/27): a service on or after the contract term's end is not recorded.
    const { value: term } = await this.config.resolve(
      'settlement.provider_contract',
      {
        doctorNodeId: workplace.nodeId,
        centerNodeId: workplace.centerId ?? workplace.nodeId,
        treatmentFieldCode: field,
      },
      now,
    );
    if (providerContractEnded(term, input.serviceDate)) {
      throw conflict('provider_contract_ended', { endsOn: providerContractEndsOn(term) });
    }
    const source: CashServiceSource = doctorSide ? 'doctor_declared' : 'advisor_recorded';
    // ADR-052: who records a cash service signs it with their own SMS code.
    await this.stepUp.assert(actor, {
      type: 'cash_service',
      id: input.referralId,
      amountRial: BigInt(input.amountRial),
      step: 'request',
    });

    const row = await this.db.transaction(async (tx) => {
      // Again in the transaction: a case moved to another advisor meanwhile is not its own.
      if (byOwnCase && !(await this.ownsCase(actor, access, referral.caseId, tx))) {
        throw notFound();
      }
      const earlier = (
        await tx.execute(
          sql`SELECT ${COLUMNS} FROM cash_services WHERE idempotency_key = ${input.idempotencyKey}`,
        )
      ).rows[0] as unknown as Row | undefined;
      if (earlier) {
        const same =
          earlier.referral_id === input.referralId &&
          earlier.workplace_id === workplace.id &&
          earlier.service_date === input.serviceDate &&
          earlier.amount_rial === input.amountRial;
        if (!same) throw conflict('idempotency_key_reused');
        return earlier;
      }
      const made = await tx.execute(sql`
        INSERT INTO cash_services (
          referral_id, person_id, case_id, doctor_id, doctor_node_id, workplace_id,
          center_node_id, treatment_field_code, service_date, amount_rial, source, status,
          recorded_by, decided_at, idempotency_key
        ) VALUES (
          ${referral.referralId}, ${referral.personId}, ${referral.caseId}, ${workplace.doctorId},
          ${workplace.nodeId}, ${workplace.id}, ${workplace.centerId ?? workplace.nodeId},
          ${field}, ${input.serviceDate}::date, ${BigInt(input.amountRial)}, ${source},
          ${doctorSide ? 'confirmed' : 'recorded'}, ${actor.accountId},
          ${doctorSide ? now : null}, ${input.idempotencyKey}
        )
        RETURNING ${COLUMNS}
      `);
      const created = made.rows[0] as unknown as Row;
      await this.audit.record(
        {
          actor,
          action: 'settlement.cash_service_recorded',
          entityType: 'cash_service',
          entityId: created.id,
          after: {
            referralId: referral.referralId,
            serviceDate: input.serviceDate,
            amountRial: input.amountRial,
            source,
          },
        },
        tx,
      );
      await this.outbox.publish(
        {
          type: 'settlement.cash_service_recorded',
          aggregateType: 'cash_service',
          aggregateId: created.id,
          payload: { cashServiceId: created.id, doctorId: created.doctor_id, source },
        },
        tx,
      );
      // The doctor's own word is their confirmation: the fee at once.
      if (doctorSide) await this.makeFee(tx, actor, created, now);
      return created;
    });
    return this.view(row, actor.accountId);
  }

  /** Confirms (its fee made) or voids a recorded or disputed service; never its recorder. */
  async decide(
    actor: Actor,
    access: EffectiveAccess,
    id: string,
    outcome: 'confirm' | 'void',
    reason: string,
    now = new Date(),
  ): Promise<CashServiceView> {
    const reached = await this.find(this.db, id);
    const workplace = await this.workplaces.workplace(reached.workplace_id);
    if (!workplace) throw notFound();
    const doctorSide = this.isDoctorSide(access, workplace);
    if (!doctorSide && !access.permissions.has(CONFIRM)) {
      throw new ForbiddenException({ error: 'permission_required', permission: CONFIRM });
    }
    if (outcome === 'confirm') {
      // ADR-052: confirming is signed with the confirmer's own SMS code.
      await this.stepUp.assert(actor, {
        type: 'cash_service',
        id,
        amountRial: BigInt(reached.amount_rial),
        step: 'approve',
      });
    }
    if (!doctorSide && !this.inCity(access, workplace)) throw notFound();
    const row = await this.db.transaction(async (tx) => {
      const service = await this.lock(tx, id);
      const final = outcome === 'confirm' ? 'confirmed' : 'voided';
      if (service.status === final) return service;
      if (service.status !== 'recorded' && service.status !== 'disputed') {
        throw conflict('cash_service_decided', { status: service.status });
      }
      // Never the one who recorded it; a disputed one only by accounting (not the doctor).
      if (service.recorded_by === actor.accountId) throw conflict('same_person');
      if (service.status === 'disputed' && !access.permissions.has(CONFIRM)) {
        throw new ForbiddenException({ error: 'permission_required', permission: CONFIRM });
      }
      const done = (
        await tx.execute(sql`
          UPDATE cash_services
          SET status = ${final}, decided_by = ${actor.accountId}, decided_at = ${now},
              decision_reason = ${reason}
          WHERE id = ${id}
          RETURNING ${COLUMNS}
        `)
      ).rows[0] as unknown as Row;
      if (final === 'confirmed') await this.makeFee(tx, actor, done, now);
      await this.decided(tx, actor, done, service.status, reason);
      return done;
    });
    return this.view(row, actor.accountId);
  }

  /** The doctor's side disputes an advisor's record before it is confirmed. */
  async dispute(
    actor: Actor,
    access: EffectiveAccess,
    id: string,
    reason: string,
  ): Promise<CashServiceView> {
    const reached = await this.find(this.db, id);
    const workplace = await this.workplaces.workplace(reached.workplace_id);
    if (!workplace || !this.isDoctorSide(access, workplace)) throw notFound();
    const row = await this.db.transaction(async (tx) => {
      const service = await this.lock(tx, id);
      if (service.status === 'disputed') return service;
      if (service.status !== 'recorded') {
        throw conflict('cash_service_decided', { status: service.status });
      }
      const done = (
        await tx.execute(sql`
          UPDATE cash_services SET status = 'disputed', decision_reason = ${reason}
          WHERE id = ${id} RETURNING ${COLUMNS}
        `)
      ).rows[0] as unknown as Row;
      await this.decided(tx, actor, done, 'recorded', reason);
      return done;
    });
    return this.view(row, actor.accountId);
  }

  async list(
    actor: Actor,
    access: EffectiveAccess,
    query: { status?: CashServiceStatus | undefined },
  ): Promise<CashServiceView[]> {
    const rows = await this.db.execute(sql`
      SELECT ${COLUMNS} FROM cash_services
      WHERE (${query.status ?? null}::text IS NULL OR status = ${query.status ?? null})
      ORDER BY recorded_at DESC LIMIT 500
    `);
    const out: CashServiceView[] = [];
    const staff = access.permissions.has(RECORD) || access.permissions.has(CONFIRM);
    for (const r of rows.rows as unknown as Row[]) {
      const workplace = await this.workplaces.workplace(r.workplace_id);
      if (!workplace) continue;
      const ok =
        this.isDoctorSide(access, workplace) ||
        (staff &&
          (this.inCity(access, workplace) || (await this.ownsCase(actor, access, r.case_id))));
      if (ok) out.push(await this.view(r, actor.accountId));
    }
    return out;
  }

  // --- helpers -------------------------------------------------------------------------

  /** The cash fee of a confirmed service, once (unique per service; keyed document). */
  private async makeFee(tx: Tx, actor: Actor, service: Row, now: Date): Promise<void> {
    const exists = await tx.execute(
      sql`SELECT 1 FROM service_fees WHERE cash_service_id = ${service.id}`,
    );
    if (exists.rows.length > 0) return;
    const day = tehranStart(service.service_date);
    // The rate and the cycle in force at the end of the service's day (or now, while it is
    // still that day): a change counts for services of its day and after, never before.
    const endOfDay = new Date(day.getTime() + 86_400_000 - 1);
    const at = now < endOfDay ? now : endOfDay;
    const scope = {
      doctorNodeId: service.doctor_node_id,
      centerNodeId: service.center_node_id,
      treatmentFieldCode: service.treatment_field_code,
    };
    const [rate, cycle, template] = await Promise.all([
      this.config.resolve('settlement.cash_service_fee', scope, at),
      this.config.resolve('settlement.contract_cycle_months', scope, at),
      this.config.resolve('contract.loan_template', {}, at),
    ]);
    const entityId = template.value.lender.entityId;
    // Income only to an entity that may earn it (ADR-007).
    assertIncomeEntity(entityId);
    const due = payableDue(day, cycle.value);
    const fee = serviceFee(BigInt(service.amount_rial), rate.value);
    let journal: string | null = null;
    if (fee > 0n) {
      const receivable = await this.ledger.openAccount(
        {
          entityId,
          code: 'doctor.fee_receivable',
          name: 'کارمزد قابل دریافت از پزشک',
          kind: 'asset',
          ownerType: 'doctor',
          ownerId: service.doctor_node_id,
        },
        tx,
      );
      const income = await this.ledger.openAccount(
        {
          entityId,
          code: 'company.fee_income',
          name: 'درآمد کارمزد',
          kind: 'income',
          ownerType: 'company',
          ownerId: null,
        },
        tx,
      );
      journal = (
        await this.ledger.postJournal(
          actor,
          {
            entityId,
            eventType: 'settlement.cash_service_fee',
            occurredAt: day,
            idempotencyKey: cashFeeKey(service.id),
            lines: [
              { accountId: receivable.id, direction: 'debit', amountRial: fee },
              { accountId: income.id, direction: 'credit', amountRial: fee },
            ],
          },
          tx,
        )
      ).id;
    }
    await tx.execute(sql`
      INSERT INTO service_fees (
        kind, cash_service_id, doctor_id, doctor_node_id, entity_id, basis, rate_value,
        config_version_id, amount_rial, due_at, journal_entry_id
      ) VALUES (
        'cash', ${service.id}, ${service.doctor_id}, ${service.doctor_node_id}, ${entityId},
        ${rate.value.basis}, ${rateValue(rate.value)}, ${rate.versionId}, ${fee}, ${due.dueAt},
        ${journal}
      )
    `);
  }

  private async decided(
    tx: Tx,
    actor: Actor,
    service: Row,
    before: CashServiceStatus,
    reason: string,
  ): Promise<void> {
    await this.audit.record(
      {
        actor,
        action: `settlement.cash_service_${service.status}`,
        entityType: 'cash_service',
        entityId: service.id,
        before: { status: before },
        after: { status: service.status },
        reason,
      },
      tx,
    );
    await this.outbox.publish(
      {
        type: 'settlement.cash_service_decided',
        aggregateType: 'cash_service',
        aggregateId: service.id,
        payload: {
          cashServiceId: service.id,
          doctorId: service.doctor_id,
          status: service.status as 'confirmed' | 'voided' | 'disputed',
        },
      },
      tx,
    );
  }

  /** The case's treatment field; without a case, the doctor's first at the workplace. */
  private async fieldOf(caseId: string | null, workplace: WorkplaceRecord): Promise<string> {
    const facts = caseId ? await this.leads.caseFacts(caseId) : null;
    if (facts) return facts.treatmentFieldCode;
    const fields = await this.workplaces.doctorFieldCodes(workplace.id);
    const first = fields[0];
    if (!first) throw conflict('no_treatment_field');
    return first;
  }

  /** Who authorizes services at this workplace: the doctor, or a center's scope above it. */
  private isDoctorSide(access: EffectiveAccess, workplace: WorkplaceRecord): boolean {
    if (!access.permissions.has(DOCTOR)) return false;
    return access.scopes.some(
      (s) =>
        (s.kind === 'doctor' || s.kind === 'center' || s.kind === 'branch') &&
        (workplace.nodePath === s.path || workplace.nodePath.startsWith(`${s.path}.`)),
    );
  }

  /** An own scope, and the case assigned to the caller now (R18). */
  private async ownsCase(
    actor: Actor,
    access: EffectiveAccess,
    caseId: string | null,
    tx?: Tx,
  ): Promise<boolean> {
    if (caseId === null || actor.accountId === null) return false;
    if (!access.scopes.some((s) => s.kind === 'own')) return false;
    return (await this.leads.assigneeOf(caseId, tx)) === actor.accountId;
  }

  private inCity(access: EffectiveAccess, workplace: WorkplaceRecord): boolean {
    if (access.scopes.some((s) => s.kind === 'global')) return true;
    const cities = access.scopes.flatMap((s) => (s.kind === 'city' ? [s.code] : []));
    return cities.includes(workplace.cityCode);
  }

  private async find(ex: Database | Tx, id: string): Promise<Row> {
    if (!UUID.test(id)) throw notFound();
    const row = (await ex.execute(sql`SELECT ${COLUMNS} FROM cash_services WHERE id = ${id}`))
      .rows[0] as unknown as Row | undefined;
    if (!row) throw notFound();
    return row;
  }

  private async lock(tx: Tx, id: string): Promise<Row> {
    const row = (
      await tx.execute(sql`SELECT ${COLUMNS} FROM cash_services WHERE id = ${id} FOR UPDATE`)
    ).rows[0] as unknown as Row | undefined;
    if (!row) throw notFound();
    return row;
  }

  private async view(r: Row, viewer: string | null): Promise<CashServiceView> {
    const fee = (
      await this.db.execute(sql`
        SELECT id, amount_rial::text AS amount_rial, basis, rate_value, status,
               ${sql.raw(iso('due_at'))}
        FROM service_fees WHERE cash_service_id = ${r.id}
      `)
    ).rows[0];
    return {
      id: r.id,
      referralId: r.referral_id,
      doctorId: r.doctor_id,
      workplaceId: r.workplace_id,
      serviceDate: r.service_date,
      amountRial: r.amount_rial,
      source: r.source,
      status: r.status,
      recordedAt: r.recorded_at,
      recordedByMe: viewer !== null && r.recorded_by === viewer,
      decidedAt: r.decided_at,
      decisionReason: r.decision_reason,
      fee: fee
        ? {
            id: fee['id'] as string,
            amountRial: fee['amount_rial'] as string,
            basis: fee['basis'] as 'percent' | 'fixed',
            rateValue: fee['rate_value'] as string,
            dueAt: fee['due_at'] as string,
            status: fee['status'] as string,
          }
        : null,
    };
  }
}

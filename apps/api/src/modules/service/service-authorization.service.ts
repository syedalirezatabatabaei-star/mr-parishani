import {
  ConflictException,
  ForbiddenException,
  HttpException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import {
  formatToman,
  gregorianDayOf,
  normalizeDigits,
  providerContractEnded,
  providerContractEndsOn,
  SERVICE_CODE_FORMAT,
  toJalali,
  type DoctorPatientView,
  type DoctorPurseLinesView,
  type MyServiceAuthorizationView,
  type PermissionCode,
  type ServiceAuthorizationStatus,
  type ServiceAuthorizationView,
} from '@sepehr/contracts';
import { sql } from 'drizzle-orm';
import type { EffectiveAccess } from '../../common/auth/access.port';
import { ACCOUNT_DIRECTORY, type AccountDirectory } from '../../common/auth/account-directory.port';
import {
  AUDIT_LOG,
  type Actor,
  type AuditLog,
  type SqlExecutor,
} from '../../common/audit/audit.port';
import {
  WORKPLACE_DIRECTORY,
  type WorkplaceDirectory,
  type WorkplaceRecord,
} from '../../common/catalog/workplace-directory.port';
import { CONFIG, type ConfigPort } from '../../common/config/config.port';
import {
  CREDIT_CONTRACT_FACTS,
  type CreditContractFactsPort,
} from '../../common/credit/credit-contract-facts.port';
import { purseScopeOf } from '../../common/credit/credit-funding-facts.port';
import { OUTBOX, type OutboxPort } from '../../common/events/outbox.port';
import type { ServiceControl } from '../../common/service/service-control.port';
import type {
  FinalizedService,
  ServiceReversals,
} from '../../common/service/service-reversals.port';
import { LEAD_CASES, type LeadCases } from '../../common/lead/lead-cases.port';
import {
  PROFORMA_DIRECTORY,
  type ProformaDirectory,
} from '../../common/proforma/proforma-directory.port';
import {
  WALLET,
  type PurseScope,
  type PurseSummary,
  type WalletPort,
} from '../../common/wallet/wallet.port';
import { DATABASE, type Database } from '../../db/database.module';
import type { TextSmsSender } from '../../infra/sms-queue';
import { newServiceCode, SERVICE_CODES, type ServiceCodeHasher } from './service-codes';

export const SERVICE_SMS_SENDER = Symbol('SERVICE_SMS_SENDER');

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SWEEP_BATCH = 100;
/** Scheduled jobs act as the service module itself. */
const SWEEPER_ACTOR: Actor = { accountId: null, sessionId: null, ip: null, roles: ['service'] };

const notFound = () => new NotFoundException({ error: 'service_authorization_not_found' });
/** Not referred to this doctor, or no such purse: the same answer (rule 13, doc 12 §9 test 8). */
const purseNotFound = () => new NotFoundException({ error: 'purse_not_found' });
const conflict = (error: string, detail?: Record<string, unknown>) =>
  new ConflictException({ error, ...detail });

/** The wallet operation keys of one authorization (owner, ت۱: one key per authorization). */
export const serviceKey = (authorizationId: string, step: string) =>
  `service:${authorizationId}:${step}`;

interface AuthorizationRow extends Record<string, unknown> {
  id: string;
  purse_id: string;
  credit_application_id: string;
  workplace_id: string;
  doctor_node_id: string;
  center_node_id: string;
  treatment_field_code: string;
  amount_rial: string;
  status: ServiceAuthorizationStatus;
  issued_by: string;
  issued_at: string;
  expires_at: string;
  finalize_after_hours: number;
  max_code_attempts: number;
  max_code_sends: number;
  resend_cooldown_seconds: number;
  code_ttl_minutes: number;
  code_attempts: number;
  code_sends: number;
  delivered_at: string | null;
  register_operation_id: string | null;
  finalize_due_at: string | null;
  finalized_at: string | null;
  expired_at: string | null;
  cancelled_at: string | null;
  cancel_reason: string | null;
}

const iso = (column: string) =>
  `to_char(${column} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS ${column}`;

const COLUMNS = sql.raw(`id, purse_id, credit_application_id, workplace_id, doctor_node_id,
  center_node_id, treatment_field_code, amount_rial::text AS amount_rial, status, issued_by,
  ${iso('issued_at')}, ${iso('expires_at')}, finalize_after_hours, max_code_attempts,
  max_code_sends, resend_cooldown_seconds, code_ttl_minutes, code_attempts, code_sends,
  ${iso('delivered_at')}, register_operation_id, ${iso('finalize_due_at')},
  ${iso('finalized_at')}, ${iso('expired_at')}, ${iso('cancelled_at')}, cancel_reason`);

/** A code to send once the transaction that made it has committed. */
interface PendingCode {
  readonly purseId: string;
  readonly codeId: string;
  readonly code: string;
  readonly borrowerPersonId: string;
  readonly amountRial: bigint;
  readonly placeName: string;
}

/**
 * Service authorization and delivery (doc 12 §6; task 4-6 [financial]; owner 1405/07/12).
 *
 * Every purse movement is one of phase 1's wallet operations, unchanged, on the purse's
 * memo chain only (owner, ت۱), each keyed by the authorization (`service:{id}:{step}`):
 *   - issue:   reserve the sum of the authorized proforma lines (refused, never reduced,
 *              when it is more than the purse holds; owner, پ۶);
 *   - deliver: the borrower's code registers the service (purse.consumed_pending);
 *   - expire, or cancel before delivery: cancel the reservation;
 *   - cancel a delivered service (finance only, before it is final; owner, ت۲): reverse
 *              its registration, then cancel the reservation.
 * Final is a state and an event only: doctor.payable is phase 5's (owner, پ۱).
 */
@Injectable()
export class ServiceAuthorizationService implements ServiceControl, ServiceReversals {
  private readonly logger = new Logger(ServiceAuthorizationService.name);

  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(AUDIT_LOG) private readonly audit: AuditLog,
    @Inject(OUTBOX) private readonly outbox: OutboxPort,
    @Inject(CONFIG) private readonly config: ConfigPort,
    @Inject(WALLET) private readonly wallet: WalletPort,
    @Inject(CREDIT_CONTRACT_FACTS) private readonly credit: CreditContractFactsPort,
    @Inject(PROFORMA_DIRECTORY) private readonly proformas: ProformaDirectory,
    @Inject(WORKPLACE_DIRECTORY) private readonly workplaces: WorkplaceDirectory,
    @Inject(LEAD_CASES) private readonly leads: LeadCases,
    @Inject(ACCOUNT_DIRECTORY) private readonly accounts: AccountDirectory,
    @Inject(SERVICE_CODES) private readonly codes: ServiceCodeHasher,
    @Inject(SERVICE_SMS_SENDER) private readonly sms: TextSmsSender,
  ) {}

  // --- issuing --------------------------------------------------------------------------

  async issue(
    actor: Actor,
    access: EffectiveAccess,
    input: { purseId: string; proformaLineIds: readonly string[] },
    now = new Date(),
  ): Promise<ServiceAuthorizationView> {
    this.require(access, 'service.authorize');
    const target = await this.target(actor, input.purseId);
    const { purse, facts, workplace } = target;
    if (purse.status !== 'funded') throw conflict('purse_not_funded', { status: purse.status });
    // Doc 12 §6, §9 test 9: a suspended center authorizes nothing new.
    if (workplace.centerStatus === 'suspended') throw conflict('center_suspended');
    if (workplace.centerStatus !== null && workplace.centerStatus !== 'active') {
      throw conflict('center_not_active', { status: workplace.centerStatus });
    }
    // ADR-046 (owner 1405/07/27): past the doctor's or center's contract term, nothing new.
    const { value: term } = await this.config.resolve(
      'settlement.provider_contract',
      target.scope,
      now,
    );
    if (providerContractEnded(term, gregorianDayOf(toJalali(now)))) {
      throw conflict('provider_contract_ended', { endsOn: providerContractEndsOn(term) });
    }

    // The lines are the purse's own proforma's (owner, پ۶); their sum is what is authorized.
    const proformaLines = await this.proformas.lines(facts.proformaId);
    const wageOnly = facts.origination?.plan.financeableBasis === 'wage';
    const byId = new Map(proformaLines.map((l) => [l.id, l]));
    const lines = input.proformaLineIds.map((id) => {
      const line = byId.get(id);
      if (!line) throw new UnprocessableEntityException({ error: 'line_not_in_proforma', id });
      if (line.lineTotalRial <= 0n) {
        throw new UnprocessableEntityException({ error: 'line_without_amount', id });
      }
      // ADR-050: a wage-only loan pays the doctor's wage; its materials are paid in cash.
      if (wageOnly && line.costKind === 'material') {
        throw new UnprocessableEntityException({ error: 'line_is_material', id });
      }
      return line;
    });
    const amount = lines.reduce((sum, l) => sum + l.lineTotalRial, 0n);

    // The configuration in force now, locked to the authorization (rule 16).
    const [ttlHours, codeTtl, finalizeHours, attempts, sends, cooldown] = await Promise.all([
      this.config.resolve('service.authorization_ttl_hours', {}, now),
      this.config.resolve('service.code_ttl_minutes', {}, now),
      this.config.resolve('service.finalize_after_hours', {}, now),
      this.config.resolve('service.max_code_attempts', {}, now),
      this.config.resolve('service.max_code_sends', {}, now),
      this.config.resolve('service.code_resend_cooldown_seconds', {}, now),
    ]);
    const expiresAt = new Date(now.getTime() + ttlHours.value * 3_600_000);
    const versions = {
      ttl: ttlHours.versionId,
      codeTtl: codeTtl.versionId,
      finalize: finalizeHours.versionId,
      attempts: attempts.versionId,
      sends: sends.versionId,
      cooldown: cooldown.versionId,
    };

    const { row, pending } = await this.db
      .transaction(async (tx) => {
        const made = await tx.execute(sql`
          INSERT INTO service_authorizations (
            purse_id, credit_application_id, workplace_id, doctor_node_id, center_node_id,
            treatment_field_code, amount_rial, issued_by, issued_at, expires_at,
            finalize_after_hours, max_code_attempts, max_code_sends, resend_cooldown_seconds,
            code_ttl_minutes, config_version_ids
          ) VALUES (
            ${purse.id}, ${facts.creditApplicationId}, ${workplace.id},
            ${target.scope.doctorNodeId}, ${target.scope.centerNodeId},
            ${target.scope.treatmentFieldCode}, ${amount.toString()}::bigint,
            ${actor.accountId}, ${now}, ${expiresAt}, ${finalizeHours.value},
            ${attempts.value}, ${sends.value}, ${cooldown.value}, ${codeTtl.value},
            ${JSON.stringify(versions)}::jsonb
          )
          RETURNING ${COLUMNS}
        `);
        const created = made.rows[0] as AuthorizationRow;
        for (const line of lines) {
          await tx.execute(sql`
            INSERT INTO service_authorization_lines (authorization_id, proforma_line_id, amount_rial)
            VALUES (${created.id}, ${line.id}, ${line.lineTotalRial.toString()}::bigint)
          `);
        }
        // Phase 1's reservation: the purse locked FOR UPDATE, its scope and balance checked.
        await this.wallet
          .reserve(
            target.issuer,
            purse.id,
            {
              idempotencyKey: serviceKey(created.id, 'reserve'),
              authorizationId: created.id,
              amountRial: amount,
              service: target.scope,
            },
            tx,
          )
          .catch((error: unknown) => {
            // More than the purse holds: refused, never authorized for less (owner, پ۶);
            // the doctor is not told the balance (owner, پ۲).
            if (errorCode(error) === 'insufficient_available') {
              throw conflict('amount_exceeds_available');
            }
            throw error;
          });
        // Task 4-8: an AuthorizedRecipient uses at most their transfer's amount, counted from
        // when it was approved; checked with the purse locked by the reservation above.
        const recipient = await this.wallet.activeRecipient(purse.id, tx);
        if (recipient) {
          const used = await tx.execute(sql`
            SELECT coalesce(sum(amount_rial), 0)::text AS used FROM service_authorizations
            WHERE purse_id = ${purse.id} AND issued_at >= ${recipient.since}
              AND status NOT IN ('cancelled', 'expired')
          `);
          if (BigInt(used.rows[0]?.['used'] as string) > recipient.amountRial) {
            throw conflict('recipient_limit_reached');
          }
        }
        const code = await this.newCode(tx, created, now, created.code_ttl_minutes);
        const counted = await tx.execute(sql`
          UPDATE service_authorizations SET code_sends = 1 WHERE id = ${created.id}
          RETURNING ${COLUMNS}
        `);
        await this.audit.record(
          {
            actor: target.issuer,
            action: 'service.authorized',
            entityType: 'service_authorization',
            entityId: created.id,
            after: {
              purseId: purse.id,
              creditApplicationId: facts.creditApplicationId,
              amountRial: amount.toString(),
              proformaLineIds: lines.map((l) => l.id),
            },
          },
          tx,
        );
        await this.publish(tx, 'service.authorized', created);
        await this.publish(tx, 'service.code_sent', created);
        return {
          row: counted.rows[0] as AuthorizationRow,
          pending: {
            purseId: purse.id,
            codeId: code.codeId,
            code: code.code,
            borrowerPersonId: facts.borrowerPersonId,
            amountRial: amount,
            placeName: workplace.placeName ?? workplace.doctorName,
          } satisfies PendingCode,
        };
      })
      .catch((error: unknown) => {
        if (isUniqueViolation(error)) throw conflict('line_already_authorized');
        throw error;
      });
    await this.sendCode(pending);
    return this.view(row);
  }

  /** A new code for an authorization still waiting for one (owner, پ۵: 3 sends, 60 s apart). */
  async resend(
    actor: Actor,
    access: EffectiveAccess,
    id: string,
    now = new Date(),
  ): Promise<ServiceAuthorizationView> {
    this.require(access, 'service.authorize');
    const reached = await this.reachAsIssuer(actor, id);
    const outcome = await this.db.transaction(async (tx) => {
      const row = await this.lock(tx, id);
      if (row.status !== 'code_sent') throw conflict('not_awaiting_code', { status: row.status });
      if (now >= new Date(row.expires_at)) {
        return { expired: await this.expire(tx, SWEEPER_ACTOR, row, now) };
      }
      if (row.code_sends >= row.max_code_sends) throw conflict('code_send_limit');
      const last = await tx.execute(sql`
        SELECT max(sent_at) AS at FROM service_codes WHERE authorization_id = ${id}
      `);
      const lastSent = last.rows[0]?.['at'];
      if (lastSent) {
        const wait = new Date(lastSent as string).getTime() + row.resend_cooldown_seconds * 1000;
        if (now.getTime() < wait) {
          throw conflict('code_resend_too_soon', {
            retryAfterSeconds: Math.ceil((wait - now.getTime()) / 1000),
          });
        }
      }
      await tx.execute(sql`
        UPDATE service_codes SET voided_at = ${now}
        WHERE authorization_id = ${id} AND consumed_at IS NULL AND voided_at IS NULL
      `);
      const code = await this.newCode(tx, row, now, row.code_ttl_minutes);
      const counted = await tx.execute(sql`
        UPDATE service_authorizations SET code_sends = code_sends + 1 WHERE id = ${id}
        RETURNING ${COLUMNS}
      `);
      await this.audit.record(
        {
          actor: reached.issuer,
          action: 'service.code_resent',
          entityType: 'service_authorization',
          entityId: id,
          after: { codeSends: row.code_sends + 1 },
        },
        tx,
      );
      await this.publish(tx, 'service.code_sent', row);
      return {
        row: counted.rows[0] as AuthorizationRow,
        pending: {
          purseId: row.purse_id,
          codeId: code.codeId,
          code: code.code,
          borrowerPersonId: reached.facts.borrowerPersonId,
          amountRial: BigInt(row.amount_rial),
          placeName: reached.workplace.placeName ?? reached.workplace.doctorName,
        } satisfies PendingCode,
      };
    });
    if ('expired' in outcome) throw conflict('authorization_expired');
    await this.sendCode(outcome.pending);
    return this.view(outcome.row);
  }

  // --- delivering ------------------------------------------------------------------------

  /**
   * The borrower's code, entered at the doctor's: registers the service on the purse.
   * Locked FOR UPDATE and keyed per authorization, so a retry after a dropped connection,
   * or two at once, register it once (doc 12 §9 test 14). A wrong code counts; the fifth,
   * or an expired code, expires the authorization and frees its reservation (test 6).
   */
  async deliver(
    actor: Actor,
    access: EffectiveAccess,
    id: string,
    typed: string,
    now = new Date(),
  ): Promise<ServiceAuthorizationView> {
    this.require(access, 'service.authorize');
    const reached = await this.reachAsIssuer(actor, id);
    const code = normalizeDigits(typed.trim());
    const outcome = await this.db.transaction(async (tx) => {
      const row = await this.lock(tx, id);
      // Already recorded: the same answer again, nothing registered twice.
      if (row.status === 'delivered' || row.status === 'finalized') return { row };
      if (row.status !== 'code_sent') throw conflict('not_awaiting_code', { status: row.status });
      if (now >= new Date(row.expires_at)) {
        return { failure: 'expired' as const, row: await this.expire(tx, SWEEPER_ACTOR, row, now) };
      }
      const open = await tx.execute(sql`
        SELECT id, code_hash,
               ${sql.raw(iso('expires_at'))}
        FROM service_codes
        WHERE authorization_id = ${id} AND consumed_at IS NULL AND voided_at IS NULL
      `);
      const current = open.rows[0] as
        { id: string; code_hash: string; expires_at: string } | undefined;
      if (!current || now >= new Date(current.expires_at)) {
        return { failure: 'expired' as const, row: await this.expire(tx, SWEEPER_ACTOR, row, now) };
      }
      if (!SERVICE_CODE_FORMAT.test(code) || !this.codes.matches(id, code, current.code_hash)) {
        const attempts = row.code_attempts + 1;
        await tx.execute(sql`
          UPDATE service_authorizations SET code_attempts = ${attempts} WHERE id = ${id}
        `);
        if (attempts >= row.max_code_attempts) {
          const counted = { ...row, code_attempts: attempts };
          return {
            failure: 'expired' as const,
            row: await this.expire(tx, SWEEPER_ACTOR, counted, now),
          };
        }
        return {
          failure: 'invalid' as const,
          attemptsLeft: row.max_code_attempts - attempts,
          row,
        };
      }

      // The right code: the service is registered on the purse's memo chain.
      await tx.execute(sql`UPDATE service_codes SET consumed_at = ${now} WHERE id = ${current.id}`);
      const registered = await this.wallet.registerService(
        reached.issuer,
        row.purse_id,
        {
          idempotencyKey: serviceKey(id, 'register'),
          authorizationId: id,
          amountRial: BigInt(row.amount_rial),
        },
        tx,
      );
      const dueAt = new Date(now.getTime() + row.finalize_after_hours * 3_600_000);
      const final = row.finalize_after_hours === 0;
      const done = await tx.execute(sql`
        UPDATE service_authorizations
        SET status = 'delivered', delivered_at = ${now},
            register_operation_id = ${registered.operationId}, finalize_due_at = ${dueAt}
        WHERE id = ${id}
        RETURNING ${COLUMNS}
      `);
      let delivered = done.rows[0] as AuthorizationRow;
      if (final) {
        // Along its path: delivered, then final (the trigger allows no shortcut).
        const moved = await tx.execute(sql`
          UPDATE service_authorizations SET status = 'finalized', finalized_at = ${now}
          WHERE id = ${id} RETURNING ${COLUMNS}
        `);
        delivered = moved.rows[0] as AuthorizationRow;
      }
      await this.audit.record(
        {
          actor: reached.issuer,
          action: 'service.delivered',
          entityType: 'service_authorization',
          entityId: id,
          before: { status: 'code_sent' },
          after: { status: delivered.status, amountRial: row.amount_rial },
        },
        tx,
      );
      await this.publish(tx, 'service.delivered', delivered);
      // doc 13 open item 5: no dispute window by default, so final at once.
      if (final) await this.publish(tx, 'service.finalized', delivered);
      return { row: delivered, recorded: true as const };
    });
    if ('failure' in outcome) {
      if (outcome.failure === 'expired') throw conflict('authorization_expired');
      throw new UnprocessableEntityException({
        error: 'code_invalid',
        attemptsLeft: outcome.attemptsLeft,
      });
    }
    if ('recorded' in outcome) {
      await this.tellBorrower(outcome.row, reached.facts.borrowerPersonId, reached.workplace);
    }
    return this.view(outcome.row);
  }

  // --- cancelling (finance only; owner, پ۳ and ت۲) -------------------------------------

  async cancel(
    actor: Actor,
    access: EffectiveAccess,
    id: string,
    reason: string,
  ): Promise<ServiceAuthorizationView> {
    this.require(access, 'service.cancel');
    if (!UUID.test(id)) throw notFound();
    const found = await this.find(this.db, id);
    await this.reachByScope(access, found.workplace_id);
    const row = await this.db.transaction(async (tx) => {
      const locked = await this.lock(tx, id);
      // Cancelling again changes nothing (owner, ت۲).
      if (locked.status === 'cancelled') return locked;
      // A final service is phase 5's to dispute (owner, ت۲); an expired one is already free.
      if (locked.status === 'finalized') throw conflict('service_final');
      if (locked.status === 'expired') throw conflict('authorization_expired');
      const amount = BigInt(locked.amount_rial);
      if (locked.status === 'delivered') {
        if (!locked.register_operation_id) throw new Error('delivered without its operation');
        // The registration reversed on the memo chain: the amount is reserved again.
        await this.wallet.reverseOperation(
          actor,
          locked.purse_id,
          locked.register_operation_id,
          { idempotencyKey: serviceKey(id, 'unregister'), reason },
          tx,
        );
      }
      await this.wallet.cancelReservation(
        actor,
        locked.purse_id,
        { idempotencyKey: serviceKey(id, 'cancel'), authorizationId: id, amountRial: amount },
        tx,
      );
      await this.release(tx, id, new Date());
      const done = await tx.execute(sql`
        UPDATE service_authorizations
        SET status = 'cancelled', cancelled_at = now(), cancelled_by = ${actor.accountId},
            cancel_reason = ${reason}
        WHERE id = ${id}
        RETURNING ${COLUMNS}
      `);
      const cancelled = done.rows[0] as AuthorizationRow;
      await this.audit.record(
        {
          actor,
          action: 'service.cancelled',
          entityType: 'service_authorization',
          entityId: id,
          before: { status: locked.status },
          after: { status: 'cancelled', amountRial: locked.amount_rial },
          reason,
        },
        tx,
      );
      await this.publish(tx, 'service.cancelled', cancelled);
      return cancelled;
    });
    return this.view(row);
  }

  // --- a final service taken back (SERVICE_REVERSALS; task 5-2b, ADR-038) ---------------

  async lockForReversal(
    authorizationId: string,
    tx: SqlExecutor,
  ): Promise<FinalizedService | null> {
    if (!UUID.test(authorizationId)) return null;
    const row = (
      await tx.execute(sql`
        SELECT id, purse_id, amount_rial::text AS amount_rial, register_operation_id, status
        FROM service_authorizations WHERE id = ${authorizationId} FOR UPDATE
      `)
    ).rows[0];
    const status = row?.['status'] as string | undefined;
    if (!row || (status !== 'finalized' && status !== 'reversed')) return null;
    if (!row['register_operation_id']) throw new Error('a final service without its operation');
    return {
      authorizationId,
      purseId: row['purse_id'] as string,
      amountRial: BigInt(row['amount_rial'] as string),
      registerOperationId: row['register_operation_id'] as string,
      status,
    };
  }

  async markReversed(
    actor: Actor,
    authorizationId: string,
    reason: string,
    tx: SqlExecutor,
  ): Promise<{ already: boolean }> {
    const locked = await this.lockForReversal(authorizationId, tx);
    if (!locked) throw conflict('service_not_final');
    if (locked.status === 'reversed') return { already: true };
    await tx.execute(sql`
      UPDATE service_authorizations SET status = 'reversed', reversed_at = now()
      WHERE id = ${authorizationId}
    `);
    await this.audit.record(
      {
        actor,
        action: 'service.reversed',
        entityType: 'service_authorization',
        entityId: authorizationId,
        before: { status: 'finalized' },
        after: { status: 'reversed' },
        reason,
      },
      tx,
    );
    await this.outbox.publish(
      {
        type: 'service.authorization_reversed',
        aggregateType: 'service_authorization',
        aggregateId: authorizationId,
        payload: { authorizationId, purseId: locked.purseId },
      },
      tx,
    );
    return { already: false };
  }

  // --- for the wallet's special operations (SERVICE_CONTROL; task 4-8) -----------------

  /**
   * A doctor change (doc 12 §7, §9 test 12): every authorization still waiting for its code
   * is cancelled, its reservation freed, in the caller's transaction; a recorded service not
   * yet final stops it (owner پ۹).
   */
  async cancelOpen(
    actor: Actor,
    purseId: string,
    reason: string,
    tx: SqlExecutor,
  ): Promise<{ cancelled: number }> {
    const rows = await tx.execute(sql`
      SELECT ${COLUMNS} FROM service_authorizations
      WHERE purse_id = ${purseId} AND status IN ('code_sent', 'delivered')
      ORDER BY issued_at
      FOR UPDATE
    `);
    const open = rows.rows as AuthorizationRow[];
    if (open.some((r) => r.status === 'delivered')) throw conflict('service_not_final');
    const now = new Date();
    for (const row of open) {
      await this.wallet.cancelReservation(
        actor,
        row.purse_id,
        {
          idempotencyKey: serviceKey(row.id, 'cancel'),
          authorizationId: row.id,
          amountRial: BigInt(row.amount_rial),
        },
        tx,
      );
      await this.release(tx, row.id, now);
      await tx.execute(sql`
        UPDATE service_codes SET voided_at = ${now}
        WHERE authorization_id = ${row.id} AND consumed_at IS NULL AND voided_at IS NULL
      `);
      const done = await tx.execute(sql`
        UPDATE service_authorizations
        SET status = 'cancelled', cancelled_at = ${now}, cancelled_by = ${actor.accountId},
            cancel_reason = ${reason}
        WHERE id = ${row.id}
        RETURNING ${COLUMNS}
      `);
      await this.audit.record(
        {
          actor,
          action: 'service.cancelled',
          entityType: 'service_authorization',
          entityId: row.id,
          before: { status: 'code_sent' },
          after: { status: 'cancelled', amountRial: row.amount_rial },
          reason,
        },
        tx,
      );
      await this.publish(tx, 'service.cancelled', done.rows[0] as AuthorizationRow);
    }
    return { cancelled: open.length };
  }

  // --- scheduled (the worker) ----------------------------------------------------------

  /**
   * Authorizations not confirmed in time: expired, their reservation cancelled (doc 12 §6.5,
   * §9 test 7). Rows are taken SKIP LOCKED and every wallet step is keyed, so a second run,
   * or two at once, change nothing more.
   */
  async expireOverdue(now = new Date()): Promise<number> {
    let expired = 0;
    for (;;) {
      const done = await this.db.transaction(async (tx) => {
        const rows = await tx.execute(sql`
          SELECT ${COLUMNS} FROM service_authorizations
          WHERE status = 'code_sent' AND expires_at <= ${now}
          ORDER BY expires_at LIMIT ${SWEEP_BATCH}
          FOR UPDATE SKIP LOCKED
        `);
        for (const row of rows.rows as AuthorizationRow[]) {
          await this.expire(tx, SWEEPER_ACTOR, row, now);
        }
        return rows.rows.length;
      });
      expired += done;
      if (done < SWEEP_BATCH) return expired;
    }
  }

  /**
   * Delivered services past their window become final: a state and an event only; the
   * doctor's payable is phase 5's, from finalized_at (owner, پ۱).
   */
  async finalizeDue(now = new Date()): Promise<number> {
    let finalized = 0;
    for (;;) {
      const done = await this.db.transaction(async (tx) => {
        const rows = await tx.execute(sql`
          SELECT ${COLUMNS} FROM service_authorizations
          WHERE status = 'delivered' AND finalize_due_at <= ${now}
          ORDER BY finalize_due_at LIMIT ${SWEEP_BATCH}
          FOR UPDATE SKIP LOCKED
        `);
        for (const row of rows.rows as AuthorizationRow[]) {
          const moved = await tx.execute(sql`
            UPDATE service_authorizations SET status = 'finalized', finalized_at = ${now}
            WHERE id = ${row.id} RETURNING ${COLUMNS}
          `);
          await this.audit.record(
            {
              actor: SWEEPER_ACTOR,
              action: 'service.finalized',
              entityType: 'service_authorization',
              entityId: row.id,
              before: { status: 'delivered' },
              after: { status: 'finalized' },
            },
            tx,
          );
          await this.publish(tx, 'service.finalized', moved.rows[0] as AuthorizationRow);
        }
        return rows.rows.length;
      });
      finalized += done;
      if (done < SWEEP_BATCH) return finalized;
    }
  }

  // --- reading ---------------------------------------------------------------------------

  /**
   * The funded patients referred to the caller, as doctor or delegated secretary (owner,
   * پ۲): the name and whether a service can be authorized now; no amount, balance or score.
   */
  async patients(actor: Actor, access: EffectiveAccess): Promise<DoctorPatientView[]> {
    this.require(access, 'service.authorize');
    const paths = access.scopes.flatMap((s) =>
      s.kind === 'center' || s.kind === 'branch' || s.kind === 'doctor' ? [s.path] : [],
    );
    if (paths.length === 0 || actor.accountId === null) return [];
    // Each purse at its doctor now: the newest move (a doctor change, task 4-8), else its own.
    const rows = await this.db.execute(sql`
      SELECT * FROM (
        SELECT p.purse_id, p.credit_application_id, p.patient_person_id, p.funded_at,
               coalesce(m.workplace_id, p.workplace_id) AS workplace_id,
               coalesce(m.workplace_node_path, p.workplace_node_path) AS node_path
        FROM service_doctor_patients p
        LEFT JOIN LATERAL (
          SELECT workplace_id, workplace_node_path FROM service_purse_workplaces w
          WHERE w.purse_id = p.purse_id ORDER BY w.created_at DESC, w.id DESC LIMIT 1
        ) m ON true
      ) current
      WHERE ${sql.join(
        paths.map((p) => sql`(node_path = ${p} OR node_path LIKE ${`${p}.%`})`),
        sql` OR `,
      )}
      ORDER BY funded_at DESC
      LIMIT 500
    `);
    const views: DoctorPatientView[] = [];
    const cache = new Map<string, WorkplaceRecord | null>();
    for (const r of rows.rows) {
      const workplaceId = r['workplace_id'] as string;
      if (!cache.has(workplaceId))
        cache.set(workplaceId, await this.workplaces.workplace(workplaceId));
      const workplace = cache.get(workplaceId) ?? null;
      if (!workplace || !(await this.isIssuer(actor.accountId, workplace))) continue;
      const purse = await this.wallet.summary(r['purse_id'] as string);
      const allowed =
        purse.status === 'funded' &&
        purse.balances.availableRial > 0n &&
        (workplace.centerStatus === null || workplace.centerStatus === 'active');
      const recipientName = await this.recipientName(r['purse_id'] as string);
      views.push({
        ...(recipientName ? { recipientName } : {}),
        purseId: r['purse_id'] as string,
        creditApplicationId: r['credit_application_id'] as string,
        patientName: await this.leads.displayNameOf(r['patient_person_id'] as string),
        allowed,
      });
    }
    return views;
  }

  /** Task 4-8: the AuthorizedRecipient's name, if the purse has one now (a name only). */
  private async recipientName(purseId: string): Promise<string | null> {
    const recipient = await this.wallet.activeRecipient(purseId);
    return recipient ? this.leads.displayNameOf(recipient.personId) : null;
  }

  /**
   * One funded patient's proforma lines, for the doctor to choose what to authorize (task
   * 4-7): each line's service, quantity and amount, and whether a live authorization holds it
   * already (owner, پ۷). No balance (owner, پ۲). Not referred to the caller: 404 (test 8).
   */
  async purseLines(
    actor: Actor,
    access: EffectiveAccess,
    purseId: string,
  ): Promise<DoctorPurseLinesView> {
    this.require(access, 'service.authorize');
    const { purse, facts, workplace } = await this.target(actor, purseId);
    const lines = await this.proformas.lines(facts.proformaId);
    const names = await this.workplaces.serviceNames(lines.map((l) => l.serviceCode));
    const live = lines.length
      ? await this.db.execute(sql`
          SELECT proforma_line_id FROM service_authorization_lines
          WHERE released_at IS NULL AND proforma_line_id IN (${sql.join(
            lines.map((l) => sql`${l.id}::uuid`),
            sql`, `,
          )})
        `)
      : { rows: [] };
    const held = new Set(live.rows.map((r) => r['proforma_line_id'] as string));
    return {
      purseId: purse.id,
      patientName: await this.leads.displayNameOf(facts.patientPersonId),
      allowed:
        purse.status === 'funded' &&
        purse.balances.availableRial > 0n &&
        (workplace.centerStatus === null || workplace.centerStatus === 'active'),
      lines: lines.map((l) => ({
        id: l.id,
        lineNo: l.lineNo,
        serviceName: names.get(l.serviceCode) ?? l.serviceCode,
        quantity: l.quantity,
        amountRial: l.lineTotalRial.toString(),
        authorized: held.has(l.id),
        cashOnly: facts.origination?.plan.financeableBasis === 'wage' && l.costKind === 'material',
      })),
    };
  }

  /** Authorizations of the workplaces the caller's scope covers (or their own as doctor). */
  async list(
    actor: Actor,
    access: EffectiveAccess,
    query: { purseId?: string | undefined; status?: ServiceAuthorizationStatus | undefined },
  ): Promise<ServiceAuthorizationView[]> {
    this.require(access, 'service.read');
    const rows = await this.db.execute(sql`
      SELECT ${COLUMNS} FROM service_authorizations
      WHERE (${query.purseId ?? null}::uuid IS NULL OR purse_id = ${query.purseId ?? null})
        AND (${query.status ?? null}::text IS NULL OR status = ${query.status ?? null})
      ORDER BY issued_at DESC
      LIMIT 500
    `);
    const views: ServiceAuthorizationView[] = [];
    const visible = new Map<string, boolean>();
    for (const r of rows.rows as AuthorizationRow[]) {
      if (!visible.has(r.workplace_id)) {
        visible.set(
          r.workplace_id,
          await this.reachByScope(access, r.workplace_id).then(
            () => true,
            () => false,
          ),
        );
      }
      if (visible.get(r.workplace_id)) views.push(await this.view(r));
    }
    return views;
  }

  async get(access: EffectiveAccess, id: string): Promise<ServiceAuthorizationView> {
    this.require(access, 'service.read');
    if (!UUID.test(id)) throw notFound();
    const row = await this.find(this.db, id);
    await this.reachByScope(access, row.workplace_id);
    return this.view(row);
  }

  /** The borrower's or patient's own authorizations (rule 13). */
  async mine(accountId: string): Promise<MyServiceAuthorizationView[]> {
    const account = await this.accounts.find(accountId);
    if (!account || account.kind !== 'patient') {
      throw new ForbiddenException({ error: 'patients_only' });
    }
    if (!account.personId) return [];
    const persons = await this.leads.samePersonIds(
      await this.leads.canonicalPersonId(account.personId),
    );
    // Where they are the patient or the borrower (the borrower gets the code).
    const applications = await this.credit.applicationsOf(persons);
    if (applications.length === 0) return [];
    const rows = await this.db.execute(sql`
      SELECT ${COLUMNS} FROM service_authorizations
      WHERE credit_application_id IN (${sql.join(
        applications.map((a) => sql`${a}::uuid`),
        sql`, `,
      )})
      ORDER BY issued_at DESC LIMIT 500
    `);
    const out: MyServiceAuthorizationView[] = [];
    for (const r of rows.rows as AuthorizationRow[]) {
      const workplace = await this.workplaces.workplace(r.workplace_id);
      out.push({
        id: r.id,
        creditApplicationId: r.credit_application_id,
        status: r.status,
        amountRial: r.amount_rial,
        centerName: workplace?.placeName ?? null,
        issuedAt: r.issued_at,
        deliveredAt: r.delivered_at,
        finalizedAt: r.finalized_at,
      });
    }
    return out;
  }

  // --- helpers ---------------------------------------------------------------------------

  /**
   * The purse, its application and its workplace, if the caller is that workplace's doctor
   * or their delegated secretary; otherwise it does not exist for them (IDOR, test 8).
   */
  private async target(actor: Actor, purseId: string) {
    if (!UUID.test(purseId) || actor.accountId === null) throw purseNotFound();
    const purse: PurseSummary = await this.wallet.summary(purseId).catch((error: unknown) => {
      if (error instanceof HttpException && error.getStatus() === 404) throw purseNotFound();
      throw error;
    });
    if (!purse.creditApplicationId) throw purseNotFound();
    const facts = await this.credit.facts(purse.creditApplicationId);
    if (!facts) throw purseNotFound();
    // The purse's doctor now: its scope's newest version (a doctor change, task 4-8).
    const workplace = await this.workplaces.workplaceByNode(purse.scope.doctorNodeId);
    if (!workplace) throw purseNotFound();
    const issuer = await this.issuerOf(actor, workplace);
    if (!issuer) throw purseNotFound();
    const scope: PurseScope = purseScopeOf(workplace, purse.scope.treatmentFieldCode);
    return { purse, facts, workplace, issuer, scope };
  }

  private async reachAsIssuer(actor: Actor, id: string) {
    if (!UUID.test(id)) throw notFound();
    const row = await this.find(this.db, id);
    try {
      return await this.target(actor, row.purse_id);
    } catch (error) {
      if (error instanceof NotFoundException) throw notFound();
      throw error;
    }
  }

  /**
   * The doctor with an account, or that workplace's own secretary only when the doctor has
   * an account and so delegated it (as for proformas, doc 04 §2); else null.
   */
  private async issuerOf(actor: Actor, workplace: WorkplaceRecord): Promise<Actor | null> {
    if (actor.accountId === null || workplace.doctorAccountId === null) return null;
    if (workplace.doctorAccountId === actor.accountId) return actor;
    if (await this.workplaces.isSecretary(workplace.id, actor.accountId)) {
      return { ...actor, onBehalfOfDoctorId: workplace.doctorId };
    }
    return null;
  }

  private async isIssuer(accountId: string, workplace: WorkplaceRecord): Promise<boolean> {
    if (workplace.doctorAccountId === null) return false;
    if (workplace.doctorAccountId === accountId) return true;
    return this.workplaces.isSecretary(workplace.id, accountId);
  }

  /** Staff reach a workplace their scope covers: global, its city, or its node by path. */
  private async reachByScope(access: EffectiveAccess, workplaceId: string): Promise<void> {
    const workplace = await this.workplaces.workplace(workplaceId);
    const covers =
      workplace !== null &&
      access.scopes.some((s) => {
        if (s.kind === 'global') return true;
        if (s.kind === 'city') return s.code === workplace.cityCode;
        if (s.kind === 'center' || s.kind === 'branch' || s.kind === 'doctor') {
          return workplace.nodePath === s.path || workplace.nodePath.startsWith(`${s.path}.`);
        }
        return false;
      });
    if (!covers) throw notFound();
  }

  /** Expires a waiting authorization: its reservation cancelled, its lines and code freed. */
  private async expire(
    tx: SqlExecutor,
    actor: Actor,
    row: AuthorizationRow,
    now: Date,
  ): Promise<AuthorizationRow> {
    await this.wallet.cancelReservation(
      actor,
      row.purse_id,
      {
        idempotencyKey: serviceKey(row.id, 'cancel'),
        authorizationId: row.id,
        amountRial: BigInt(row.amount_rial),
      },
      tx,
    );
    await this.release(tx, row.id, now);
    await tx.execute(sql`
      UPDATE service_codes SET voided_at = ${now}
      WHERE authorization_id = ${row.id} AND consumed_at IS NULL AND voided_at IS NULL
    `);
    const done = await tx.execute(sql`
      UPDATE service_authorizations SET status = 'expired', expired_at = ${now}
      WHERE id = ${row.id} RETURNING ${COLUMNS}
    `);
    const expired = done.rows[0] as AuthorizationRow;
    await this.audit.record(
      {
        actor,
        action: 'service.authorization_expired',
        entityType: 'service_authorization',
        entityId: row.id,
        before: { status: 'code_sent' },
        after: { status: 'expired', codeAttempts: row.code_attempts },
      },
      tx,
    );
    await this.publish(tx, 'service.authorization_expired', expired);
    return expired;
  }

  /** Frees the authorization's proforma lines for another authorization. */
  private async release(tx: SqlExecutor, id: string, now: Date) {
    await tx.execute(sql`
      UPDATE service_authorization_lines SET released_at = ${now}
      WHERE authorization_id = ${id} AND released_at IS NULL
    `);
  }

  private async newCode(
    tx: SqlExecutor,
    row: AuthorizationRow,
    now: Date,
    ttlMinutes: number,
  ): Promise<{ codeId: string; code: string }> {
    const code = newServiceCode();
    // A code never outlives its authorization.
    const expiresAt = new Date(
      Math.min(now.getTime() + ttlMinutes * 60_000, new Date(row.expires_at).getTime()),
    );
    const made = await tx.execute(sql`
      INSERT INTO service_codes (authorization_id, code_hash, sent_at, expires_at)
      VALUES (${row.id}, ${this.codes.hash(row.id, code)}, ${now}, ${expiresAt})
      RETURNING id
    `);
    return { codeId: made.rows[0]?.['id'] as string, code };
  }

  /**
   * The code to the borrower (doc 12 §6.3): the amount and the place, no treatment (test
   * 10). After the commit; if it cannot be queued, the doctor resends. Never logged.
   */
  private async sendCode(pending: PendingCode): Promise<void> {
    try {
      // Task 4-8: to the AuthorizedRecipient's mobile while there is one (doc 12 §6.3).
      const recipient = await this.wallet.activeRecipient(pending.purseId);
      const mobile = recipient?.mobile ?? (await this.leads.mobileOf(pending.borrowerPersonId));
      if (!mobile) {
        this.logger.warn('the borrower has no mobile; service code not sent');
        return;
      }
      const templates = (await this.config.resolve('service.sms_templates')).value;
      const text = templates.code
        .replace('{center}', pending.placeName)
        .replace('{amount}', formatToman(pending.amountRial))
        .replace('{code}', pending.code);
      await this.sms.sendText(
        { mobile, text, notAfter: new Date(Date.now() + 15 * 60_000).toISOString() },
        `service-code-${pending.codeId}`,
      );
    } catch (error) {
      this.logger.error(`service code not queued: ${(error as Error).message}`);
    }
  }

  /**
   * Task 4-8 (owner س۸): a service recorded with an AuthorizedRecipient's code, told to the
   * borrower: the place only, no code and no amount. After the commit; never logged.
   */
  private async tellBorrower(
    row: AuthorizationRow,
    borrowerPersonId: string,
    workplace: WorkplaceRecord,
  ): Promise<void> {
    try {
      if (!(await this.wallet.activeRecipient(row.purse_id))) return;
      const mobile = await this.leads.mobileOf(borrowerPersonId);
      if (!mobile) return;
      const templates = (await this.config.resolve('wallet.credit_transfer_sms_templates')).value;
      const text = templates.serviceRecorded.replace(
        '{center}',
        workplace.placeName ?? workplace.doctorName,
      );
      await this.sms.sendText(
        { mobile, text, notAfter: new Date(Date.now() + 24 * 3_600_000).toISOString() },
        `service-recipient-used-${row.id}`,
      );
    } catch (error) {
      this.logger.error(`recipient's service not told: ${(error as Error).message}`);
    }
  }

  private async view(r: AuthorizationRow): Promise<ServiceAuthorizationView> {
    const lines = await this.db.execute(sql`
      SELECT proforma_line_id, amount_rial::text AS amount_rial
      FROM service_authorization_lines WHERE authorization_id = ${r.id} ORDER BY created_at, id
    `);
    return {
      id: r.id,
      purseId: r.purse_id,
      creditApplicationId: r.credit_application_id,
      workplaceId: r.workplace_id,
      status: r.status,
      amountRial: r.amount_rial,
      lines: lines.rows.map((l) => ({
        proformaLineId: l['proforma_line_id'] as string,
        amountRial: l['amount_rial'] as string,
      })),
      issuedAt: r.issued_at,
      expiresAt: r.expires_at,
      deliveredAt: r.delivered_at,
      finalizeDueAt: r.finalize_due_at,
      finalizedAt: r.finalized_at,
      cancelledAt: r.cancelled_at,
      cancelReason: r.cancel_reason,
      attemptsLeft: Math.max(0, r.max_code_attempts - r.code_attempts),
      sendsLeft: Math.max(0, r.max_code_sends - r.code_sends),
    };
  }

  private async find(ex: SqlExecutor, id: string): Promise<AuthorizationRow> {
    const rows = await ex.execute(
      sql`SELECT ${COLUMNS} FROM service_authorizations WHERE id = ${id}`,
    );
    const row = rows.rows[0] as AuthorizationRow | undefined;
    if (!row) throw notFound();
    return row;
  }

  private async lock(ex: SqlExecutor, id: string): Promise<AuthorizationRow> {
    const rows = await ex.execute(
      sql`SELECT ${COLUMNS} FROM service_authorizations WHERE id = ${id} FOR UPDATE`,
    );
    const row = rows.rows[0] as AuthorizationRow | undefined;
    if (!row) throw notFound();
    return row;
  }

  private async publish(tx: SqlExecutor, type: string, row: AuthorizationRow) {
    await this.outbox.publish(
      {
        type,
        aggregateType: 'service_authorization',
        aggregateId: row.id,
        payload: {
          authorizationId: row.id,
          purseId: row.purse_id,
          creditApplicationId: row.credit_application_id,
          workplaceId: row.workplace_id,
          amountRial: row.amount_rial,
        },
      },
      tx,
    );
  }

  private require(access: EffectiveAccess, permission: PermissionCode) {
    if (!access.permissions.has(permission)) {
      throw new ForbiddenException({ error: 'permission_required', permission });
    }
  }
}

function errorCode(error: unknown): string | null {
  if (!(error instanceof HttpException)) return null;
  const body = error.getResponse();
  return typeof body === 'object' && 'error' in body ? String(body.error) : null;
}

function isUniqueViolation(error: unknown): boolean {
  const e = error as { code?: string; cause?: { code?: string } };
  return e.code === '23505' || e.cause?.code === '23505';
}

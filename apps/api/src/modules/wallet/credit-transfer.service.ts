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
  normalizeDigits,
  normalizeMobile,
  normalizeNationalId,
  type CreditTransferStatus,
  type CreditTransferView,
  type MyCreditTransferView,
  type PermissionCode,
  type RequestCreditTransfer,
} from '@sepehr/contracts';
import { sql } from 'drizzle-orm';
import type { EffectiveAccess } from '../../common/auth/access.port';
import { ACCOUNT_DIRECTORY, type AccountDirectory } from '../../common/auth/account-directory.port';
import {
  OTP_CHALLENGE,
  type OtpChallenge,
  type OtpChallengeMeta,
} from '../../common/auth/otp-challenge.port';
import { AUDIT_LOG, type Actor, type AuditLog } from '../../common/audit/audit.port';
import { CONFIG, type ConfigPort } from '../../common/config/config.port';
import {
  CREDIT_CONTRACT_FACTS,
  type CreditContractFacts,
  type CreditContractFactsPort,
} from '../../common/credit/credit-contract-facts.port';
import { OUTBOX, type OutboxPort } from '../../common/events/outbox.port';
import { LEAD_CASES, type LeadCases } from '../../common/lead/lead-cases.port';
import {
  PROFORMA_DIRECTORY,
  type ProformaDirectory,
} from '../../common/proforma/proforma-directory.port';
import { SERVICE_CONTROL, type ServiceControl } from '../../common/service/service-control.port';
import { WALLET, type WalletPort } from '../../common/wallet/wallet.port';
import { DATABASE, type Database } from '../../db/database.module';

type Tx = Parameters<Parameters<Database['transaction']>[0]>[0];

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const notFound = () => new NotFoundException({ error: 'credit_transfer_not_found' });
const conflict = (error: string, detail?: Record<string, unknown>) =>
  new ConflictException({ error, ...detail });

const ASK: PermissionCode = 'wallet.request_credit_transfer';
const DECIDE: PermissionCode = 'wallet.approve_credit_transfer';
/** One-time code purposes (OTP_CHALLENGE keeps each apart; stored as a hash, never logged). */
const RECIPIENT_PURPOSE = 'credit_recipient';
const CONSENT_PURPOSE = 'credit_transfer_consent';
const ACTIVE: readonly CreditTransferStatus[] = ['approved', 'revoke_requested'];

interface Row {
  id: string;
  purse_id: string;
  recipient_person_id: string;
  recipient_mobile: string;
  amount_rial: string;
  reason: string;
  status: CreditTransferStatus;
  requested_by: string;
  requested_at: string;
  recipient_verified_at: string | null;
  borrower_consented_at: string | null;
  decided_by: string | null;
  decided_at: string | null;
  decision_reason: string | null;
  revoke_requested_by: string | null;
  revoke_requested_at: string | null;
  revoke_reason: string | null;
  revoked_at: string | null;
  revoked_via: 'borrower' | 'finance' | null;
  paper_document_number: string | null;
  paper_received_at: string | null;
}

const iso = (c: string) =>
  `to_char(${c} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS ${c}`;
const COLUMNS = sql.raw(`id, purse_id, recipient_person_id, recipient_mobile,
  amount_rial::text AS amount_rial, reason, status, requested_by, ${iso('requested_at')},
  ${iso('recipient_verified_at')}, ${iso('borrower_consented_at')}, decided_by,
  ${iso('decided_at')}, decision_reason, revoke_requested_by, ${iso('revoke_requested_at')},
  revoke_reason, ${iso('revoked_at')}, revoked_via, paper_document_number,
  (SELECT to_char(p.received_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')
     FROM credit_transfer_paper_receipts p WHERE p.transfer_id = credit_transfers.id)
    AS paper_received_at`);

/**
 * Credit transfer to an AuthorizedRecipient (task 4-8 [financial], part 5; doc 12 §7, §9
 * test 11; owner 1405/07/14, س۳ to س۹). No ledger entry: the debt stays with the borrower.
 * ADR-047 (owner 1405/07/27): no cap but what the purse holds (a null cap); asked with the
 * number of the paper the borrower signed, approved only with that paper received.
 *
 * - Asked by case completion or accounting: the recipient (name, national ID, mobile) is a
 *   person of the lead module, never the borrower (س۹); a code goes to the recipient's mobile
 *   and one to the borrower's (consent, س۴); staff enter both as they are read to them.
 * - Approved by another person in accounting (س۵), while both codes are fresh (س۶), within
 *   the caps (amount, transfers per purse) and what the purse holds. The active recipient
 *   before is revoked; open authorizations are cancelled (their codes went elsewhere).
 * - Revoked by the borrower in the portal at once, or by two people in finance (س۷).
 *
 * Locks: the transfer, then the purse (FOR UPDATE), then the service module's
 * authorizations. Behind `wallet.credit_transfer_enabled` (س۳: off until the recipient's
 * mobile and national ID are matched, before launch).
 */
@Injectable()
export class CreditTransferService {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(AUDIT_LOG) private readonly audit: AuditLog,
    @Inject(OUTBOX) private readonly outbox: OutboxPort,
    @Inject(CONFIG) private readonly config: ConfigPort,
    @Inject(OTP_CHALLENGE) private readonly otp: OtpChallenge,
    @Inject(LEAD_CASES) private readonly leads: LeadCases,
    @Inject(WALLET) private readonly wallet: WalletPort,
    @Inject(SERVICE_CONTROL) private readonly services: ServiceControl,
    @Inject(CREDIT_CONTRACT_FACTS) private readonly facts: CreditContractFactsPort,
    @Inject(PROFORMA_DIRECTORY) private readonly proformas: ProformaDirectory,
    @Inject(ACCOUNT_DIRECTORY) private readonly accounts: AccountDirectory,
    @Inject(FINANCIAL_STEP_UP) private readonly stepUp: FinancialStepUp,
  ) {}

  // --- asking ----------------------------------------------------------------------------

  async request(
    actor: Actor,
    access: EffectiveAccess,
    input: RequestCreditTransfer,
    meta: OtpChallengeMeta,
  ): Promise<CreditTransferView> {
    this.require(access, ASK);
    await this.enabled();
    const facts = await this.reachable(access, input.purseId);
    const purse = await this.wallet.summary(input.purseId);
    if (purse.status !== 'funded') throw conflict('purse_not_funded', { status: purse.status });
    const nationalId = normalizeNationalId(input.recipient.nationalId);
    if (!nationalId) throw new UnprocessableEntityException({ error: 'invalid_national_id' });
    const mobile = normalizeMobile(input.recipient.mobile);
    if (!mobile) throw new UnprocessableEntityException({ error: 'invalid_mobile' });
    const borrowerMobile = await this.leads.mobileOf(facts.borrowerPersonId);
    if (!borrowerMobile) throw conflict('borrower_without_mobile');

    // ADR-052: the asker's own SMS code for this transfer and its amount.
    await this.stepUp.assert(actor, {
      type: 'credit_transfer',
      id: input.purseId,
      amountRial: BigInt(input.amountRial),
      step: 'request',
    });
    const row = await this.db
      .transaction(async (tx) => {
        const { personId } = await this.leads.recipientPerson(tx, actor, {
          mobile,
          nationalId,
          name: input.recipient.name,
        });
        // Owner س۹: anyone but the borrower (any of their merged persons).
        const borrower = await this.leads.samePersonIds(
          await this.leads.canonicalPersonId(facts.borrowerPersonId, tx),
          tx,
        );
        if (borrower.includes(personId)) throw conflict('recipient_is_borrower');
        const made = await tx.execute(sql`
          INSERT INTO credit_transfers (
            purse_id, recipient_person_id, recipient_mobile, amount_rial, reason, requested_by,
            paper_document_number
          ) VALUES (
            ${input.purseId}, ${personId}, ${mobile}, ${BigInt(input.amountRial)}, ${input.reason},
            ${actor.accountId}, ${input.paperDocumentNumber}
          )
          RETURNING ${COLUMNS}
        `);
        const created = made.rows[0] as unknown as Row;
        await this.audit.record(
          {
            actor,
            action: 'wallet.credit_transfer_requested',
            entityType: 'credit_transfer',
            entityId: created.id,
            after: { purseId: input.purseId, amountRial: input.amountRial },
            reason: input.reason,
          },
          tx,
        );
        await this.publish(tx, 'wallet.credit_transfer_requested', created);
        return created;
      })
      .catch((error: unknown) => {
        if (isUniqueViolation(error)) throw conflict('request_open');
        throw error;
      });
    await this.sendCodes(row, borrowerMobile, meta);
    return this.view(row, actor.accountId);
  }

  /** Both codes again (the limits of OTP_CHALLENGE apply: cooldown, lockout). */
  async resend(
    actor: Actor,
    access: EffectiveAccess,
    id: string,
    meta: OtpChallengeMeta,
  ): Promise<CreditTransferView> {
    this.require(access, ASK);
    await this.enabled();
    const row = await this.find(this.db, id);
    const facts = await this.reachable(access, row.purse_id);
    if (row.status !== 'awaiting_codes') throw conflict('not_awaiting_codes');
    const borrowerMobile = await this.leads.mobileOf(facts.borrowerPersonId);
    if (!borrowerMobile) throw conflict('borrower_without_mobile');
    await this.sendCodes(row, borrowerMobile, meta);
    return this.view(row, actor.accountId);
  }

  /**
   * The codes, as the recipient and the borrower read them to the staff member (owner س۴).
   * Each is recorded once checked; the transfer is asked for once both are.
   */
  async enterCodes(
    actor: Actor,
    access: EffectiveAccess,
    id: string,
    codes: { recipientCode: string; borrowerCode: string },
    meta: OtpChallengeMeta,
  ): Promise<CreditTransferView> {
    this.require(access, ASK);
    await this.enabled();
    const reached = await this.find(this.db, id);
    const facts = await this.reachable(access, reached.purse_id);
    if (reached.status !== 'awaiting_codes') throw conflict('not_awaiting_codes');
    if (!reached.recipient_verified_at) {
      await this.otp.verify(
        reached.recipient_mobile,
        RECIPIENT_PURPOSE,
        normalizeDigits(codes.recipientCode),
        meta,
      );
      await this.mark(actor, id, 'recipient_verified_at');
    }
    if (!reached.borrower_consented_at) {
      const borrowerMobile = await this.leads.mobileOf(facts.borrowerPersonId);
      if (!borrowerMobile) throw conflict('borrower_without_mobile');
      await this.otp.verify(
        borrowerMobile,
        CONSENT_PURPOSE,
        normalizeDigits(codes.borrowerCode),
        meta,
      );
      await this.mark(actor, id, 'borrower_consented_at');
    }
    const row = await this.db.transaction(async (tx) => {
      const locked = await this.lock(tx, id);
      if (locked.status !== 'awaiting_codes') return locked;
      const done = await tx.execute(sql`
        UPDATE credit_transfers SET status = 'requested'
        WHERE id = ${id} AND recipient_verified_at IS NOT NULL
          AND borrower_consented_at IS NOT NULL
        RETURNING ${COLUMNS}
      `);
      return (done.rows[0] as unknown as Row | undefined) ?? locked;
    });
    return this.view(row, actor.accountId);
  }

  // --- deciding --------------------------------------------------------------------------

  async approve(
    actor: Actor,
    access: EffectiveAccess,
    id: string,
    reason: string,
    paperReceived: boolean,
    now = new Date(),
  ): Promise<CreditTransferView> {
    this.require(access, DECIDE);
    await this.enabled();
    // ADR-047: finance approves only with the borrower's signed paper in hand.
    if (!paperReceived) throw new UnprocessableEntityException({ error: 'paper_receipt_required' });
    const reached = await this.find(this.db, id);
    await this.reachable(access, reached.purse_id);
    // ADR-052: the approver's own SMS code for this transfer and its amount.
    await this.stepUp.assert(actor, {
      type: 'credit_transfer',
      id,
      amountRial: BigInt(reached.amount_rial),
      step: 'approve',
    });
    const [validHours, limits] = await Promise.all([
      this.config.resolve('wallet.credit_transfer_code_valid_hours'),
      this.config.resolve('wallet.credit_transfer_limits'),
    ]);
    const row = await this.db.transaction(async (tx) => {
      const transfer = await this.lock(tx, id);
      // Approving twice changes nothing (rule 5).
      if (ACTIVE.includes(transfer.status) && transfer.decided_by === actor.accountId) {
        return transfer;
      }
      if (transfer.status !== 'requested')
        throw conflict('not_requested', { status: transfer.status });
      // Doc 12 §7, owner س۵: never the one who asked.
      if (transfer.requested_by === actor.accountId) throw conflict('same_person');
      // Owner س۶: both codes checked within the hours configured.
      const oldest = Math.min(
        new Date(transfer.recipient_verified_at ?? 0).getTime(),
        new Date(transfer.borrower_consented_at ?? 0).getTime(),
      );
      if (now.getTime() > oldest + validHours.value * 3_600_000) throw conflict('codes_expired');
      await tx.execute(
        sql`SELECT id FROM credit_purses WHERE id = ${transfer.purse_id} FOR UPDATE`,
      );
      const purse = await this.wallet.summary(transfer.purse_id, tx);
      if (purse.status !== 'funded') throw conflict('purse_not_funded', { status: purse.status });
      const amount = BigInt(transfer.amount_rial);
      // ADR-047: no cap (null) but what the purse holds, checked just below either way.
      const cap = limits.value.maxAmountRial === null ? null : BigInt(limits.value.maxAmountRial);
      if (cap !== null && amount > cap) {
        throw conflict('exceeds_transfer_cap', { capRial: cap.toString() });
      }
      if (amount > purse.balances.availableRial) throw conflict('exceeds_available');
      const counted = await tx.execute(sql`
        SELECT count(*)::int AS n FROM credit_transfers
        WHERE purse_id = ${transfer.purse_id} AND decided_at IS NOT NULL AND status <> 'rejected'
      `);
      if (Number(counted.rows[0]?.['n']) >= limits.value.maxPerPurse) {
        throw conflict('transfer_limit_reached', { max: limits.value.maxPerPurse });
      }
      // One recipient at a time: the one before is revoked, by these two people.
      const before = await tx.execute(sql`
        SELECT ${COLUMNS} FROM credit_transfers
        WHERE purse_id = ${transfer.purse_id} AND status IN ('approved', 'revoke_requested')
        FOR UPDATE
      `);
      for (const old of before.rows as unknown as Row[]) {
        await tx.execute(sql`
          UPDATE credit_transfers
          SET status = 'revoked', revoke_requested_by = ${transfer.requested_by},
              revoke_requested_at = coalesce(revoke_requested_at, ${now}),
              revoke_reason = coalesce(revoke_reason, ${`جایگزین با انتقال ${id}`}),
              revoked_by = ${actor.accountId}, revoked_at = ${now}, revoked_via = 'finance'
          WHERE id = ${old.id}
        `);
        await this.publish(tx, 'wallet.credit_transfer_revoked', old, 'finance');
      }
      // Their codes went to the mobile before: cancelled (a recorded one not final stops it).
      await this.services.cancelOpen(actor, transfer.purse_id, `انتقال اعتبار: ${reason}`, tx);
      // ADR-047: the signed paper's receipt, once, by who approves (append-only).
      await tx.execute(sql`
        INSERT INTO credit_transfer_paper_receipts (transfer_id, received_by, received_at)
        VALUES (${id}, ${actor.accountId}, ${now})
      `);
      const done = await tx.execute(sql`
        UPDATE credit_transfers
        SET status = 'approved', decided_by = ${actor.accountId}, decided_at = ${now},
            decision_reason = ${reason}
        WHERE id = ${id}
        RETURNING ${COLUMNS}
      `);
      const approved = done.rows[0] as unknown as Row;
      await this.audit.record(
        {
          actor,
          action: 'wallet.credit_transfer_approved',
          entityType: 'credit_transfer',
          entityId: id,
          before: { status: 'requested' },
          after: {
            status: 'approved',
            amountRial: transfer.amount_rial,
            paperDocumentNumber: transfer.paper_document_number,
            paperReceived: true,
          },
          reason,
        },
        tx,
      );
      await this.publish(tx, 'wallet.credit_transfer_approved', approved);
      return approved;
    });
    return this.view(row, actor.accountId);
  }

  async reject(
    actor: Actor,
    access: EffectiveAccess,
    id: string,
    reason: string,
  ): Promise<CreditTransferView> {
    this.require(access, DECIDE);
    const reached = await this.find(this.db, id);
    await this.reachable(access, reached.purse_id);
    const row = await this.db.transaction(async (tx) => {
      const transfer = await this.lock(tx, id);
      if (transfer.status !== 'awaiting_codes' && transfer.status !== 'requested') {
        throw conflict('not_requested', { status: transfer.status });
      }
      if (transfer.requested_by === actor.accountId) throw conflict('same_person');
      const done = await tx.execute(sql`
        UPDATE credit_transfers
        SET status = 'rejected', decided_by = ${actor.accountId}, decided_at = now(),
            decision_reason = ${reason}
        WHERE id = ${id}
        RETURNING ${COLUMNS}
      `);
      const rejected = done.rows[0] as unknown as Row;
      await this.audit.record(
        {
          actor,
          action: 'wallet.credit_transfer_rejected',
          entityType: 'credit_transfer',
          entityId: id,
          before: { status: transfer.status },
          after: { status: 'rejected' },
          reason,
        },
        tx,
      );
      await this.publish(tx, 'wallet.credit_transfer_rejected', rejected);
      return rejected;
    });
    return this.view(row, actor.accountId);
  }

  // --- revoking (owner س۷) ---------------------------------------------------------------

  /** Finance, first of two: asks for the recipient to be revoked. */
  async requestRevoke(
    actor: Actor,
    access: EffectiveAccess,
    id: string,
    reason: string,
  ): Promise<CreditTransferView> {
    this.require(access, ASK);
    const reached = await this.find(this.db, id);
    await this.reachable(access, reached.purse_id);
    // ADR-052: undoing a transfer is signed like the transfer itself.
    await this.stepUp.assert(actor, {
      type: 'credit_transfer',
      id,
      amountRial: BigInt(reached.amount_rial),
      step: 'request',
    });
    const row = await this.db.transaction(async (tx) => {
      const transfer = await this.lock(tx, id);
      if (transfer.status !== 'approved') throw conflict('not_active', { status: transfer.status });
      const done = await tx.execute(sql`
        UPDATE credit_transfers
        SET status = 'revoke_requested', revoke_requested_by = ${actor.accountId},
            revoke_requested_at = now(), revoke_reason = ${reason}
        WHERE id = ${id}
        RETURNING ${COLUMNS}
      `);
      const asked = done.rows[0] as unknown as Row;
      await this.audit.record(
        {
          actor,
          action: 'wallet.credit_transfer_revoke_requested',
          entityType: 'credit_transfer',
          entityId: id,
          before: { status: 'approved' },
          after: { status: 'revoke_requested' },
          reason,
        },
        tx,
      );
      await this.publish(tx, 'wallet.credit_transfer_revoke_requested', asked);
      return asked;
    });
    return this.view(row, actor.accountId);
  }

  /** Finance, second of two: revokes it, or (`keep`) leaves the recipient as they are. */
  async decideRevoke(
    actor: Actor,
    access: EffectiveAccess,
    id: string,
    reason: string,
    keep: boolean,
  ): Promise<CreditTransferView> {
    this.require(access, DECIDE);
    const reached = await this.find(this.db, id);
    await this.reachable(access, reached.purse_id);
    await this.stepUp.assert(actor, {
      type: 'credit_transfer',
      id,
      amountRial: BigInt(reached.amount_rial),
      step: 'approve',
    });
    const row = await this.db.transaction(async (tx) => {
      const transfer = await this.lock(tx, id);
      if (transfer.status === 'revoked' && !keep) return transfer;
      if (transfer.status !== 'revoke_requested') {
        throw conflict('not_revoke_requested', { status: transfer.status });
      }
      if (transfer.revoke_requested_by === actor.accountId) throw conflict('same_person');
      if (keep) {
        const kept = await tx.execute(sql`
          UPDATE credit_transfers
          SET status = 'approved', revoke_requested_by = NULL, revoke_requested_at = NULL,
              revoke_reason = NULL
          WHERE id = ${id}
          RETURNING ${COLUMNS}
        `);
        await this.audit.record(
          {
            actor,
            action: 'wallet.credit_transfer_revoke_declined',
            entityType: 'credit_transfer',
            entityId: id,
            before: { status: 'revoke_requested' },
            after: { status: 'approved' },
            reason,
          },
          tx,
        );
        return kept.rows[0] as unknown as Row;
      }
      return this.revoke(tx, actor, transfer, 'finance', reason);
    });
    return this.view(row, actor.accountId);
  }

  // --- the borrower's (portal) -----------------------------------------------------------

  async mine(accountId: string, creditApplicationId: string): Promise<MyCreditTransferView[]> {
    const purseId = await this.ownPurse(accountId, creditApplicationId);
    if (!purseId) return [];
    const rows = await this.db.execute(sql`
      SELECT ${COLUMNS} FROM credit_transfers
      WHERE purse_id = ${purseId} AND status IN ('approved', 'revoke_requested', 'revoked')
      ORDER BY requested_at DESC
    `);
    const out: MyCreditTransferView[] = [];
    for (const r of rows.rows as unknown as Row[]) {
      out.push({
        id: r.id,
        purseId: r.purse_id,
        status: r.status,
        recipientName: await this.leads.displayNameOf(r.recipient_person_id),
        amountRial: r.amount_rial,
        decidedAt: r.decided_at,
        revokedAt: r.revoked_at,
      });
    }
    return out;
  }

  /** The borrower revokes their recipient at once (owner س۷). */
  async revokeMine(
    actor: Actor,
    accountId: string,
    creditApplicationId: string,
    id: string,
    reason: string | undefined,
  ): Promise<MyCreditTransferView[]> {
    const purseId = await this.ownPurse(accountId, creditApplicationId);
    if (!purseId || !UUID.test(id)) throw notFound();
    await this.db.transaction(async (tx) => {
      const transfer = await this.lock(tx, id);
      if (transfer.purse_id !== purseId) throw notFound();
      if (transfer.status === 'revoked') return;
      if (!ACTIVE.includes(transfer.status))
        throw conflict('not_active', { status: transfer.status });
      await this.revoke(tx, actor, transfer, 'borrower', reason ?? 'ابطال به درخواست وام‌گیرنده');
    });
    return this.mine(accountId, creditApplicationId);
  }

  async list(
    actor: Actor,
    access: EffectiveAccess,
    query: { purseId?: string | undefined; status?: CreditTransferStatus | undefined },
  ): Promise<CreditTransferView[]> {
    if (!access.permissions.has(ASK) && !access.permissions.has(DECIDE)) {
      throw new ForbiddenException({ error: 'permission_required' });
    }
    const rows = await this.db.execute(sql`
      SELECT ${COLUMNS} FROM credit_transfers
      WHERE (${query.purseId ?? null}::uuid IS NULL OR purse_id = ${query.purseId ?? null})
        AND (${query.status ?? null}::text IS NULL OR status = ${query.status ?? null})
      ORDER BY requested_at DESC LIMIT 500
    `);
    const out: CreditTransferView[] = [];
    for (const r of rows.rows as unknown as Row[]) {
      const ok = await this.reachable(access, r.purse_id).then(
        () => true,
        () => false,
      );
      if (ok) out.push(await this.view(r, actor.accountId));
    }
    return out;
  }

  // --- helpers ---------------------------------------------------------------------------

  private async revoke(
    tx: Tx,
    actor: Actor,
    transfer: Row,
    via: 'borrower' | 'finance',
    reason: string,
  ): Promise<Row> {
    // Codes sent to the recipient's mobile are cancelled with them (a recorded one not final
    // stops it, as with a doctor change).
    await this.services.cancelOpen(actor, transfer.purse_id, `ابطال گیرنده: ${reason}`, tx);
    const done = await tx.execute(sql`
      UPDATE credit_transfers
      SET status = 'revoked', revoked_by = ${actor.accountId}, revoked_at = now(),
          revoked_via = ${via}, revoke_reason = coalesce(revoke_reason, ${reason})
      WHERE id = ${transfer.id}
      RETURNING ${COLUMNS}
    `);
    const revoked = done.rows[0] as unknown as Row;
    await this.audit.record(
      {
        actor,
        action: 'wallet.credit_transfer_revoked',
        entityType: 'credit_transfer',
        entityId: transfer.id,
        before: { status: transfer.status },
        after: { status: 'revoked', via },
        reason,
      },
      tx,
    );
    await this.publish(tx, 'wallet.credit_transfer_revoked', revoked, via);
    return revoked;
  }

  /** The two codes after the commit; neither is stored here, logged or returned. */
  private async sendCodes(row: Row, borrowerMobile: string, meta: OtpChallengeMeta) {
    await this.otp.send(row.recipient_mobile, RECIPIENT_PURPOSE, meta);
    await this.otp.send(borrowerMobile, CONSENT_PURPOSE, meta);
  }

  private async mark(
    actor: Actor,
    id: string,
    column: 'recipient_verified_at' | 'borrower_consented_at',
  ) {
    await this.db.transaction(async (tx) => {
      await this.lock(tx, id);
      await tx.execute(sql`
        UPDATE credit_transfers SET ${sql.raw(column)} = now()
        WHERE id = ${id} AND status = 'awaiting_codes' AND ${sql.raw(column)} IS NULL
      `);
      await this.audit.record(
        {
          actor,
          action:
            column === 'recipient_verified_at'
              ? 'wallet.credit_transfer_recipient_verified'
              : 'wallet.credit_transfer_borrower_consented',
          entityType: 'credit_transfer',
          entityId: id,
        },
        tx,
      );
    });
  }

  private async enabled() {
    if (!(await this.config.resolve('wallet.credit_transfer_enabled')).value) {
      throw new NotFoundException({ error: 'feature_disabled' });
    }
  }

  private async find(ex: Database | Tx, id: string): Promise<Row> {
    if (!UUID.test(id)) throw notFound();
    const rows = await ex.execute(sql`SELECT ${COLUMNS} FROM credit_transfers WHERE id = ${id}`);
    const row = rows.rows[0] as unknown as Row | undefined;
    if (!row) throw notFound();
    return row;
  }

  private async lock(tx: Tx, id: string): Promise<Row> {
    if (!UUID.test(id)) throw notFound();
    const rows = await tx.execute(
      sql`SELECT ${COLUMNS} FROM credit_transfers WHERE id = ${id} FOR UPDATE`,
    );
    const row = rows.rows[0] as unknown as Row | undefined;
    if (!row) throw notFound();
    return row;
  }

  /** Staff reach a purse whose application is of their city, or any with a global scope. */
  private async reachable(access: EffectiveAccess, purseId: string): Promise<CreditContractFacts> {
    const missing = () => new NotFoundException({ error: 'purse_not_found' });
    if (!UUID.test(purseId)) throw missing();
    const rows = await this.db.execute(
      sql`SELECT credit_application_id FROM credit_purses WHERE id = ${purseId}`,
    );
    const applicationId = rows.rows[0]?.['credit_application_id'] as string | null | undefined;
    const facts = applicationId ? await this.facts.facts(applicationId) : null;
    if (!facts) throw missing();
    if (access.scopes.some((s) => s.kind === 'global')) return facts;
    const proforma = await this.proformas.proforma(facts.proformaId);
    const cities = access.scopes.flatMap((s) => (s.kind === 'city' ? [s.code] : []));
    if (!proforma || !cities.includes(proforma.cityCode)) throw missing();
    return facts;
  }

  /** The borrower's own purse of this application (rule 13): the borrower only, not the patient. */
  private async ownPurse(accountId: string, creditApplicationId: string): Promise<string | null> {
    const notMine = new NotFoundException({ error: 'credit_application_not_found' });
    if (!UUID.test(creditApplicationId)) throw notMine;
    const account = await this.accounts.find(accountId);
    if (!account || account.kind !== 'patient') {
      throw new ForbiddenException({ error: 'patients_only' });
    }
    if (!account.personId) throw notMine;
    const persons = await this.leads.samePersonIds(
      await this.leads.canonicalPersonId(account.personId),
    );
    const facts = await this.facts.facts(creditApplicationId);
    if (!facts || !persons.includes(facts.borrowerPersonId)) throw notMine;
    return this.wallet.purseOfApplication(creditApplicationId);
  }

  private async view(r: Row, viewer: string | null): Promise<CreditTransferView> {
    return {
      id: r.id,
      purseId: r.purse_id,
      status: r.status,
      recipientName: await this.leads.displayNameOf(r.recipient_person_id),
      recipientMobileLast4: r.recipient_mobile.slice(-4),
      amountRial: r.amount_rial,
      reason: r.reason,
      paperDocumentNumber: r.paper_document_number,
      paperReceivedAt: r.paper_received_at,
      requestedAt: r.requested_at,
      requestedByMe: viewer !== null && r.requested_by === viewer,
      recipientVerifiedAt: r.recipient_verified_at,
      borrowerConsentedAt: r.borrower_consented_at,
      decidedAt: r.decided_at,
      decisionReason: r.decision_reason,
      revokeRequestedAt: r.revoke_requested_at,
      revokeRequestedByMe: viewer !== null && r.revoke_requested_by === viewer,
      revokeReason: r.revoke_reason,
      revokedAt: r.revoked_at,
      revokedVia: r.revoked_via,
    };
  }

  private async publish(
    tx: Tx,
    type: string,
    row: Row,
    via?: 'borrower' | 'finance',
  ): Promise<void> {
    await this.outbox.publish(
      {
        type,
        aggregateType: 'credit_transfer',
        aggregateId: row.id,
        payload: { transferId: row.id, purseId: row.purse_id, ...(via ? { via } : {}) },
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

function isUniqueViolation(error: unknown): boolean {
  const e = error as { code?: string; cause?: { code?: string } };
  return e.code === '23505' || e.cause?.code === '23505';
}

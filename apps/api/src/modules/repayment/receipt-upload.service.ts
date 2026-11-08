import { ForbiddenException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { nominalDueOn, type MyPayment, type MySchedule } from '@sepehr/contracts';
import { sql } from 'drizzle-orm';
import { ACCOUNT_DIRECTORY, type AccountDirectory } from '../../common/auth/account-directory.port';
import type { Actor } from '../../common/audit/audit.port';
import { LEAD_CASES, type LeadCases } from '../../common/lead/lead-cases.port';
import { PAYMENT_PROVIDER, type PaymentProvider } from '../../common/payment/payment-provider.port';
import { REPAYMENT, type RepaymentPort } from '../../common/repayment/repayment.port';
import { WALLET, type WalletPort } from '../../common/wallet/wallet.port';
import { DATABASE, type Database } from '../../db/database.module';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * A borrower's own payment slip (task 6-2 [financial]; doc 15 §2): only for a schedule of a
 * loan they borrowed (rule 13); the image scanned and kept in private space through the
 * PaymentProvider (ADR-009: the manual receipt today); then phase 1's registerReceipt,
 * which posts the pending receipt at once (doc 02 §4; owner's answer to incompatibility 5).
 */
@Injectable()
export class ReceiptUploadService {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(ACCOUNT_DIRECTORY) private readonly accounts: AccountDirectory,
    @Inject(LEAD_CASES) private readonly leads: LeadCases,
    @Inject(WALLET) private readonly wallet: WalletPort,
    @Inject(REPAYMENT) private readonly repayment: RepaymentPort,
    @Inject(PAYMENT_PROVIDER) private readonly provider: PaymentProvider,
  ) {}

  async upload(
    actor: Actor,
    accountId: string,
    input: {
      scheduleId: string;
      amountRial: bigint;
      paidOn: string;
      bankRef: string;
      payerName: string;
    },
    file: { buffer: Buffer } | undefined,
    idempotencyKey: string,
  ): Promise<{ paymentId: string; suspectedDuplicate: boolean }> {
    if (!file) throw new NotFoundException({ error: 'file_required' });
    await this.ownSchedule(accountId, input.scheduleId);
    const id = (await this.db.execute(sql`SELECT uuidv7() AS id`)).rows[0]?.['id'] as string;
    const evidence = await this.provider.keepEvidence(
      `repayment-receipts/${input.scheduleId}/${id}`,
      file.buffer,
    );
    const { paymentId } = await this.repayment.registerReceipt(actor, {
      idempotencyKey,
      scheduleId: input.scheduleId,
      amountRial: input.amountRial,
      // The moment it was recorded; the day it was paid is the slip's.
      receivedAt: new Date(),
      reference: input.bankRef,
      channel: 'manual_receipt',
      paidOn: input.paidOn,
      payerName: input.payerName,
      submittedByAccountId: accountId,
      image: { key: evidence.storageKey, mime: evidence.mime, sha256: evidence.sha256 },
    });
    const row = (
      await this.db.execute(sql`
        SELECT suspected_duplicate_of FROM payments WHERE id = ${paymentId}
      `)
    ).rows[0];
    return { paymentId, suspectedDuplicate: Boolean(row?.['suspected_duplicate_of']) };
  }

  /**
   * Task 6-9: the schedule of one of the patient's loans, by its application; nothing for a
   * loan that is not theirs (or not funded yet).
   */
  async mySchedules(accountId: string, creditApplicationId: string): Promise<MySchedule[]> {
    const persons = await this.personsOf(accountId);
    const purse = await this.wallet.purseOfApplication(creditApplicationId);
    if (!purse) return [];
    const summary = await this.wallet.summary(purse);
    if (!persons.includes(summary.borrowerPersonId)) return [];
    const scheduleId = await this.wallet.scheduleOfPurse(purse);
    if (!scheduleId) return [];
    const s = await this.repayment.schedule(scheduleId);
    // Read only (owner 1405/07/24): where a due day was moved to a working day at funding,
    // its nominal day, from the stored funding time. Nothing stored is read differently.
    const movedFrom = (index: number, dueOn: string) => {
      if (!s.dueDatesShifted) return null;
      const nominal = nominalDueOn(s.fundedAt, index);
      return nominal === dueOn ? null : nominal;
    };
    return [
      {
        id: s.id,
        totalRial: s.totalRial.toString(),
        paidRial: s.paidRial.toString(),
        outstandingRial: s.outstandingRial.toString(),
        installments: s.installments.map((i) => ({
          id: i.id,
          index: i.index,
          dueOn: i.dueOn,
          movedFrom: movedFrom(i.index, i.dueOn),
          amountRial: i.amountRial.toString(),
          paidRial: i.paidRial.toString(),
          outstandingRial: i.outstandingRial.toString(),
          status: i.status,
        })),
      },
    ];
  }

  /** Task 6-9: the slips and payments of the patient's own schedule, newest first. */
  async myPayments(accountId: string, scheduleId: string): Promise<MyPayment[]> {
    await this.ownSchedule(accountId, scheduleId);
    const rows = await this.db.execute(sql`
      SELECT id, amount_rial::text AS amount, paid_on::text AS paid_on, reference, channel,
             status, reject_kind, CASE WHEN status = 'rejected' THEN decision_reason END AS reason,
             to_char(received_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS received_at
      FROM payments WHERE schedule_id = ${scheduleId}
      ORDER BY received_at DESC, id DESC
    `);
    return rows.rows.map((r) => ({
      id: r['id'] as string,
      amountRial: r['amount'] as string,
      paidOn: (r['paid_on'] as string | null) ?? null,
      bankRef: (r['reference'] as string | null) ?? null,
      channel: r['channel'] as MyPayment['channel'],
      status: r['status'] as MyPayment['status'],
      rejectKind: (r['reject_kind'] as MyPayment['rejectKind']) ?? null,
      rejectReason: (r['reason'] as string | null) ?? null,
      receivedAt: r['received_at'] as string,
    }));
  }

  private async personsOf(accountId: string): Promise<string[]> {
    const account = await this.accounts.find(accountId);
    if (account?.kind !== 'patient') throw new ForbiddenException({ error: 'patients_only' });
    if (!account.personId) return [];
    return this.leads.samePersonIds(await this.leads.canonicalPersonId(account.personId));
  }

  /** The schedule's loan was borrowed by this patient (any of their merged persons). */
  private async ownSchedule(accountId: string, scheduleId: string): Promise<void> {
    const account = await this.accounts.find(accountId);
    if (account?.kind !== 'patient') throw new ForbiddenException({ error: 'patients_only' });
    const notFound = new NotFoundException({ error: 'schedule_not_found' });
    if (!account.personId || !UUID.test(scheduleId)) throw notFound;
    const persons = await this.leads.samePersonIds(
      await this.leads.canonicalPersonId(account.personId),
    );
    const purse = (
      await this.db.execute(
        sql`SELECT purse_id FROM installment_schedules WHERE id = ${scheduleId}`,
      )
    ).rows[0]?.['purse_id'] as string | undefined;
    if (!purse) throw notFound;
    const summary = await this.wallet.summary(purse);
    if (!persons.includes(summary.borrowerPersonId)) throw notFound;
  }
}

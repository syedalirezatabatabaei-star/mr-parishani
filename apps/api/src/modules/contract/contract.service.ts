import {
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  formatJalaliDate,
  toJalali,
  formatToman,
  toPersianDigits,
  type ContractView,
  type PermissionCode,
} from '@sepehr/contracts';
import { and, desc, eq, sql } from 'drizzle-orm';
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
import { OBJECT_STORAGE, type ObjectStorage } from '../../common/storage/object-storage.port';
import { DATABASE, type Database } from '../../db/database.module';
import { storageUnavailable } from '../../infra/s3-storage';
import { contractAcceptances, contracts } from './contract.schema';

type Tx = Parameters<Parameters<Database['transaction']>[0]>[0];
type ContractRow = typeof contracts.$inferSelect;
type Role = 'borrower' | 'guarantor';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ACCEPTANCE_PURPOSE = 'contract_acceptance';
/** How long a contract's signed link lives. */
const LINK_SECONDS = 300;
const notFound = () => new NotFoundException({ error: 'contract_not_found' });

/**
 * Rials as people read them in the contract: exact tomans and rials, never truncated
 * (ADR-035), by the shared formatter of @sepehr/contracts.
 */
export const tomans = (rial: bigint) => formatToman(rial);

/**
 * ADR-035, in the contract's own words: printed with the amounts of a plan that rounds
 * its shares (the template places it, or the printer adds it under the text).
 */
export const ROUNDING_NOTE =
  'مبالغ درصدی (پیش‌پرداخت، کارمزد طرح و هزینه تشکیل پرونده) رو به پایین به مضرب ۱۰ ریال گرد شده‌اند؛ مبلغ وام برابر سهم پیش‌فاکتور منهای پیش‌پرداخت است.';

const maskMobile = (mobile: string | null) =>
  mobile ? toPersianDigits(`0${mobile.slice(0, 3)}***${mobile.slice(-4)}`) : '—';

/** A Gregorian day (YYYY-MM-DD) of the API, in Jalali. */
/** A Gregorian day as the contract prints it; the terms service reads it back (plan 3). */
export const jalaliDay = (day: string) => formatJalaliDate(toJalali(new Date(`${day}T12:00:00Z`)));

/** Basis points as a percent, «۱۸٪» or «۱۲٫۵٪». */
const percent = (bps: number) => `${toPersianDigits(String(bps / 100).replace('.', '٫'))}٪`;

/**
 * Loan contracts (task 4-1; doc 12 §2).
 *
 * - Case completion asks for the contract of an approved (or conditionally approved)
 *   credit application. Its values are taken then, once: the approved amount and the
 *   preview of the decision (task 3-6), the cancellation penalty in force
 *   (`repayment.cancellation_penalty_bps`, doc 02 §6), the parties' names; and the template
 *   version in force is locked (rule 16). A number is drawn per lender and Jalali year.
 * - The worker prints it to a PDF (ContractPrinter), stored in private space with its
 *   SHA-256, which never changes: a later template changes no contract already made.
 * - The borrower and each guarantor accept it themselves with a one-time code, of that PDF
 *   (its hash); when all have, it is accepted.
 */
@Injectable()
export class ContractService {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(AUDIT_LOG) private readonly audit: AuditLog,
    @Inject(OUTBOX) private readonly outbox: OutboxPort,
    @Inject(CONFIG) private readonly config: ConfigPort,
    @Inject(CREDIT_CONTRACT_FACTS) private readonly credit: CreditContractFactsPort,
    @Inject(LEAD_CASES) private readonly leads: LeadCases,
    @Inject(PROFORMA_DIRECTORY) private readonly proformas: ProformaDirectory,
    @Inject(ACCOUNT_DIRECTORY) private readonly accounts: AccountDirectory,
    @Inject(OTP_CHALLENGE) private readonly otp: OtpChallenge,
    @Inject(OBJECT_STORAGE) private readonly storage: ObjectStorage,
  ) {}

  // --- staff ------------------------------------------------------------------------

  async generate(
    actor: Actor,
    access: EffectiveAccess,
    creditApplicationId: string,
    now = new Date(),
  ) {
    this.require(access, 'contract.generate');
    const facts = await this.reachable(access, creditApplicationId);
    if (
      (facts.status !== 'approved' && facts.status !== 'conditional') ||
      facts.approvedAmountRial === null
    ) {
      throw new ConflictException({ error: 'not_approved', status: facts.status });
    }
    const template = await this.config.resolve('contract.loan_template', {}, now);
    const penalty = await this.config.resolve('repayment.cancellation_penalty_bps', {}, now);
    const year = toJalali(now).year;
    const parties = [
      { role: 'borrower' as const, personId: facts.borrowerPersonId, guarantorId: null },
      ...facts.guarantors.map((g) => ({
        role: 'guarantor' as const,
        personId: g.personId,
        guarantorId: g.id,
      })),
    ];
    // Owner پ۱۳ and س۴: the case's approved rate, else the configured one; locked here.
    const penaltyBps = facts.penaltyOverride?.bps ?? penalty.value;
    const values = await this.values(facts, penaltyBps, now);

    const row = await this.db
      .transaction(async (tx) => {
        const drawn = await tx.execute(sql`
          INSERT INTO contract_number_sequences (entity_id, jalali_year, last_value)
          VALUES (${template.value.lender.entityId}, ${year}, 1)
          ON CONFLICT (entity_id, jalali_year)
          DO UPDATE SET last_value = contract_number_sequences.last_value + 1
          RETURNING last_value`);
        const sequence = Number(drawn.rows[0]?.['last_value']);
        const number = `${String(year)}-${String(sequence).padStart(6, '0')}`;
        const [made] = await tx
          .insert(contracts)
          .values({
            creditApplicationId: facts.creditApplicationId,
            entityId: template.value.lender.entityId,
            jalaliYear: year,
            sequence,
            number,
            templateVersionId: template.versionId,
            fields: {
              ...values,
              'contract.number': toPersianDigits(number),
              'lender.name': template.value.lender.name,
            },
            sample: template.value.sample,
            parties,
            createdBy: actor.accountId ?? '',
          })
          .returning();
        if (!made) throw new Error('contract insert returned nothing');
        await tx.execute(sql`
          INSERT INTO contract_penalty_terms (
            contract_id, credit_application_id, penalty_bps, source, config_version_id, override_id
          ) VALUES (
            ${made.id}, ${made.creditApplicationId}, ${penaltyBps},
            ${facts.penaltyOverride ? 'override' : 'config'},
            ${facts.penaltyOverride ? null : penalty.versionId}, ${facts.penaltyOverride?.id ?? null}
          )
        `);
        await this.audit.record(
          {
            actor,
            action: 'contract.requested',
            entityType: 'contract',
            entityId: made.id,
            after: {
              creditApplicationId: made.creditApplicationId,
              number: made.number,
              templateVersionId: made.templateVersionId,
              penaltyVersionId: penalty.versionId,
              penaltyBps,
              penaltyOverrideId: facts.penaltyOverride?.id ?? null,
            },
          },
          tx,
        );
        await this.publish(tx, 'contract.requested', made);
        return made;
      })
      .catch((error: unknown) => {
        const e = error as { code?: string; cause?: { code?: string } };
        if (e.code === '23505' || e.cause?.code === '23505') {
          throw new ConflictException({ error: 'contract_exists' });
        }
        throw error;
      });
    return this.view(row);
  }

  async forApplication(
    access: EffectiveAccess,
    creditApplicationId: string,
  ): Promise<ContractView[]> {
    this.require(access, 'contract.read');
    const facts = await this.reachable(access, creditApplicationId);
    const rows = await this.db
      .select()
      .from(contracts)
      .where(eq(contracts.creditApplicationId, facts.creditApplicationId))
      .orderBy(desc(contracts.createdAt));
    return Promise.all(rows.map((r) => this.view(r)));
  }

  async get(access: EffectiveAccess, id: string): Promise<ContractView> {
    this.require(access, 'contract.read');
    return this.view(await this.staffRow(access, id));
  }

  async staffLink(actor: Actor, access: EffectiveAccess, id: string) {
    this.require(access, 'contract.read');
    return this.link(actor, await this.staffRow(access, id));
  }

  // --- the parties ------------------------------------------------------------------

  async mine(accountId: string): Promise<ContractView[]> {
    const persons = await this.personsOf(accountId);
    if (persons.length === 0) return [];
    const rows = await this.db
      .select()
      .from(contracts)
      .where(
        sql`${contracts.status} <> 'failed' AND (${sql.join(
          persons.map(
            (p) => sql`${contracts.parties} @> ${JSON.stringify([{ personId: p }])}::jsonb`,
          ),
          sql` OR `,
        )})`,
      )
      .orderBy(desc(contracts.createdAt));
    return Promise.all(rows.map((r) => this.view(r, persons)));
  }

  async getMine(accountId: string, id: string): Promise<ContractView> {
    const { row, persons } = await this.ownRow(accountId, id);
    return this.view(row, persons);
  }

  async ownLink(actor: Actor, accountId: string, id: string) {
    const { row } = await this.ownRow(accountId, id);
    return this.link(actor, row);
  }

  async requestAcceptance(accountId: string, id: string, role: Role, meta: OtpChallengeMeta) {
    const { row, mobile } = await this.acceptor(accountId, id, role);
    if (row.status !== 'ready')
      throw new ConflictException({ error: 'not_ready', status: row.status });
    return this.otp.send(mobile, ACCEPTANCE_PURPOSE, meta);
  }

  async accept(
    actor: Actor,
    accountId: string,
    id: string,
    role: Role,
    code: string,
    meta: OtpChallengeMeta,
    now = new Date(),
  ): Promise<ContractView> {
    const { row: reached, mobile, party } = await this.acceptor(accountId, id, role);
    if (reached.status !== 'ready') {
      throw new ConflictException({ error: 'not_ready', status: reached.status });
    }
    await this.otp.verify(mobile, ACCEPTANCE_PURPOSE, code, meta, now);
    const row = await this.db
      .transaction(async (tx) => {
        const [locked] = await tx
          .select()
          .from(contracts)
          .where(eq(contracts.id, reached.id))
          .for('update');
        if (!locked) throw notFound();
        if (locked.status !== 'ready' || locked.sha256 === null) {
          throw new ConflictException({ error: 'not_ready', status: locked.status });
        }
        await tx.insert(contractAcceptances).values({
          contractId: locked.id,
          role,
          personId: party.personId,
          guarantorId: party.guarantorId,
          accountId,
          templateVersionId: locked.templateVersionId,
          pdfSha256: locked.sha256,
          sessionId: actor.sessionId,
          ip: meta.ip,
          deviceId: meta.deviceId ?? null,
        });
        await this.audit.record(
          {
            actor,
            action: 'contract.accepted_by_party',
            entityType: 'contract',
            entityId: locked.id,
            after: { role, guarantorId: party.guarantorId, pdfSha256: locked.sha256 },
          },
          tx,
        );
        const accepted = await tx
          .select({ personId: contractAcceptances.personId, role: contractAcceptances.role })
          .from(contractAcceptances)
          .where(eq(contractAcceptances.contractId, locked.id));
        const all = locked.parties.every((p) =>
          accepted.some((a) => a.personId === p.personId && a.role === p.role),
        );
        if (!all) return locked;
        const [done] = await tx
          .update(contracts)
          .set({ status: 'accepted', acceptedAt: now })
          .where(eq(contracts.id, locked.id))
          .returning();
        if (!done) throw new Error('contract update returned nothing');
        await this.publish(tx, 'contract.accepted', done);
        return done;
      })
      .catch((error: unknown) => {
        const e = error as { code?: string; cause?: { code?: string } };
        if (e.code === '23505' || e.cause?.code === '23505') {
          throw new ConflictException({ error: 'already_accepted' });
        }
        throw error;
      });
    return this.view(row, await this.personsOf(accountId));
  }

  // --- helpers ----------------------------------------------------------------------

  /** The values of the template's fields, as the contract shows them. */
  private async values(
    facts: CreditContractFacts,
    penaltyBps: number,
    now: Date,
  ): Promise<Record<string, string>> {
    const name = async (personId: string) => (await this.leads.displayNameOf(personId)) ?? '—';
    const guarantorNames = await Promise.all(facts.guarantors.map((g) => name(g.personId)));
    return {
      'contract.date': formatJalaliDate(toJalali(now)),
      'borrower.name': await name(facts.borrowerPersonId),
      'borrower.mobile': maskMobile(await this.leads.mobileOf(facts.borrowerPersonId)),
      'guarantors.names': guarantorNames.length > 0 ? guarantorNames.join('، ') : 'ندارد',
      'plan.title': facts.planTitle,
      'installments.count': toPersianDigits(String(facts.installmentCount)),
      'loan.amount': tomans(facts.approvedAmountRial ?? 0n),
      'downPayment.amount': tomans(facts.downPaymentRial),
      'originationFee.amount': tomans(facts.originationFeeRial),
      'planFee.amount': tomans(facts.planFeeRial),
      'totalObligation.amount': tomans(facts.totalObligationRial),
      'cancellation.penaltyPercent': percent(penaltyBps),
      'amounts.roundingNote': facts.percentRoundingRial ? ROUNDING_NOTE : '',
      // The table, as rows the printer lays out (contract-html.ts).
      'installments.table': JSON.stringify(
        facts.installments.map((i) => ({
          index: toPersianDigits(String(i.index)),
          dueOn: jalaliDay(i.dueOn),
          amount: tomans(i.amountRial),
        })),
      ),
    };
  }

  private async link(actor: Actor, row: ContractRow) {
    if (row.storageKey === null)
      throw new ConflictException({ error: 'not_ready', status: row.status });
    if (!this.storage.configured) throw storageUnavailable();
    const url = await this.storage.signedUrl(row.storageKey, LINK_SECONDS);
    // Every view of a contract is logged (doc 04 §7).
    await this.audit.recordView(actor, 'contract', row.id);
    return { url, expiresInSeconds: LINK_SECONDS };
  }

  /** With `persons` (a party's own view), each party says whether it is the viewer. */
  private async view(row: ContractRow, persons?: readonly string[]): Promise<ContractView> {
    const accepted = await this.db
      .select()
      .from(contractAcceptances)
      .where(eq(contractAcceptances.contractId, row.id));
    return {
      id: row.id,
      creditApplicationId: row.creditApplicationId,
      number: row.number,
      entityId: row.entityId,
      status: row.status,
      templateVersionId: row.templateVersionId,
      sample: row.sample,
      sha256: row.sha256,
      sizeBytes: row.sizeBytes,
      generatedAt: row.generatedAt?.toISOString() ?? null,
      acceptedAt: row.acceptedAt?.toISOString() ?? null,
      createdAt: row.createdAt.toISOString(),
      parties: row.parties.map((p) => ({
        role: p.role,
        guarantorId: p.guarantorId,
        acceptedAt:
          accepted
            .find((a) => a.personId === p.personId && a.role === p.role)
            ?.createdAt.toISOString() ?? null,
        ...(persons ? { mine: persons.includes(p.personId) } : {}),
      })),
    };
  }

  /** The application, if the caller's scope reaches it: global, or its proforma's city. */
  private async reachable(access: EffectiveAccess, creditApplicationId: string) {
    const facts = await this.credit.facts(creditApplicationId);
    if (!facts) throw new NotFoundException({ error: 'credit_application_not_found' });
    if (access.scopes.some((s) => s.kind === 'global')) return facts;
    const cities = access.scopes.flatMap((s) => (s.kind === 'city' ? [s.code] : []));
    const proforma = await this.proformas.proforma(facts.proformaId);
    if (!proforma || !cities.includes(proforma.cityCode)) {
      throw new NotFoundException({ error: 'credit_application_not_found' });
    }
    return facts;
  }

  private async staffRow(access: EffectiveAccess, id: string): Promise<ContractRow> {
    if (!UUID.test(id)) throw notFound();
    const [row] = await this.db.select().from(contracts).where(eq(contracts.id, id));
    if (!row) throw notFound();
    await this.reachable(access, row.creditApplicationId).catch(() => {
      throw notFound();
    });
    return row;
  }

  /** A contract of which this account's person is a party (rule 13). */
  private async ownRow(accountId: string, id: string) {
    if (!UUID.test(id)) throw notFound();
    const persons = await this.personsOf(accountId);
    const [row] = await this.db
      .select()
      .from(contracts)
      .where(and(eq(contracts.id, id)));
    const parties = row?.parties.filter((p) => persons.includes(p.personId)) ?? [];
    if (!row || parties.length === 0 || row.status === 'failed') throw notFound();
    return { row, parties, persons };
  }

  /** Who accepts: a party in that role, logged in as themselves, with their mobile. */
  private async acceptor(accountId: string, id: string, role: Role) {
    const account = await this.accounts.find(accountId);
    if (!account || account.kind !== 'patient' || !account.mobile) {
      throw new ForbiddenException({ error: 'patients_only' });
    }
    const { row, parties } = await this.ownRow(accountId, id);
    const party = parties.find((p) => p.role === role);
    if (!party) throw notFound();
    return { row, party, mobile: account.mobile };
  }

  /** The persons a patient-kind account speaks for: theirs and everyone merged in. */
  private async personsOf(accountId: string): Promise<string[]> {
    const account = await this.accounts.find(accountId);
    if (!account || account.kind !== 'patient')
      throw new ForbiddenException({ error: 'patients_only' });
    if (!account.personId) return [];
    return this.leads.samePersonIds(await this.leads.canonicalPersonId(account.personId));
  }

  private async publish(tx: Tx, type: string, row: ContractRow) {
    await this.outbox.publish(
      {
        type,
        aggregateType: 'contract',
        aggregateId: row.id,
        payload: { contractId: row.id, creditApplicationId: row.creditApplicationId },
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

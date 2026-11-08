import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  GoneException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { ProformaLineInput, ProformaStatus, ProformaView } from '@sepehr/contracts';
import { and, asc, count, desc, eq, inArray, isNull, lte, sql } from 'drizzle-orm';
import type { EffectiveAccess } from '../../common/auth/access.port';
import { ACCOUNT_DIRECTORY, type AccountDirectory } from '../../common/auth/account-directory.port';
import { AUDIT_LOG, type Actor, type AuditLog } from '../../common/audit/audit.port';
import {
  REFERRAL_DIRECTORY,
  type ReferralDirectory,
} from '../../common/booking/referral-directory.port';
import { TARIFF_BOOK, type TariffBook } from '../../common/catalog/tariff-book.port';
import {
  WORKPLACE_DIRECTORY,
  type WorkplaceDirectory,
  type WorkplaceRecord,
} from '../../common/catalog/workplace-directory.port';
import { CONFIG, type ConfigPort } from '../../common/config/config.port';
import { OUTBOX, type OutboxPort } from '../../common/events/outbox.port';
import { LEAD_CASES, type LeadCases } from '../../common/lead/lead-cases.port';
import { DATABASE, type Database } from '../../db/database.module';
import {
  proformaDeviationReviews,
  proformaLines,
  proformas,
  supportRequests,
} from './proforma.schema';

type Tx = Parameters<Parameters<Database['transaction']>[0]>[0];
type ProformaRow = typeof proformas.$inferSelect;
type LineRow = typeof proformaLines.$inferSelect;
type NewLine = Omit<typeof proformaLines.$inferInsert, 'proformaId'>;

const DAY_MS = 86_400_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SWEEP_BATCH = 200;
const SWEEPER_ACTOR: Actor = { accountId: null, sessionId: null, ip: null, roles: ['proforma'] };

const within = (path: string, by: string) => path === by || path.startsWith(`${by}.`);
const notFound = () => new NotFoundException({ error: 'proforma_not_found' });
const deviates = (l: Pick<LineRow, 'unitRial' | 'tariffMinRial' | 'tariffMaxRial'>) =>
  l.unitRial < l.tariffMinRial || l.unitRial > l.tariffMaxRial;

/** Statuses a new version may correct (task 3-4: a confirmed one is not revised here). */
const REVISABLE: readonly ProformaStatus[] = ['issued', 'disputed', 'expired'];

/**
 * Proformas (task 3-4, doc 10 §2). Only for a patient referred to the same doctor
 * through an appointment made through Sepehr (owner, 1405/07/10); an advisor's manual
 * registration instead is TODO(decision), moved to task 4-8. Issued by the doctor, or
 * their secretary by the doctor's own delegation; read by scope; answered by the patient.
 * Nothing in an issued proforma changes (the database refuses it): a correction is a new
 * version. Staff reach a proforma through its workplace and, out of scope, it does not
 * exist (rule 13). Every change is audited; no ledger entry is made (doc 10 §1).
 */
@Injectable()
export class ProformaService {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(AUDIT_LOG) private readonly audit: AuditLog,
    @Inject(OUTBOX) private readonly outbox: OutboxPort,
    @Inject(CONFIG) private readonly config: ConfigPort,
    @Inject(WORKPLACE_DIRECTORY) private readonly directory: WorkplaceDirectory,
    @Inject(TARIFF_BOOK) private readonly tariffs: TariffBook,
    @Inject(REFERRAL_DIRECTORY) private readonly referrals: ReferralDirectory,
    @Inject(ACCOUNT_DIRECTORY) private readonly accounts: AccountDirectory,
    @Inject(LEAD_CASES) private readonly leads: LeadCases,
  ) {}

  // --- the doctor's side --------------------------------------------------------------

  /** A draft for the patient of an appointment made through Sepehr. */
  async create(
    actor: Actor,
    access: EffectiveAccess,
    input: { appointmentId: string; lines: readonly LineInput[] },
    now = new Date(),
  ): Promise<ProformaView> {
    this.require(access, 'proforma.issue');
    const referral = await this.referrals.forAppointment(input.appointmentId);
    if (!referral) throw new NotFoundException({ error: 'referral_not_found' });
    const workplace = await this.visible(access, referral.workplaceId).catch(() => {
      throw new NotFoundException({ error: 'referral_not_found' });
    });
    if (workplace.doctorId !== referral.doctorId) {
      throw new ConflictException({ error: 'referral_of_another_doctor' });
    }
    if (referral.caseId === null) throw new ConflictException({ error: 'referral_without_case' });
    const caseId = referral.caseId;
    const issuer = await this.issuer(actor, workplace);
    this.assertCenterActive(workplace);
    const lines = await this.priceLines(workplace, input.lines, now);

    const row = await this.db.transaction(async (tx) => {
      const made = await this.insertDraft(tx, issuer, {
        caseId,
        personId: referral.personId,
        referralId: referral.referralId,
        workplace,
        version: 1,
        supersedesId: null,
        lines,
        now,
      });
      await this.audit.record(
        {
          actor: issuer,
          action: 'proforma.created',
          entityType: 'proforma',
          entityId: made.id,
          after: {
            version: 1,
            totalRial: made.totalRial.toString(),
            appointmentId: input.appointmentId,
          },
        },
        tx,
      );
      return made;
    });
    return this.view(row, access.permissions.has('access.view_treatment'));
  }

  /** A new version of an issued, disputed or expired proforma, as a draft. */
  async revise(
    actor: Actor,
    access: EffectiveAccess,
    proformaId: string,
    input: { lines: readonly LineInput[] },
    now = new Date(),
  ): Promise<ProformaView> {
    this.require(access, 'proforma.issue');
    const prior = await this.staffRow(access, proformaId);
    const workplace = await this.visible(access, prior.workplaceId);
    const issuer = await this.issuer(actor, workplace);
    if (!REVISABLE.includes(prior.status)) {
      throw new ConflictException({ error: 'not_revisable', status: prior.status });
    }
    this.assertCenterActive(workplace);
    const lines = await this.priceLines(workplace, input.lines, now);

    const row = await this.db.transaction(async (tx) => {
      const [locked] = await tx
        .select()
        .from(proformas)
        .where(eq(proformas.id, prior.id))
        .for('update');
      if (!locked || !REVISABLE.includes(locked.status) || locked.deletedAt !== null) {
        throw new ConflictException({ error: 'not_revisable' });
      }
      const [successor] = await tx
        .select({ id: proformas.id })
        .from(proformas)
        .where(and(eq(proformas.supersedesId, locked.id), isNull(proformas.deletedAt)));
      if (successor)
        throw new ConflictException({ error: 'revision_exists', proformaId: successor.id });
      const made = await this.insertDraft(tx, issuer, {
        caseId: locked.caseId,
        personId: locked.personId,
        referralId: locked.referralId,
        workplace,
        version: locked.version + 1,
        supersedesId: locked.id,
        lines,
        now,
      });
      await this.audit.record(
        {
          actor: issuer,
          action: 'proforma.revised',
          entityType: 'proforma',
          entityId: made.id,
          before: { proformaId: locked.id, version: locked.version, status: locked.status },
          after: { version: made.version, totalRial: made.totalRial.toString() },
        },
        tx,
      );
      return made;
    });
    return this.view(row, access.permissions.has('access.view_treatment'));
  }

  /**
   * Issues a draft at the tariffs in force now: every line's tariff version must still be
   * the one in force, else the doctor makes a new draft (doc 10 §2 rule 2, test 4). Only once
   * its appointment is examined (owner 1405/07/23, question 8): no amount is touched. The
   * version it corrects, if still open, is superseded in the same transaction.
   */
  async issue(
    actor: Actor,
    access: EffectiveAccess,
    proformaId: string,
    now = new Date(),
  ): Promise<ProformaView> {
    this.require(access, 'proforma.issue');
    const draft = await this.staffRow(access, proformaId);
    const workplace = await this.visible(access, draft.workplaceId);
    const issuer = await this.issuer(actor, workplace);
    this.assertCenterActive(workplace);
    const validity = await this.config.resolve('proforma.validity_days', {}, now);

    const row = await this.db.transaction(async (tx) => {
      const [locked] = await tx
        .select()
        .from(proformas)
        .where(eq(proformas.id, draft.id))
        .for('update');
      if (!locked || locked.status !== 'draft' || locked.deletedAt !== null) {
        throw new ConflictException({ error: 'not_a_draft' });
      }
      // Owner 1405/07/23: issued only once the appointment it was drafted for is examined.
      const referral = await this.referrals.referral(locked.referralId, tx);
      if (referral?.appointmentStatus !== 'examined') {
        throw new ConflictException({
          error: 'appointment_not_examined',
          appointmentStatus: referral?.appointmentStatus ?? null,
        });
      }
      const lines = await this.linesOf(tx, [locked.id]);
      for (const line of lines) {
        const current = await this.tariffs.quote(locked.workplaceId, line.serviceCode, now, tx);
        if (current?.tariffVersionId !== line.tariffVersionId) {
          throw new ConflictException({ error: 'tariff_changed', serviceCode: line.serviceCode });
        }
      }
      const [issued] = await tx
        .update(proformas)
        .set({
          status: 'issued',
          issuedAt: now,
          issuedBy: actor.accountId,
          expiresAt: new Date(now.getTime() + validity.value * DAY_MS),
          validityConfigVersionId: validity.versionId,
        })
        .where(eq(proformas.id, locked.id))
        .returning();
      if (!issued) throw new Error('proforma issue returned nothing');
      await this.audit.record(
        {
          actor: issuer,
          action: 'proforma.issued',
          entityType: 'proforma',
          entityId: issued.id,
          before: { status: 'draft' },
          after: {
            status: 'issued',
            expiresAt: issued.expiresAt?.toISOString(),
            // ADR-050: issuing confirms the wage and materials split.
            materialLines: lines.filter((l) => l.costKind === 'material').length,
            materialRial: lines
              .filter((l) => l.costKind === 'material')
              .reduce((sum, l) => sum + l.lineTotalRial, 0n)
              .toString(),
          },
        },
        tx,
      );
      await this.publish(tx, 'proforma.issued', issued);

      if (locked.supersedesId !== null) {
        const [prior] = await tx
          .select()
          .from(proformas)
          .where(eq(proformas.id, locked.supersedesId))
          .for('update');
        if (prior && (prior.status === 'issued' || prior.status === 'disputed')) {
          await this.move(tx, issuer, prior, 'superseded', 'proforma.superseded', {
            supersededBy: issued.id,
          });
        }
      }
      return issued;
    });
    return this.view(row, access.permissions.has('access.view_treatment'));
  }

  /** Leaves a draft unissued, with a reason; it stays on record (rule 7). */
  async discard(
    actor: Actor,
    access: EffectiveAccess,
    proformaId: string,
    reason: string,
    now = new Date(),
  ): Promise<void> {
    this.require(access, 'proforma.issue');
    const draft = await this.staffRow(access, proformaId);
    const workplace = await this.visible(access, draft.workplaceId);
    const issuer = await this.issuer(actor, workplace);
    await this.db.transaction(async (tx) => {
      const [locked] = await tx
        .select()
        .from(proformas)
        .where(eq(proformas.id, draft.id))
        .for('update');
      if (!locked || locked.status !== 'draft' || locked.deletedAt !== null) {
        throw new ConflictException({ error: 'not_a_draft' });
      }
      await tx
        .update(proformas)
        .set({ deletedAt: now, discardReason: reason })
        .where(eq(proformas.id, locked.id));
      await this.audit.record(
        {
          actor: issuer,
          action: 'proforma.discarded',
          entityType: 'proforma',
          entityId: locked.id,
          before: { status: 'draft' },
          after: { discarded: true },
          reason,
        },
        tx,
      );
    });
  }

  // --- reading by scope ---------------------------------------------------------------

  async get(access: EffectiveAccess, proformaId: string): Promise<ProformaView> {
    this.require(access, 'proforma.read');
    const row = await this.staffRow(access, proformaId);
    return this.view(row, access.permissions.has('access.view_treatment'));
  }

  /** A workplace's proformas, newest first, drafts included; discarded ones are not. */
  async listForWorkplace(
    access: EffectiveAccess,
    workplaceId: string,
    query: {
      status?: ProformaStatus | undefined;
      page?: number | undefined;
      pageSize?: number | undefined;
    },
  ) {
    this.require(access, 'proforma.read');
    await this.visible(access, workplaceId);
    const where = and(
      eq(proformas.workplaceId, workplaceId),
      isNull(proformas.deletedAt),
      query.status === undefined ? undefined : eq(proformas.status, query.status),
    );
    return this.page(where, query, access.permissions.has('access.view_treatment'));
  }

  // --- the network's queue of prices outside the tariff (doc 10 §2 rule 2) -------------

  async deviationQueue(
    access: EffectiveAccess,
    query: {
      reviewed?: 'no' | 'all' | undefined;
      page?: number | undefined;
      pageSize?: number | undefined;
    },
  ) {
    this.require(access, 'proforma.review_deviations');
    const cities = this.networkCities(access);
    const deviating = sql`EXISTS (SELECT 1 FROM proforma_lines l WHERE l.proforma_id = ${proformas.id}
      AND (l.unit_rial < l.tariff_min_rial OR l.unit_rial > l.tariff_max_rial))`;
    const unreviewed = sql`NOT EXISTS (SELECT 1 FROM proforma_deviation_reviews r WHERE r.proforma_id = ${proformas.id})`;
    const where = and(
      isNull(proformas.deletedAt),
      inArray(proformas.status, ['issued', 'patient_confirmed', 'disputed']),
      cities === 'all' ? undefined : inArray(proformas.cityCode, cities.length > 0 ? cities : ['']),
      deviating,
      query.reviewed === 'all' ? undefined : unreviewed,
    );
    return this.page(where, query, false);
  }

  async reviewDeviation(
    actor: Actor,
    access: EffectiveAccess,
    proformaId: string,
    note: string,
  ): Promise<void> {
    this.require(access, 'proforma.review_deviations');
    if (!UUID.test(proformaId)) throw notFound();
    const cities = this.networkCities(access);
    await this.db.transaction(async (tx) => {
      const [row] = await tx.select().from(proformas).where(eq(proformas.id, proformaId));
      if (!row || row.deletedAt !== null || (cities !== 'all' && !cities.includes(row.cityCode))) {
        throw notFound();
      }
      const lines = await this.linesOf(tx, [row.id]);
      if (row.status === 'draft' || !lines.some(deviates)) {
        throw new ConflictException({ error: 'no_deviation_to_review' });
      }
      await tx.insert(proformaDeviationReviews).values({
        proformaId: row.id,
        reviewedBy: actor.accountId ?? '',
        note,
      });
      await this.audit.record(
        {
          actor,
          action: 'proforma.deviation_reviewed',
          entityType: 'proforma',
          entityId: row.id,
          after: { reviewed: true },
          reason: note,
        },
        tx,
      );
    });
  }

  // --- the patient's side (self-service: their own proformas only) ---------------------

  async listMine(accountId: string) {
    const persons = await this.patientPersonIds(accountId);
    if (persons.length === 0) return [];
    const rows = await this.db
      .select()
      .from(proformas)
      .where(
        and(
          inArray(proformas.personId, persons),
          isNull(proformas.deletedAt),
          sql`${proformas.status} <> 'draft'`,
        ),
      )
      .orderBy(desc(proformas.createdAt));
    return this.views(rows, true);
  }

  async getMine(accountId: string, proformaId: string): Promise<ProformaView> {
    return this.view(await this.ownRow(accountId, proformaId), true);
  }

  /** The patient accepts it (doc 10 §2); not a sensitive act, so no separate code. */
  async confirm(actor: Actor, accountId: string, proformaId: string, now = new Date()) {
    return this.answer(actor, accountId, proformaId, 'patient_confirmed', null, now);
  }

  /** The patient disputes it: a support request linked to it, for the doctor to correct. */
  async dispute(
    actor: Actor,
    accountId: string,
    proformaId: string,
    note: string,
    now = new Date(),
  ) {
    return this.answer(actor, accountId, proformaId, 'disputed', note, now);
  }

  // --- time (the worker's scheduler) ---------------------------------------------------

  /** Issued or disputed proformas past their deadline become expired (doc 10 §2 rule 5). */
  async expireOverdue(now = new Date()): Promise<number> {
    let expired = 0;
    for (;;) {
      const done = await this.db.transaction(async (tx) => {
        const rows = await tx
          .select()
          .from(proformas)
          .where(
            and(
              inArray(proformas.status, ['issued', 'disputed']),
              lte(proformas.expiresAt, now),
              isNull(proformas.deletedAt),
            ),
          )
          .orderBy(asc(proformas.expiresAt))
          .limit(SWEEP_BATCH)
          .for('update', { skipLocked: true });
        for (const row of rows) {
          await this.move(tx, SWEEPER_ACTOR, row, 'expired', 'proforma.expired', {
            deadline: 'passed',
          });
        }
        return rows.length;
      });
      expired += done;
      if (done < SWEEP_BATCH) return expired;
    }
  }

  // --- helpers ------------------------------------------------------------------------

  private async answer(
    actor: Actor,
    accountId: string,
    proformaId: string,
    to: 'patient_confirmed' | 'disputed',
    note: string | null,
    now: Date,
  ): Promise<ProformaView> {
    const own = await this.ownRow(accountId, proformaId);
    const outcome = await this.db.transaction(async (tx) => {
      const [locked] = await tx
        .select()
        .from(proformas)
        .where(eq(proformas.id, own.id))
        .for('update');
      if (!locked) throw notFound();
      if (locked.status === 'issued' && locked.expiresAt !== null && locked.expiresAt <= now) {
        await this.move(tx, SWEEPER_ACTOR, locked, 'expired', 'proforma.expired', {
          deadline: 'passed',
        });
        return null;
      }
      if (locked.status !== 'issued') {
        throw new ConflictException({ error: 'not_open_for_answer', status: locked.status });
      }
      const [answered] = await tx
        .update(proformas)
        .set({ status: to, patientRespondedAt: now, patientResponseNote: note })
        .where(eq(proformas.id, locked.id))
        .returning();
      if (!answered) throw new Error('proforma answer returned nothing');
      if (to === 'disputed' && note !== null) {
        await tx.insert(supportRequests).values({
          subjectType: 'proforma',
          subjectId: locked.id,
          personId: locked.personId,
          accountId,
          note,
        });
      }
      await this.audit.record(
        {
          actor,
          action: to === 'disputed' ? 'proforma.disputed' : 'proforma.confirmed',
          entityType: 'proforma',
          entityId: locked.id,
          before: { status: 'issued' },
          after: { status: to },
          reason: note,
        },
        tx,
      );
      // The case is not moved here: the lead module's funnel consumer moves it to
      // proforma_issued on proforma.issued (owner 1405/07/23, question 8).
      await this.publish(
        tx,
        to === 'disputed' ? 'proforma.disputed' : 'proforma.confirmed',
        answered,
      );
      return answered;
    });
    if (outcome === null) throw new GoneException({ error: 'proforma_expired' });
    return this.view(outcome, true);
  }

  /** Moves a proforma's state with its audit row and event. */
  private async move(
    tx: Tx,
    actor: Actor,
    row: ProformaRow,
    to: 'superseded' | 'expired',
    event: 'proforma.superseded' | 'proforma.expired',
    detail: Record<string, unknown>,
  ) {
    const [moved] = await tx
      .update(proformas)
      .set({ status: to })
      .where(eq(proformas.id, row.id))
      .returning();
    if (!moved) throw new Error('proforma move returned nothing');
    await this.audit.record(
      {
        actor,
        action: event,
        entityType: 'proforma',
        entityId: row.id,
        before: { status: row.status },
        after: { status: to, ...detail },
      },
      tx,
    );
    await this.publish(tx, event, moved);
  }

  private async publish(tx: Tx, type: string, row: ProformaRow) {
    await this.outbox.publish(
      {
        type,
        aggregateType: 'proforma',
        aggregateId: row.id,
        payload: {
          proformaId: row.id,
          caseId: row.caseId,
          doctorId: row.doctorId,
          workplaceId: row.workplaceId,
          version: row.version,
          totalRial: row.totalRial.toString(),
        },
      },
      tx,
    );
  }

  /** Prices each line from the tariff in force at the workplace now (snapshot). */
  private async priceLines(
    workplace: WorkplaceRecord,
    input: readonly LineInput[],
    now: Date,
  ): Promise<NewLine[]> {
    const offerable = new Set(await this.directory.offerableServiceCodes(workplace.id));
    const lines: NewLine[] = [];
    for (const [i, line] of input.entries()) {
      if (!offerable.has(line.serviceCode)) {
        throw new BadRequestException({
          error: 'service_not_offered',
          serviceCode: line.serviceCode,
        });
      }
      const tariff = await this.tariffs.quote(workplace.id, line.serviceCode, now);
      if (!tariff)
        throw new ConflictException({ error: 'service_not_priced', serviceCode: line.serviceCode });
      const min = tariff.isFree ? 0n : tariff.minAmountRial;
      const max = tariff.isFree ? 0n : tariff.maxAmountRial;
      let unit = line.unitRial;
      if (unit === undefined) {
        if (min !== max) {
          throw new BadRequestException({
            error: 'unit_price_required',
            serviceCode: line.serviceCode,
          });
        }
        unit = min;
      }
      const out = unit < min || unit > max;
      if (out && line.deviationReason === undefined) {
        throw new BadRequestException({
          error: 'deviation_reason_required',
          serviceCode: line.serviceCode,
        });
      }
      // ADR-050: the service's cost kind, or the issuer's own split with its reason.
      const costKind = line.costKind ?? tariff.costKind;
      if (costKind !== tariff.costKind && line.costKindReason === undefined) {
        throw new BadRequestException({
          error: 'cost_kind_reason_required',
          serviceCode: line.serviceCode,
        });
      }
      lines.push({
        lineNo: i + 1,
        serviceId: tariff.serviceId,
        serviceCode: line.serviceCode,
        tariffVersionId: tariff.tariffVersionId,
        tariffMinRial: min,
        tariffMaxRial: max,
        quantity: line.quantity,
        unitRial: unit,
        deviationReason: out ? (line.deviationReason ?? null) : null,
        lineTotalRial: unit * BigInt(line.quantity),
        toothOrSite: line.toothOrSite ?? null,
        note: line.note ?? null,
        costKind,
        costKindReason: costKind !== tariff.costKind ? (line.costKindReason ?? null) : null,
      });
    }
    return lines;
  }

  private async insertDraft(
    tx: Tx,
    issuer: Actor,
    d: {
      caseId: string;
      personId: string;
      referralId: string;
      workplace: WorkplaceRecord;
      version: number;
      supersedesId: string | null;
      lines: NewLine[];
      now: Date;
    },
  ): Promise<ProformaRow> {
    const total = d.lines.reduce((sum, l) => sum + l.lineTotalRial, 0n);
    const [row] = await tx
      .insert(proformas)
      .values({
        caseId: d.caseId,
        personId: d.personId,
        referralId: d.referralId,
        doctorId: d.workplace.doctorId,
        workplaceId: d.workplace.id,
        centerId: d.workplace.centerId,
        cityCode: d.workplace.cityCode,
        version: d.version,
        supersedesId: d.supersedesId,
        totalRial: total,
        tariffSnapshotAt: d.now,
        createdBy: issuer.accountId,
      })
      .returning();
    if (!row) throw new Error('proforma insert returned nothing');
    await tx.insert(proformaLines).values(d.lines.map((l) => ({ ...l, proformaId: row.id })));
    return row;
  }

  /**
   * Who may issue at this workplace (doc 11 3-4): the doctor, with an account; or that
   * workplace's own secretary, only when the doctor has an account and so delegated it
   * themselves (as for tariffs, ADR-024). The audit says «on behalf of» the doctor then.
   */
  private async issuer(actor: Actor, workplace: WorkplaceRecord): Promise<Actor> {
    if (actor.accountId === null)
      throw new ForbiddenException({ error: 'doctor_or_secretary_only' });
    if (workplace.doctorAccountId !== null && workplace.doctorAccountId === actor.accountId)
      return actor;
    if (!(await this.directory.isSecretary(workplace.id, actor.accountId))) {
      throw new ForbiddenException({ error: 'doctor_or_secretary_only' });
    }
    if (workplace.doctorAccountId === null) {
      throw new ForbiddenException({ error: 'doctor_delegation_required' });
    }
    return { ...actor, onBehalfOfDoctorId: workplace.doctorId };
  }

  private assertCenterActive(workplace: WorkplaceRecord) {
    if (workplace.centerStatus !== null && workplace.centerStatus !== 'active') {
      throw new ConflictException({ error: 'center_not_active', status: workplace.centerStatus });
    }
  }

  private require(
    access: EffectiveAccess,
    permission: 'proforma.issue' | 'proforma.read' | 'proforma.review_deviations',
  ) {
    if (!access.permissions.has(permission)) {
      throw new ForbiddenException({ error: 'permission_required', permission });
    }
  }

  /** The workplace if the caller's scope covers it; otherwise it does not exist. */
  private async visible(access: EffectiveAccess, workplaceId: string): Promise<WorkplaceRecord> {
    const workplace = UUID.test(workplaceId) ? await this.directory.workplace(workplaceId) : null;
    const covers =
      workplace !== null &&
      access.scopes.some((scope) => {
        if (scope.kind === 'global') return true;
        if (scope.kind === 'city') return scope.code === workplace.cityCode;
        if (scope.kind === 'center' || scope.kind === 'branch' || scope.kind === 'doctor') {
          return within(workplace.nodePath, scope.path);
        }
        return false;
      });
    if (!workplace || !covers) throw new NotFoundException({ error: 'workplace_not_found' });
    return workplace;
  }

  /** A proforma (not discarded) whose workplace the caller's scope covers. */
  private async staffRow(access: EffectiveAccess, proformaId: string): Promise<ProformaRow> {
    if (!UUID.test(proformaId)) throw notFound();
    const [row] = await this.db.select().from(proformas).where(eq(proformas.id, proformaId));
    if (!row || row.deletedAt !== null) throw notFound();
    await this.visible(access, row.workplaceId).catch(() => {
      throw notFound();
    });
    return row;
  }

  private async ownRow(accountId: string, proformaId: string): Promise<ProformaRow> {
    if (!UUID.test(proformaId)) throw notFound();
    const persons = await this.patientPersonIds(accountId);
    const [row] = await this.db.select().from(proformas).where(eq(proformas.id, proformaId));
    if (
      !row ||
      row.deletedAt !== null ||
      row.status === 'draft' ||
      !persons.includes(row.personId)
    ) {
      throw notFound();
    }
    return row;
  }

  /** The persons whose proformas this patient sees: theirs and everyone merged in. */
  private async patientPersonIds(accountId: string): Promise<string[]> {
    const account = await this.accounts.find(accountId);
    if (!account || account.kind !== 'patient' || !account.personId) {
      throw new ForbiddenException({ error: 'patients_only' });
    }
    return this.leads.samePersonIds(await this.leads.canonicalPersonId(account.personId));
  }

  /** global: every city; else the cities of the caller's city scopes. */
  private networkCities(access: EffectiveAccess): 'all' | string[] {
    if (access.scopes.some((s) => s.kind === 'global')) return 'all';
    return access.scopes.flatMap((s) => (s.kind === 'city' ? [s.code] : []));
  }

  private async page(
    where: ReturnType<typeof and>,
    query: { page?: number | undefined; pageSize?: number | undefined },
    treatment: boolean,
  ) {
    const page = query.page ?? 1;
    const pageSize = query.pageSize ?? 20;
    const [rows, totals] = await Promise.all([
      this.db
        .select()
        .from(proformas)
        .where(where)
        .orderBy(desc(proformas.createdAt), desc(proformas.id))
        .limit(pageSize)
        .offset((page - 1) * pageSize),
      this.db.select({ n: count() }).from(proformas).where(where),
    ]);
    return { page, pageSize, total: totals[0]?.n ?? 0, items: await this.views(rows, treatment) };
  }

  private linesOf(ex: Tx | Database, ids: readonly string[]) {
    return ex
      .select()
      .from(proformaLines)
      .where(inArray(proformaLines.proformaId, [...ids]))
      .orderBy(asc(proformaLines.proformaId), asc(proformaLines.lineNo));
  }

  private async view(row: ProformaRow, treatment: boolean): Promise<ProformaView> {
    const [only] = await this.views([row], treatment);
    if (!only) throw new Error('proforma view missing');
    return only;
  }

  /** Treatment details only for whoever may see treatment (doc 04 §4) and the patient. */
  private async views(rows: readonly ProformaRow[], treatment: boolean): Promise<ProformaView[]> {
    if (rows.length === 0) return [];
    const lines = await this.linesOf(
      this.db,
      rows.map((r) => r.id),
    );
    const names = await this.directory.serviceNames([...new Set(lines.map((l) => l.serviceCode))]);
    const places = new Map<string, WorkplaceRecord | null>();
    for (const id of new Set(rows.map((r) => r.workplaceId))) {
      places.set(id, await this.directory.workplace(id));
    }
    return rows.map((row) => {
      const place = places.get(row.workplaceId) ?? null;
      return {
        id: row.id,
        caseId: row.caseId,
        workplaceId: row.workplaceId,
        doctorId: row.doctorId,
        doctorName: place?.doctorName ?? '',
        placeName: place?.placeName ?? null,
        version: row.version,
        supersedesId: row.supersedesId,
        status: row.status,
        totalRial: row.totalRial.toString(),
        validUntil: row.expiresAt?.toISOString() ?? null,
        issuedAt: row.issuedAt?.toISOString() ?? null,
        patientRespondedAt: row.patientRespondedAt?.toISOString() ?? null,
        patientResponseNote: row.patientResponseNote,
        createdAt: row.createdAt.toISOString(),
        lines: lines
          .filter((l) => l.proformaId === row.id)
          .map((l) => ({
            lineNo: l.lineNo,
            serviceCode: l.serviceCode,
            serviceName: names.get(l.serviceCode) ?? l.serviceCode,
            quantity: l.quantity,
            tariffVersionId: l.tariffVersionId,
            tariffMinRial: l.tariffMinRial.toString(),
            tariffMaxRial: l.tariffMaxRial.toString(),
            unitRial: l.unitRial.toString(),
            lineTotalRial: l.lineTotalRial.toString(),
            deviates: deviates(l),
            deviationReason: l.deviationReason,
            costKind: l.costKind,
            costKindReason: l.costKindReason,
            ...(treatment ? { toothOrSite: l.toothOrSite, note: l.note } : {}),
          })),
      };
    });
  }
}

type LineInput = Omit<ProformaLineInput, 'unitRial' | 'quantity'> & {
  readonly quantity: number;
  readonly unitRial?: bigint | undefined;
};

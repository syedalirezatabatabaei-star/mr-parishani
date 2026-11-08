import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  classify,
  evaluate,
  normalizeMobile,
  PERSON_DIRECTORY,
  toJalali,
  type ConsentRole,
  type PersonDirectory,
  type RawBorrowerData,
  type RawGuarantorData,
  type ScoringAnswerSet,
  type ScoringRuleset,
} from '@sepehr/contracts';
import { and, asc, eq, inArray, isNull, ne, sql } from 'drizzle-orm';
import type { EffectiveAccess } from '../../common/auth/access.port';
import { ACCOUNT_DIRECTORY, type AccountDirectory } from '../../common/auth/account-directory.port';
import {
  OTP_CHALLENGE,
  type OtpChallenge,
  type OtpChallengeMeta,
} from '../../common/auth/otp-challenge.port';
import { AUDIT_LOG, type Actor, type AuditLog } from '../../common/audit/audit.port';
import { CONFIG, type ConfigPort } from '../../common/config/config.port';
import { OUTBOX, type OutboxPort } from '../../common/events/outbox.port';
import { DATABASE, type Database } from '../../db/database.module';
import { CreditApplicationService } from './credit-application.service';
import {
  creditApplications,
  creditApplicationStatusChanges,
  creditConsents,
  creditGuarantors,
  scoreSheets,
} from './credit.schema';

type Tx = Parameters<Parameters<Database['transaction']>[0]>[0];
type ApplicationRow = typeof creditApplications.$inferSelect;
type GuarantorRow = typeof creditGuarantors.$inferSelect;
type SheetRow = typeof scoreSheets.$inferSelect;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CONSENT_PURPOSE = 'credit_consent';
/** States in which consent, guarantors and sheets are worked on. */
const OPEN = ['incomplete', 'ready_for_review', 'scoring', 'manual_review'] as const;
/**
 * Owner 1405/07/27 (plan e): up to three guarantors; the engine scores two (doc 03 §7, rule 3
 * of the workbook): the first two still active, in the order they were invited. A third is
 * recorded (consent, collection) with no effect on the score, and has no score sheet.
 */
const MAX_GUARANTORS = 3;
const SCORED_GUARANTORS = 2;

/** bigint as text, so raw data stores as JSON exactly as entered. */
const asJson = (value: unknown): unknown =>
  JSON.parse(JSON.stringify(value, (_k, v: unknown) => (typeof v === 'bigint' ? v.toString() : v)));

/**
 * Consent, score sheets and guarantors (task 3-5 part B; doc 10 §4–§5; doc 03 §1).
 *
 * - Consent to the credit check is given by the person themselves, logged in with their
 *   own mobile, with a one-time code, to the text version in force (doc 03 §8-6). No sheet
 *   is made for anyone without it (doc 10 §10 test 13).
 * - A sheet holds the raw data entered (the strict schemas of task 3-2: no medical field)
 *   and what the engine made of it under the application's rules version, locked by its
 *   first sheet. A new sheet for the same person supersedes the last.
 * - A guarantor is invited only once the borrower has a grade (doc 03 §1; doc 10 §10
 *   test 2) and sees only their own commitment (test 10).
 */
@Injectable()
export class CreditScoringService {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(AUDIT_LOG) private readonly audit: AuditLog,
    @Inject(OUTBOX) private readonly outbox: OutboxPort,
    @Inject(CONFIG) private readonly config: ConfigPort,
    @Inject(OTP_CHALLENGE) private readonly otp: OtpChallenge,
    @Inject(ACCOUNT_DIRECTORY) private readonly accounts: AccountDirectory,
    @Inject(PERSON_DIRECTORY) private readonly persons: PersonDirectory,
    private readonly applications: CreditApplicationService,
  ) {}

  // --- consent (doc 03 §8-6) ----------------------------------------------------------

  /** The consent text in force and its version (doc 03 §8-6). */
  async consentText() {
    const text = await this.config.resolve('credit.consent_text');
    return { text: text.value.text, versionId: text.versionId };
  }

  async requestConsent(accountId: string, id: string, role: ConsentRole, meta: OtpChallengeMeta) {
    const { mobile } = await this.consenter(accountId, id, role);
    return this.otp.send(mobile, CONSENT_PURPOSE, meta);
  }

  async giveConsent(
    actor: Actor,
    accountId: string,
    id: string,
    role: ConsentRole,
    code: string,
    meta: OtpChallengeMeta,
    now = new Date(),
  ) {
    const { mobile, app, personId, guarantor } = await this.consenter(accountId, id, role);
    await this.otp.verify(mobile, CONSENT_PURPOSE, code, meta, now);
    const text = await this.config.resolve('credit.consent_text', {}, now);
    await this.db.transaction(async (tx) => {
      const inserted = await tx
        .insert(creditConsents)
        .values({
          creditApplicationId: app.id,
          personId,
          role,
          consentTextVersionId: text.versionId,
          accountId,
          sessionId: actor.sessionId,
          ip: meta.ip,
          deviceId: meta.deviceId ?? null,
        })
        .onConflictDoNothing()
        .returning();
      if (inserted.length === 0) throw new ConflictException({ error: 'consent_already_given' });
      if (guarantor) {
        await tx
          .update(creditGuarantors)
          .set({ status: 'consented', consentAt: now })
          .where(eq(creditGuarantors.id, guarantor.id));
      }
      await this.audit.record(
        {
          actor,
          action: 'credit.consent_given',
          entityType: 'credit_application',
          entityId: app.id,
          after: { role, consentTextVersionId: text.versionId },
        },
        tx,
      );
      await this.publish(tx, 'credit.consent_given', app);
    });
    return { role, givenAt: now.toISOString() };
  }

  // --- guarantors (doc 10 §5) ---------------------------------------------------------

  /** The patient or borrower introduces a guarantor by mobile. */
  async inviteAsApplicant(actor: Actor, accountId: string, id: string, mobile: string) {
    const persons = await this.applications.personsOf(accountId);
    const app = await this.appRow(id);
    if (!persons.includes(app.patientPersonId) && !persons.includes(app.borrowerPersonId)) {
      throw new NotFoundException({ error: 'credit_application_not_found' });
    }
    return this.invite(actor, app, mobile);
  }

  /** The case-completion specialist introduces one. */
  async inviteAsStaff(actor: Actor, access: EffectiveAccess, id: string, mobile: string) {
    if (!access.permissions.has('credit.complete_applications')) {
      throw new ForbiddenException({ error: 'permission_required' });
    }
    return this.invite(actor, await this.applications.staffApplication(access, id), mobile);
  }

  /** What a guarantor sees: their own commitments, nothing of the borrower (test 10). */
  async myGuarantees(accountId: string) {
    const persons = await this.applications.personsOf(accountId);
    if (persons.length === 0) return [];
    const rows = await this.db
      .select({ g: creditGuarantors, total: creditApplications.totalObligationRial })
      .from(creditGuarantors)
      .innerJoin(
        creditApplications,
        eq(creditApplications.id, creditGuarantors.creditApplicationId),
      )
      .where(
        and(inArray(creditGuarantors.personId, persons), ne(creditGuarantors.status, 'withdrawn')),
      )
      .orderBy(asc(creditGuarantors.createdAt));
    return rows.map(({ g, total }) => guaranteeView(g, total));
  }

  async myGuarantee(accountId: string, guaranteeId: string) {
    const mine = await this.myGuarantees(accountId);
    const found = mine.find((g) => g.id === guaranteeId);
    if (!found) throw new NotFoundException({ error: 'guarantee_not_found' });
    return found;
  }

  // --- score sheets (doc 10 §5) -------------------------------------------------------

  async score(
    actor: Actor,
    access: EffectiveAccess,
    id: string,
    input:
      | { subject: 'borrower'; raw: RawBorrowerData }
      | { subject: 'guarantor'; guarantorId: string; raw: RawGuarantorData },
    now = new Date(),
  ) {
    if (!access.permissions.has('credit.score_applications')) {
      throw new ForbiddenException({ error: 'permission_required' });
    }
    const reached = await this.applications.staffApplication(access, id);
    const sheet = await this.db.transaction(async (tx) => {
      const [app] = await tx
        .select()
        .from(creditApplications)
        .where(eq(creditApplications.id, reached.id))
        .for('update');
      if (!app) throw new NotFoundException({ error: 'credit_application_not_found' });
      if (!['ready_for_review', 'scoring', 'manual_review'].includes(app.status)) {
        throw new ConflictException({ error: 'wrong_status', status: app.status });
      }
      let guarantor: GuarantorRow | null = null;
      let personId = app.borrowerPersonId;
      if (input.subject === 'guarantor') {
        const [g] = await tx
          .select()
          .from(creditGuarantors)
          .where(
            and(
              eq(creditGuarantors.id, input.guarantorId),
              eq(creditGuarantors.creditApplicationId, app.id),
            ),
          );
        if (!g || g.status === 'withdrawn')
          throw new NotFoundException({ error: 'guarantor_not_found' });
        // Owner 1405/07/27: a third guarantor has no effect on the score, so no sheet.
        if (!(await this.scoredGuarantors(tx, app.id)).includes(g.personId)) {
          throw new ConflictException({ error: 'guarantor_not_scored' });
        }
        guarantor = g;
        personId = g.personId;
      }
      // No score without the person's own consent (doc 10 §10 test 13).
      const [consent] = await tx
        .select({ id: creditConsents.id })
        .from(creditConsents)
        .where(
          and(
            eq(creditConsents.creditApplicationId, app.id),
            eq(creditConsents.personId, personId),
            eq(creditConsents.role, input.subject),
          ),
        );
      if (!consent) throw new ConflictException({ error: 'consent_required' });

      const rules = app.rulesetVersionId
        ? await this.config.getVersion('credit.scoring_ruleset', app.rulesetVersionId)
        : await this.config.resolve('credit.scoring_ruleset', {}, now);
      const reviewedOn = toJalali(now);
      const current = await this.currentSheets(tx, app.id);

      let answers: ScoringAnswerSet;
      let party: {
        scores: Readonly<Record<string, number | null>>;
        total: number | null;
        grade: string | null;
        gradeLabel: string | null;
        stop: boolean | null;
      };
      let weight: number | null = null;
      let level: string | null = null;
      try {
        if (input.subject === 'borrower') {
          answers =
            classify(rules.value, { borrower: input.raw, guarantors: [] }, reviewedOn).borrower ??
            {};
          const outcome = evaluate(
            rules.value,
            { borrower: answers, guarantors: await this.guarantorAnswers(tx, app.id, current) },
            app.loanRial,
          );
          party = outcome.borrower;
          level = outcome.amountLevel?.level ?? null;
        } else {
          answers =
            classify(rules.value, { borrower: {}, guarantors: [input.raw] }, reviewedOn)
              .guarantors[0] ?? {};
          const outcome = evaluate(
            rules.value,
            { borrower: null, guarantors: [answers, null] },
            null,
          );
          const g = outcome.guarantors[0];
          party = g;
          weight = g.grade === null ? null : g.weight;
        }
      } catch (error) {
        throw new BadRequestException({
          error: 'invalid_raw_data',
          message: (error as Error).message,
        });
      }

      // The new sheet's id first: the last one points at it before the new one is written,
      // as only one current sheet per person may exist at any moment (a unique index).
      const idRow = await tx.execute(sql`SELECT uuidv7() AS id`);
      const sheetId = idRow.rows[0]?.['id'] as string;
      const previous = current.find((s) => s.subject === input.subject && s.personId === personId);
      if (previous) {
        await tx
          .update(scoreSheets)
          .set({ supersededBy: sheetId })
          .where(eq(scoreSheets.id, previous.id));
      }
      const [made] = await tx
        .insert(scoreSheets)
        .values({
          id: sheetId,
          creditApplicationId: app.id,
          subject: input.subject,
          personId,
          guarantorId: guarantor?.id ?? null,
          rulesetVersionId: rules.versionId,
          rawInputs: asJson(input.raw),
          answers,
          criteriaScores: party.scores,
          total: party.total,
          grade: party.grade,
          stop: party.stop,
          computedBy: actor.accountId ?? '',
        })
        .returning();
      if (!made) throw new Error('score sheet insert returned nothing');

      if (input.subject === 'borrower') {
        const toScoring = app.status === 'ready_for_review';
        await tx
          .update(creditApplications)
          .set({
            rulesetVersionId: rules.versionId,
            borrowerGrade: party.grade,
            amountLevel: level,
            ...(toScoring ? { status: 'scoring' as const } : {}),
          })
          .where(eq(creditApplications.id, app.id));
        if (toScoring) {
          await tx.insert(creditApplicationStatusChanges).values({
            creditApplicationId: app.id,
            fromStatus: app.status,
            toStatus: 'scoring',
            actorAccountId: actor.accountId,
            note: 'first score sheet',
          });
        }
        await this.publish(tx, 'credit.borrower_scored', app);
      } else if (guarantor) {
        if (app.rulesetVersionId === null) {
          await tx
            .update(creditApplications)
            .set({ rulesetVersionId: rules.versionId })
            .where(eq(creditApplications.id, app.id));
        }
        await tx
          .update(creditGuarantors)
          .set(party.grade === null ? {} : { status: 'scored', grade: party.grade, weight })
          .where(eq(creditGuarantors.id, guarantor.id));
        await this.publish(tx, 'credit.guarantor_scored', app, guarantor.id);
      }
      await this.audit.record(
        {
          actor,
          action: 'credit.score_sheet_made',
          entityType: 'credit_application',
          entityId: app.id,
          after: {
            sheetId: made.id,
            subject: input.subject,
            total: party.total,
            grade: party.grade,
            supersedes: previous?.id ?? null,
          },
        },
        tx,
      );
      return { sheet: made, label: party.gradeLabel };
    });
    return sheetView(sheet.sheet, sheet.label);
  }

  /** Sheets, guarantors and the engine's proposal, for whoever may see credit scores. */
  async scoring(access: EffectiveAccess, id: string) {
    if (!access.permissions.has('credit.read_applications')) {
      throw new ForbiddenException({ error: 'permission_required' });
    }
    // Field limits (doc 10 §6): the score is for those who may see it.
    if (!access.permissions.has('access.view_credit_score')) {
      throw new ForbiddenException({ error: 'score_not_visible' });
    }
    const app = await this.applications.staffApplication(access, id);
    const sheets = await this.currentSheets(this.db, app.id);
    const guarantors = await this.db
      .select()
      .from(creditGuarantors)
      .where(
        and(
          eq(creditGuarantors.creditApplicationId, app.id),
          ne(creditGuarantors.status, 'withdrawn'),
        ),
      )
      .orderBy(asc(creditGuarantors.createdAt));
    let outcome = null;
    let rules: ScoringRuleset | null = null;
    if (app.rulesetVersionId) {
      rules = (await this.config.getVersion('credit.scoring_ruleset', app.rulesetVersionId)).value;
      const borrower = sheets.find((s) => s.subject === 'borrower');
      const result = evaluate(
        rules,
        {
          borrower: (borrower?.answers as ScoringAnswerSet | undefined) ?? null,
          guarantors: await this.guarantorAnswers(this.db, app.id, sheets),
        },
        app.loanRial,
      );
      outcome = {
        requirement: result.requirement?.label ?? null,
        sufficiency: result.sufficiency,
        authority: result.authority,
      };
    }
    const label = (s: SheetRow) => {
      const party = s.subject === 'borrower' ? rules?.borrower : rules?.guarantor;
      return (
        [...(party?.grades ?? []), ...(party ? [party.fallback] : [])].find(
          (g) => g.grade === s.grade,
        )?.label ?? null
      );
    };
    return {
      creditApplicationId: app.id,
      rulesetVersionId: app.rulesetVersionId,
      borrowerGrade: app.borrowerGrade,
      amountLevel: app.amountLevel,
      sheets: sheets.map((s) => sheetView(s, label(s))),
      guarantors: guarantors.map((g) => ({
        id: g.id,
        status: g.status,
        invitedAt: g.createdAt.toISOString(),
        consentAt: g.consentAt?.toISOString() ?? null,
        grade: g.grade,
        weight: g.weight,
      })),
      outcome,
      // The criteria and options of the locked rules (or today's, before the first sheet),
      // for the raw-data form and to name each score (task 3-8).
      criteria: criteriaOf(rules ?? (await this.config.resolve('credit.scoring_ruleset')).value),
    };
  }

  /**
   * What the engine says of the application for `amountRial` (task 3-6): the borrower's
   * and guarantors' current sheets under the locked rules version. Doc 03 §4: the caller
   * gives the final approved amount, so a reduced amount is levelled again. Null before
   * the first sheet locks a rules version.
   */
  async assess(ex: Tx | Database, app: ApplicationRow, amountRial: bigint) {
    if (app.rulesetVersionId === null) return null;
    const rules = (await this.config.getVersion('credit.scoring_ruleset', app.rulesetVersionId))
      .value;
    const sheets = await this.currentSheets(ex, app.id);
    const borrower = sheets.find((s) => s.subject === 'borrower');
    return evaluate(
      rules,
      {
        borrower: (borrower?.answers as ScoringAnswerSet | undefined) ?? null,
        guarantors: await this.guarantorAnswers(ex, app.id, sheets),
      },
      amountRial,
    );
  }

  // --- helpers ------------------------------------------------------------------------

  private async invite(actor: Actor, app: ApplicationRow, mobileInput: string) {
    if (!(OPEN as readonly string[]).includes(app.status)) {
      throw new ConflictException({ error: 'wrong_status', status: app.status });
    }
    // Doc 03 §1: no guarantor is asked for before the borrower has a grade (test 2).
    if (app.borrowerGrade === null) throw new ConflictException({ error: 'borrower_not_graded' });
    const mobile = normalizeMobile(mobileInput);
    if (mobile === null) throw new BadRequestException({ error: 'invalid_mobile' });
    const { personId } = await this.persons.findOrCreateByMobile(mobile);
    // Task 9-3: a pending mobile stands for nobody yet, so it guarantees for nobody.
    if (personId === null) throw new ConflictException({ error: 'person_mobile_pending' });
    if (personId === app.borrowerPersonId || personId === app.patientPersonId) {
      throw new ConflictException({ error: 'guarantor_is_borrower' });
    }
    const row = await this.db.transaction(async (tx) => {
      await tx
        .select({ id: creditApplications.id })
        .from(creditApplications)
        .where(eq(creditApplications.id, app.id))
        .for('update');
      const active = await tx
        .select({ id: creditGuarantors.id, personId: creditGuarantors.personId })
        .from(creditGuarantors)
        .where(
          and(
            eq(creditGuarantors.creditApplicationId, app.id),
            ne(creditGuarantors.status, 'withdrawn'),
          ),
        );
      if (active.some((g) => g.personId === personId))
        throw new ConflictException({ error: 'already_a_guarantor' });
      if (active.length >= MAX_GUARANTORS)
        throw new ConflictException({ error: 'too_many_guarantors' });
      const [made] = await tx
        .insert(creditGuarantors)
        .values({ creditApplicationId: app.id, personId, invitedBy: actor.accountId ?? '' })
        .returning();
      if (!made) throw new Error('guarantor insert returned nothing');
      await this.audit.record(
        {
          actor,
          action: 'credit.guarantor_invited',
          entityType: 'credit_application',
          entityId: app.id,
          after: { guarantorId: made.id },
        },
        tx,
      );
      await this.publish(tx, 'credit.guarantor_invited', app, made.id);
      return made;
    });
    return { id: row.id, status: row.status, invitedAt: row.createdAt.toISOString() };
  }

  /** Who consents: the borrower, or a guarantor, logged in as themselves. */
  private async consenter(accountId: string, id: string, role: ConsentRole) {
    const account = await this.accounts.find(accountId);
    if (!account || account.kind !== 'patient' || !account.mobile) {
      throw new ForbiddenException({ error: 'patients_only' });
    }
    const persons = await this.applications.personsOf(accountId);
    const app = await this.appRow(id);
    if (!(OPEN as readonly string[]).includes(app.status)) {
      throw new ConflictException({ error: 'wrong_status', status: app.status });
    }
    if (role === 'borrower') {
      if (!persons.includes(app.borrowerPersonId))
        throw new NotFoundException({ error: 'credit_application_not_found' });
      return { mobile: account.mobile, app, personId: app.borrowerPersonId, guarantor: null };
    }
    const [guarantor] = await this.db
      .select()
      .from(creditGuarantors)
      .where(
        and(
          eq(creditGuarantors.creditApplicationId, app.id),
          inArray(creditGuarantors.personId, persons.length > 0 ? persons : [app.id]),
          ne(creditGuarantors.status, 'withdrawn'),
        ),
      );
    if (!guarantor) throw new NotFoundException({ error: 'credit_application_not_found' });
    return { mobile: account.mobile, app, personId: guarantor.personId, guarantor };
  }

  private async appRow(id: string): Promise<ApplicationRow> {
    if (!UUID.test(id)) throw new NotFoundException({ error: 'credit_application_not_found' });
    const [app] = await this.db
      .select()
      .from(creditApplications)
      .where(eq(creditApplications.id, id));
    if (!app) throw new NotFoundException({ error: 'credit_application_not_found' });
    return app;
  }

  private currentSheets(ex: Tx | Database, appId: string) {
    return ex
      .select()
      .from(scoreSheets)
      .where(and(eq(scoreSheets.creditApplicationId, appId), isNull(scoreSheets.supersededBy)))
      .orderBy(asc(scoreSheets.createdAt));
  }

  /** The scored guarantors' persons: the first two still active, in the order invited. */
  private async scoredGuarantors(ex: Tx | Database, appId: string): Promise<string[]> {
    const rows = await ex
      .select({ personId: creditGuarantors.personId })
      .from(creditGuarantors)
      .where(
        and(
          eq(creditGuarantors.creditApplicationId, appId),
          ne(creditGuarantors.status, 'withdrawn'),
        ),
      )
      .orderBy(asc(creditGuarantors.createdAt), asc(creditGuarantors.id))
      .limit(SCORED_GUARANTORS);
    return rows.map((r) => r.personId);
  }

  /** The two scored guarantors' latest answers, in the order they were invited. */
  private async guarantorAnswers(
    ex: Tx | Database,
    appId: string,
    sheets: readonly SheetRow[],
  ): Promise<[ScoringAnswerSet | null, ScoringAnswerSet | null]> {
    const scored = await this.scoredGuarantors(ex, appId);
    const of = (personId: string | undefined) => {
      if (personId === undefined) return null;
      const sheet = sheets.find((s) => s.subject === 'guarantor' && s.personId === personId);
      return sheet ? (sheet.answers as ScoringAnswerSet) : null;
    };
    return [of(scored[0]), of(scored[1])];
  }

  private async publish(tx: Tx, type: string, app: ApplicationRow, guarantorId?: string) {
    await this.outbox.publish(
      {
        type,
        aggregateType: 'credit_application',
        aggregateId: app.id,
        payload: {
          creditApplicationId: app.id,
          caseId: app.caseId,
          proformaId: app.proformaId,
          ...(guarantorId === undefined ? {} : { guarantorId }),
        },
      },
      tx,
    );
  }
}

function criteriaOf(rules: ScoringRuleset) {
  const party = (p: ScoringRuleset['borrower'] | ScoringRuleset['guarantor']) =>
    p.criteria.map((c) => ({
      code: c.code,
      label: c.label,
      options: c.options.map((o) => ({ code: o.code, label: o.label, score: o.score })),
    }));
  return { borrower: party(rules.borrower), guarantor: party(rules.guarantor) };
}

function guaranteeView(g: GuarantorRow, commitment: bigint) {
  return {
    id: g.id,
    creditApplicationId: g.creditApplicationId,
    commitmentRial: commitment.toString(),
    status: g.status,
    consentGiven: g.consentAt !== null,
    invitedAt: g.createdAt.toISOString(),
  };
}

function sheetView(s: SheetRow, gradeLabel: string | null) {
  return {
    id: s.id,
    subject: s.subject,
    guarantorId: s.guarantorId,
    rulesetVersionId: s.rulesetVersionId,
    rawInputs: s.rawInputs as Record<string, unknown>,
    answers: s.answers as Record<string, string>,
    criteriaScores: s.criteriaScores as Record<string, number | null>,
    total: s.total,
    grade: s.grade,
    gradeLabel,
    stop: s.stop,
    createdAt: s.createdAt.toISOString(),
  };
}

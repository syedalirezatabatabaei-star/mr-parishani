import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CONFIG } from '../../src/common/config/config.port';
import { EVENT_CONSUMERS } from '../../src/common/events/outbox.port';
import { LEAD_CASES } from '../../src/common/lead/lead-cases.port';
import { CreditNotifier } from '../../src/modules/credit/credit-notifier';
import { DATABASE, type Database } from '../../src/db/database.module';
import { creditApplications } from '../../src/modules/credit/credit.schema';
import { CreditScoringService } from '../../src/modules/credit/credit-scoring.service';
import { newMobile, startHarness, type Harness } from '../identity/harness';
import { CREDIT_HARNESS, creditWorld, type Body, type Row } from './world';

/**
 * Task 3-5 part B (doc 10 §4–§5): consent with a one-time code (§10 test 13), raw data
 * scored by the engine under a locked rules version (test 12 at the API), guarantors only
 * after the borrower's grade (test 2), and a guarantor who sees only their own commitment
 * (test 10, IDOR).
 */

let h: Harness;
let w: Awaited<ReturnType<typeof creditWorld>>;

const borrowerRaw = {
  job: 'official',
  employmentStartedOn: { year: 1398, month: 1, day: 1 },
  coverage: 'full',
  obligationsRial: '1000000',
  newInstallmentRial: '4000000',
};
const guarantorRaw = {
  job: 'official',
  employmentStartedOn: { year: 1395, month: 1, day: 1 },
  averageBalanceRial: '30000000',
  installmentRial: '900000',
  debts: 'none_or_very_low',
  independence: 'fully_independent',
};

beforeAll(async () => {
  h = await startHarness(CREDIT_HARNESS);
  w = await creditWorld(h);
}, 120_000);

afterAll(async () => {
  await h.close();
});

describe('consent before scoring (doc 10 §10 test 13)', () => {
  it('no review, so no sheet, without the borrower’s own consent by code; then the engine grades', async () => {
    // Part C: credit review needs the borrower's consent (and documents) first, so a
    // borrower is never scored without consent; a guarantor's sheet checks it itself (below).
    const { patient, proformaId } = await w.confirmedProforma();
    const made = await w.as(patient, 'POST', '/me/credit-applications', {
      proformaId,
      planCode: 'dental_12',
      installmentCount: 12,
    });
    const applicationId = made.body['id'] as string;
    await w.as(patient, 'POST', `/me/credit-applications/${applicationId}/submit`);
    const early = await w.staff(
      w.completion,
      'POST',
      `/credit/applications/${applicationId}/ready-for-review`,
    );
    expect(early.status).toBe(409);
    expect(early.body['error']).toBe('not_complete');
    expect(early.body['missing']).toEqual(
      expect.arrayContaining(['consent:borrower', 'document:national_card']),
    );
    const sheetless = await w.staff(
      w.creditSpecialist,
      'POST',
      `/credit/applications/${applicationId}/score-sheets`,
      { subject: 'borrower', raw: borrowerRaw },
    );
    expect(sheetless.status).toBe(409);

    // A wrong code consents to nothing.
    await w.as(patient, 'POST', `/me/credit-applications/${applicationId}/consent/request`, {
      role: 'borrower',
    });
    const wrong = await w.as(patient, 'POST', `/me/credit-applications/${applicationId}/consent`, {
      role: 'borrower',
      code: '000000',
    });
    expect(wrong.status).toBe(401);
    // The resend cooldown is the login code's; the test moves past it.
    await h.redis.del(`identity:challenge-cooldown:credit_consent:${patient.mobile}`);
    const given = await w.consent(patient, applicationId, 'borrower');
    expect(given['role']).toBe('borrower');
    const { rows } = await h.owner.query<Row>(
      'SELECT consent_text_version_id, account_id, ip FROM credit_consents WHERE credit_application_id = $1',
      [applicationId],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.['account_id']).toBe(patient.id);
    await h.redis.del(`identity:challenge-cooldown:credit_consent:${patient.mobile}`);
    await w.as(patient, 'POST', `/me/credit-applications/${applicationId}/consent/request`, {
      role: 'borrower',
    });
    const again = await w.as(patient, 'POST', `/me/credit-applications/${applicationId}/consent`, {
      role: 'borrower',
      code: h.sms.lastCodeFor(patient.mobile),
    });
    expect(again.status).toBe(409);
    await w.documented(patient, applicationId, 'borrower');
    expect(
      (
        await w.staff(
          w.completion,
          'POST',
          `/credit/applications/${applicationId}/ready-for-review`,
        )
      ).status,
    ).toBe(201);

    const sheet = await w.staff(
      w.creditSpecialist,
      'POST',
      `/credit/applications/${applicationId}/score-sheets`,
      {
        subject: 'borrower',
        raw: borrowerRaw,
      },
    );
    expect(sheet.status).toBe(201);
    expect(sheet.body).toMatchObject({
      subject: 'borrower',
      total: 100,
      grade: 'alef',
      gradeLabel: 'الف',
      stop: false,
    });
    const app = await w.staff(w.creditSpecialist, 'GET', `/credit/applications/${applicationId}`);
    expect(app.body['status']).toBe('scoring');
  });

  it('refuses medical data in the raw data, and a stranger’s consent', async () => {
    const { applicationId } = await w.inReview();
    const medical = await w.staff(
      w.creditSpecialist,
      'POST',
      `/credit/applications/${applicationId}/score-sheets`,
      {
        subject: 'borrower',
        raw: { ...borrowerRaw, treatmentField: 'implant' },
      },
    );
    expect(medical.status).toBe(400);
    const stranger = await w.patient();
    expect(
      (
        await w.as(stranger, 'POST', `/me/credit-applications/${applicationId}/consent/request`, {
          role: 'borrower',
        })
      ).status,
    ).toBe(404);
    // Only the credit specialist scores.
    expect(
      (
        await w.staff(w.completion, 'POST', `/credit/applications/${applicationId}/score-sheets`, {
          subject: 'borrower',
          raw: borrowerRaw,
        })
      ).status,
    ).toBe(403);
  });
});

describe('guarantors (doc 10 §5; §10 tests 2 and 10)', () => {
  it('only after the borrower’s grade; at most two; never the borrower', async () => {
    const { patient, applicationId } = await w.inReview();
    const early = await w.as(
      patient,
      'POST',
      `/me/credit-applications/${applicationId}/guarantors`,
      { mobile: `0${newMobile()}` },
    );
    expect(early.status).toBe(409);
    expect(early.body['error']).toBe('borrower_not_graded');

    await w.staff(
      w.creditSpecialist,
      'POST',
      `/credit/applications/${applicationId}/score-sheets`,
      { subject: 'borrower', raw: borrowerRaw },
    );
    expect(
      (
        await w.as(patient, 'POST', `/me/credit-applications/${applicationId}/guarantors`, {
          mobile: `0${patient.mobile}`,
        })
      ).status,
    ).toBe(409);
    expect(
      (
        await w.as(patient, 'POST', `/me/credit-applications/${applicationId}/guarantors`, {
          mobile: `0${newMobile()}`,
        })
      ).status,
    ).toBe(201);
    expect(
      (
        await w.staff(w.completion, 'POST', `/credit/applications/${applicationId}/guarantors`, {
          mobile: `0${newMobile()}`,
        })
      ).status,
    ).toBe(201);
    // Owner 1405/07/27 (plan e): up to three; the fourth is refused.
    const third = await w.as(
      patient,
      'POST',
      `/me/credit-applications/${applicationId}/guarantors`,
      { mobile: `0${newMobile()}` },
    );
    expect(third.status).toBe(201);
    const fourth = await w.as(
      patient,
      'POST',
      `/me/credit-applications/${applicationId}/guarantors`,
      { mobile: `0${newMobile()}` },
    );
    expect(fourth.status).toBe(409);
    expect(fourth.body['error']).toBe('too_many_guarantors');
  });

  it('owner 1405/07/27: a third guarantor is recorded with no score; the first two active, as invited, are', async () => {
    const { patient, applicationId } = await w.inReview();
    await w.staff(
      w.creditSpecialist,
      'POST',
      `/credit/applications/${applicationId}/score-sheets`,
      { subject: 'borrower', raw: borrowerRaw },
    );
    const mobiles = [newMobile(), newMobile(), newMobile()];
    for (const m of mobiles) {
      const invited = await w.as(
        patient,
        'POST',
        `/me/credit-applications/${applicationId}/guarantors`,
        {
          mobile: `0${m}`,
        },
      );
      expect(invited.status).toBe(201);
    }
    const people = [];
    for (const m of mobiles) people.push(await w.patient(m));
    const ids: string[] = [];
    for (const p of people) {
      await w.consent(p, applicationId, 'guarantor');
      const mine = (await w.as(p, 'GET', '/me/guarantees')).body as unknown as Body[];
      ids.push(mine[0]?.['id'] as string);
    }
    const sheet = (guarantorId: string | undefined) =>
      w.staff(w.creditSpecialist, 'POST', `/credit/applications/${applicationId}/score-sheets`, {
        subject: 'guarantor',
        guarantorId,
        raw: guarantorRaw,
      });
    // The third: no sheet, whatever order the sheets are made in.
    const refused = await sheet(ids[2]);
    expect(refused.status).toBe(409);
    expect(refused.body['error']).toBe('guarantor_not_scored');
    expect((await sheet(ids[1])).status).toBe(201);
    expect((await sheet(ids[0])).status).toBe(201);
    const scored = await w.staff(
      w.creditSpecialist,
      'GET',
      `/credit/applications/${applicationId}/scoring`,
    );
    const guarantorSheets = (scored.body['sheets'] as Body[]).filter(
      (s) => s['subject'] === 'guarantor',
    );
    expect(guarantorSheets).toHaveLength(2);
    // The first withdrawn: the third is now one of the two scored.
    await h.owner.query(`UPDATE credit_guarantors SET status = 'withdrawn' WHERE id = $1`, [
      ids[0],
    ]);
    expect((await sheet(ids[2])).status).toBe(201);
  });

  it('owner 1405/07/27: the case is scored from the two scored guarantors, as invited; a third changes nothing', async () => {
    const { patient, applicationId } = await w.inReview();
    await w.staff(
      w.creditSpecialist,
      'POST',
      `/credit/applications/${applicationId}/score-sheets`,
      {
        subject: 'borrower',
        raw: borrowerRaw,
      },
    );
    const invite = async () => {
      const mobile = newMobile();
      expect(
        (
          await w.as(patient, 'POST', `/me/credit-applications/${applicationId}/guarantors`, {
            mobile: `0${mobile}`,
          })
        ).status,
      ).toBe(201);
      const who = await w.patient(mobile);
      await w.consent(who, applicationId, 'guarantor');
      const mine = (await w.as(who, 'GET', '/me/guarantees')).body as unknown as Body[];
      return mine[0]?.['id'] as string;
    };
    const sheet = async (guarantorId: string, raw: Body) => {
      const made = await w.staff(
        w.creditSpecialist,
        'POST',
        `/credit/applications/${applicationId}/score-sheets`,
        { subject: 'guarantor', guarantorId, raw },
      );
      expect(made.status, JSON.stringify(made.body)).toBe(201);
      return made.body['total'] as number;
    };
    const first = await invite();
    const second = await invite();
    // Sheets made the other way round: the second first, with other answers.
    const secondTotal = await sheet(second, guarantorRaw);
    const firstTotal = await sheet(first, {
      ...guarantorRaw,
      independence: 'household_own_income',
    });
    expect(firstTotal).not.toBe(secondTotal);
    const scoring = h.app.get(CreditScoringService, { strict: false });
    const db = h.app.get<Database>(DATABASE);
    const assess = async () => {
      const [app] = await db
        .select()
        .from(creditApplications)
        .where(eq(creditApplications.id, applicationId));
      if (!app) throw new Error('no application');
      const outcome = await scoring.assess(db, app, app.loanRial);
      return outcome;
    };
    const before = await assess();
    // In the order invited, whatever the order the sheets were made in.
    expect(before?.guarantors.map((g) => g.total)).toEqual([firstTotal, secondTotal]);
    // A third, invited and consented: the outcome is exactly the same.
    const third = await invite();
    expect(await assess()).toEqual(before);
    // The first withdrawn: the second and the third (no sheet yet) are the two.
    await h.owner.query(`UPDATE credit_guarantors SET status = 'withdrawn' WHERE id = $1`, [first]);
    expect((await assess())?.guarantors.map((g) => g.total)).toEqual([secondTotal, null]);
    const thirdTotal = await sheet(third, guarantorRaw);
    expect((await assess())?.guarantors.map((g) => g.total)).toEqual([secondTotal, thirdTotal]);
  });

  it('a guarantor sees only their own commitment; never the borrower’s application or score', async () => {
    const { patient, applicationId } = await w.inReview();
    await w.staff(
      w.creditSpecialist,
      'POST',
      `/credit/applications/${applicationId}/score-sheets`,
      { subject: 'borrower', raw: borrowerRaw },
    );
    const mobileA = newMobile();
    const mobileB = newMobile();
    await w.as(patient, 'POST', `/me/credit-applications/${applicationId}/guarantors`, {
      mobile: `0${mobileA}`,
    });
    await w.as(patient, 'POST', `/me/credit-applications/${applicationId}/guarantors`, {
      mobile: `0${mobileB}`,
    });
    const a = await w.patient(mobileA);
    const b = await w.patient(mobileB);

    const mine = await w.as(a, 'GET', '/me/guarantees');
    const list = mine.body as unknown as Body[];
    expect(list).toHaveLength(1);
    // Exactly these fields: nothing of the borrower, their score or their treatment.
    expect(Object.keys(list[0] ?? {}).sort()).toEqual([
      'commitmentRial',
      'consentGiven',
      'creditApplicationId',
      'id',
      'invitedAt',
      'status',
    ]);
    expect(list[0]).toMatchObject({
      creditApplicationId: applicationId,
      commitmentRial: '10560000',
      status: 'invited',
      consentGiven: false,
    });
    const theirs = (await w.as(b, 'GET', '/me/guarantees')).body as unknown as Body[];
    expect((await w.as(a, 'GET', `/me/guarantees/${theirs[0]?.['id'] as string}`)).status).toBe(
      404,
    );
    expect((await w.as(a, 'GET', `/me/credit-applications/${applicationId}`)).status).toBe(404);
    expect((await w.as(a, 'GET', `/credit/applications/${applicationId}/scoring`)).status).toBe(
      403,
    );
    expect(JSON.stringify(mine.body)).not.toMatch(/grade|total|score|doctor|treatment/i);

    // No sheet for a guarantor before their own consent (doc 10 §10 test 13).
    const unconsented = await w.staff(
      w.creditSpecialist,
      'POST',
      `/credit/applications/${applicationId}/score-sheets`,
      { subject: 'guarantor', guarantorId: list[0]?.['id'], raw: guarantorRaw },
    );
    expect(unconsented.status).toBe(409);
    expect(unconsented.body['error']).toBe('consent_required');
    // The guarantor consents and is scored; the specialist sees the engine's proposal.
    await w.consent(a, applicationId, 'guarantor');
    const sheet = await w.staff(
      w.creditSpecialist,
      'POST',
      `/credit/applications/${applicationId}/score-sheets`,
      {
        subject: 'guarantor',
        guarantorId: list[0]?.['id'],
        raw: guarantorRaw,
      },
    );
    expect(sheet.status).toBe(201);
    expect(sheet.body).toMatchObject({ subject: 'guarantor', total: 100, grade: 'excellent' });
    const scoring = await w.staff(
      w.creditSpecialist,
      'GET',
      `/credit/applications/${applicationId}/scoring`,
    );
    expect(scoring.status).toBe(200);
    expect(scoring.body).toMatchObject({ borrowerGrade: 'alef', amountLevel: 'low' });
    expect((scoring.body['outcome'] as Body)['sufficiency']).toMatchObject({
      outcome: 'not_required',
    });
    const guarantors = scoring.body['guarantors'] as Body[];
    expect(guarantors.find((g) => g['id'] === list[0]?.['id'])).toMatchObject({
      status: 'scored',
      weight: 3,
    });
    // Case completion reads applications but not scores (doc 10 §6).
    const hidden = await w.staff(
      w.completion,
      'GET',
      `/credit/applications/${applicationId}/scoring`,
    );
    expect(hidden.status).toBe(403);
    expect(hidden.body['error']).toBe('score_not_visible');
  });

  it('a new sheet supersedes the last, and the rules version stays locked', async () => {
    const { applicationId } = await w.inReview();
    const first = await w.staff(
      w.creditSpecialist,
      'POST',
      `/credit/applications/${applicationId}/score-sheets`,
      { subject: 'borrower', raw: borrowerRaw },
    );
    const second = await w.staff(
      w.creditSpecialist,
      'POST',
      `/credit/applications/${applicationId}/score-sheets`,
      {
        subject: 'borrower',
        raw: { ...borrowerRaw, coverage: 'under_80' },
      },
    );
    expect(second.body).toMatchObject({ total: 75, grade: 'be' });
    const { rows } = await h.owner.query<Row>(
      'SELECT id, superseded_by FROM score_sheets WHERE credit_application_id = $1 ORDER BY created_at',
      [applicationId],
    );
    expect(rows.map((r) => r['superseded_by'])).toEqual([second.body['id'], null]);
    expect(first.body['rulesetVersionId']).toBe(second.body['rulesetVersionId']);
    await expect(
      h.owner.query('UPDATE score_sheets SET total = 1 WHERE id = $1', [second.body['id']]),
    ).rejects.toThrow(/fixed/);
    await expect(
      h.owner.query(
        'UPDATE credit_applications SET ruleset_version_id = gen_random_uuid() WHERE id = $1',
        [applicationId],
      ),
    ).rejects.toThrow(/locked/);
    const scoring = await w.staff(
      w.creditSpecialist,
      'GET',
      `/credit/applications/${applicationId}/scoring`,
    );
    expect(scoring.body['borrowerGrade']).toBe('be');
    expect(
      (scoring.body['sheets'] as Body[]).filter((s) => s['subject'] === 'borrower'),
    ).toHaveLength(1);
  });
});

describe('the guarantor’s invitation SMS (doc 10 §5)', () => {
  it('says only the commitment, in tomans, to the guarantor’s mobile', async () => {
    const { patient, applicationId } = await w.inReview();
    await w.staff(
      w.creditSpecialist,
      'POST',
      `/credit/applications/${applicationId}/score-sheets`,
      { subject: 'borrower', raw: borrowerRaw },
    );
    const mobile = newMobile();
    const invited = await w.as(
      patient,
      'POST',
      `/me/credit-applications/${applicationId}/guarantors`,
      { mobile: `0${mobile}` },
    );
    const { rows } = await h.owner.query<Row>(
      `SELECT id, event_type, aggregate_type, aggregate_id, payload, created_at FROM outbox_events
       WHERE event_type = 'credit.guarantor_invited' AND aggregate_id = $1`,
      [applicationId],
    );
    expect(rows).toHaveLength(1);
    const sent: { mobile: string; text: string }[] = [];
    const notifier = new CreditNotifier(
      { register: () => undefined },
      h.app.get(CONFIG),
      h.app.get(LEAD_CASES),
      { sendText: (job) => Promise.resolve(void sent.push(job)) },
    );
    const row = rows[0] ?? {};
    await notifier.handle(
      {
        id: row['id'] as string,
        type: 'credit.guarantor_invited',
        aggregateType: 'credit_application',
        aggregateId: applicationId,
        payload: row['payload'],
        occurredAt: (row['created_at'] as Date).toISOString(),
      },
      h.app.get<Database>(DATABASE),
    );
    expect(sent).toHaveLength(1);
    expect(sent[0]?.mobile).toBe(mobile);
    expect(sent[0]?.text).toContain('۱٬۰۵۶٬۰۰۰');
    expect(sent[0]?.text).not.toMatch(/دکتر|کلینیک|جرم|امتیاز/);
    expect(invited.body['status']).toBe('invited');
    expect(h.app.get(EVENT_CONSUMERS)).toBeDefined();
  });
});

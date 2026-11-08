import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  CREDIT_CONTRACT_FACTS,
  type CreditContractFactsPort,
} from '../../src/common/credit/credit-contract-facts.port';
import { CREDIT_HARNESS, creditWorld, PLAN, type Body } from './world';
import { startHarness, type Harness, type LoggedInAccount } from '../identity/harness';

/**
 * M1 §8.7 option ب (owner 1405/07/22): the plan chooser's figures are a preview, labelled
 * approximate; a draft application shows its own figures, recomputed from the configuration
 * versions it locked when it was created. They are the contract's to the rial, whatever is
 * approved since; only its owner sees them, and only while it is a draft.
 */
let h: Harness;
let w: Awaited<ReturnType<typeof creditWorld>>;
let manager: LoggedInAccount;

type Quote = {
  planFeeRial: string;
  originationFeeRial: string;
  totalObligationRial: string;
  totalPayableRial: string;
  installments: { index: number; dueOn: string; amountRial: string }[];
};

const rounding = (value: string) =>
  h.owner.query(
    `INSERT INTO config_values (key, scope_level, value, effective_at, status, reason, decided_at)
     VALUES ('repayment.rounding_unit_rial', 'global', $1, now(), 'approved', 'آزمون', now())`,
    [JSON.stringify(value)],
  );

beforeAll(async () => {
  h = await startHarness(CREDIT_HARNESS);
  w = await creditWorld(h);
  manager = await w.role('credit_manager');
}, 240_000);

afterAll(async () => {
  await h.close();
});

describe('a draft’s locked figures (M1 §8.7, option ب)', () => {
  it('stay those of its locked versions after a change, and are the contract’s to the rial', async () => {
    const { patient, proformaId } = await w.confirmedProforma();
    const made = await w.as(patient, 'POST', '/me/credit-applications', {
      proformaId,
      planCode: PLAN.code,
      installmentCount: 12,
    });
    expect(made.status).toBe(201);
    const id = made.body['id'] as string;
    const path = `/me/credit-applications/${id}/locked-quote`;

    const first = await w.as(patient, 'GET', path);
    expect(first.status, JSON.stringify(first.body)).toBe(200);
    expect(first.body).toMatchObject({ applicationId: id, dueDatesApproximate: true });
    const locked = first.body['quote'] as Quote;
    expect(locked.installments).toHaveLength(12);
    expect(locked.totalObligationRial).toBe(made.body['totalObligationRial']);
    const sum = locked.installments.reduce((a, i) => a + BigInt(i.amountRial), 0n);
    expect(sum.toString()).toBe(locked.totalObligationRial);

    // The rounding unit changes: a new preview follows it, the draft does not.
    const before = await w.as(patient, 'GET', `/me/proformas/${proformaId}/plans`);
    const previewBefore = (before.body['plans'] as Body[])[0] as unknown as {
      options: { installmentCount: number; quote: Quote }[];
    };
    await rounding('100000');
    try {
      const after = await w.as(patient, 'GET', `/me/proformas/${proformaId}/plans`);
      const previewAfter = (after.body['plans'] as Body[])[0] as unknown as {
        options: { installmentCount: number; quote: Quote }[];
      };
      const twelve = (p: typeof previewAfter) =>
        p.options
          .find((o) => o.installmentCount === 12)
          ?.quote.installments.map((i) => i.amountRial);
      expect(twelve(previewAfter)).not.toEqual(twelve(previewBefore));
      const again = await w.as(patient, 'GET', path);
      expect((again.body['quote'] as Quote).installments).toEqual(locked.installments);

      // Through submission and the credit decision, still under the changed unit: the
      // contract's installments are the draft's, to the rial.
      expect((await w.as(patient, 'POST', `/me/credit-applications/${id}/submit`)).status).toBe(
        201,
      );
      // After submission the credit unit decides: no more draft figures.
      const closed = await w.as(patient, 'GET', path);
      expect(closed.status).toBe(409);
      expect(closed.body['error']).toBe('application_not_draft');
      await w.consent(patient, id, 'borrower');
      await w.documented(patient, id, 'borrower');
      expect(
        (await w.staff(w.completion, 'POST', `/credit/applications/${id}/ready-for-review`)).status,
      ).toBe(201);
      await w.staff(w.creditSpecialist, 'POST', `/credit/applications/${id}/score-sheets`, {
        subject: 'borrower',
        raw: {
          job: 'official',
          employmentStartedOn: { year: 1398, month: 1, day: 1 },
          coverage: 'full',
          obligationsRial: '1000000',
          newInstallmentRial: '4000000',
        },
      });
      await w.staff(w.creditSpecialist, 'POST', `/credit/applications/${id}/to-decision`);
      const proposed = await w.staff(
        w.creditSpecialist,
        'POST',
        `/credit/applications/${id}/decisions`,
        { outcome: 'approved', reason: 'رتبه الف' },
      );
      const confirmed = await w.staff(
        manager,
        'POST',
        `/credit/applications/${id}/decisions/${proposed.body['id'] as string}/confirm`,
      );
      expect(confirmed.status, JSON.stringify(confirmed.body)).toBe(201);
      const facts = await h.app.get<CreditContractFactsPort>(CREDIT_CONTRACT_FACTS).facts(id);
      expect(
        facts?.installments.map((i) => ({ index: i.index, amountRial: i.amountRial.toString() })),
      ).toEqual(locked.installments.map((i) => ({ index: i.index, amountRial: i.amountRial })));
      expect({
        planFeeRial: facts?.planFeeRial.toString(),
        originationFeeRial: facts?.originationFeeRial.toString(),
        totalObligationRial: facts?.totalObligationRial.toString(),
      }).toEqual({
        planFeeRial: locked.planFeeRial,
        originationFeeRial: locked.originationFeeRial,
        totalObligationRial: locked.totalObligationRial,
      });
    } finally {
      await rounding('10000');
    }
  });

  it('are its owner’s only: another patient finds nothing (IDOR)', async () => {
    const { patient, proformaId } = await w.confirmedProforma();
    const made = await w.as(patient, 'POST', '/me/credit-applications', {
      proformaId,
      planCode: PLAN.code,
      installmentCount: 12,
    });
    const stranger = await w.patient();
    const res = await w.as(
      stranger,
      'GET',
      `/me/credit-applications/${made.body['id'] as string}/locked-quote`,
    );
    expect(res.status).toBe(404);
    expect(JSON.stringify(res.body)).not.toContain('installments');
  });
});

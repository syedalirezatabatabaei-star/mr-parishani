import { randomInt } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { newMobile, startHarness, type Harness, type loggedInAccount } from '../identity/harness';
import { fundingSteps } from '../credit/funding-steps';
import { CREDIT_HARNESS, creditWorld, type Body, type Row } from '../credit/world';

/**
 * The cheque rule (owner 1405/07/29, ج۵; migration 0101): a case is completed only when the
 * borrower has given at least instrument.borrower_cheque_min_count checked cheques, and each
 * guarantor's checked cheques together reach instrument.guarantee_cheque_min_bps of the
 * proforma's total (rounded up to the rial). Both 0 = off by default; set by two people. A
 * cheque only received (not yet checked) does not count; neither does another person's.
 */

type Staff = Awaited<ReturnType<typeof loggedInAccount>>;

let h: Harness;
let w: Awaited<ReturnType<typeof creditWorld>>;
let steps: ReturnType<typeof fundingSteps>;
let manager: Staff;
let strategyA: Staff;
let strategyB: Staff;

const guarantorRaw = {
  job: 'official',
  employmentStartedOn: { year: 1395, month: 1, day: 1 },
  averageBalanceRial: '30000000',
  installmentRial: '900000',
  debts: 'none_or_very_low',
  independence: 'fully_independent',
};
const alef = {
  job: 'official',
  employmentStartedOn: { year: 1398, month: 1, day: 1 },
  coverage: 'full',
  obligationsRial: '1000000',
  newInstallmentRial: '4000000',
};

beforeAll(async () => {
  h = await startHarness(CREDIT_HARNESS);
  w = await creditWorld(h);
  manager = await w.role('credit_manager');
  const finance = await w.role('accounting');
  steps = fundingSteps(h, w, { manager, finance });
  strategyA = await w.role('strategy_manager');
  strategyB = await w.role('strategy_manager');
}, 180_000);

afterAll(async () => {
  await h.close();
});

/** A business number set by two people, as the panel does. */
async function setKey(key: string, value: number) {
  const proposal = await w.staff(strategyA, 'POST', '/config/proposals', {
    key,
    scope: { level: 'global' },
    value,
    reason: 'قاعده چک، آزمون',
  });
  expect(proposal.status, JSON.stringify(proposal.body)).toBe(201);
  const done = await w.staff(
    strategyB,
    'POST',
    `/config/proposals/${proposal.body['id'] as string}/approve`,
  );
  expect(done.status).toBe(200);
}

/** An application approved with one guarantor. */
async function approvedWithGuarantor(visitRial?: string) {
  const { patient, applicationId } = await w.inReview(undefined, undefined, visitRial);
  await w.staff(w.creditSpecialist, 'POST', `/credit/applications/${applicationId}/score-sheets`, {
    subject: 'borrower',
    raw: alef,
  });
  const mobile = newMobile();
  await w.as(patient, 'POST', `/me/credit-applications/${applicationId}/guarantors`, {
    mobile: `0${mobile}`,
  });
  const guarantor = await w.patient(mobile);
  await w.consent(guarantor, applicationId, 'guarantor');
  await w.documented(guarantor, applicationId, 'guarantor');
  const scoring = await w.staff(
    w.creditSpecialist,
    'GET',
    `/credit/applications/${applicationId}/scoring`,
  );
  const guarantorId = (scoring.body['guarantors'] as Body[])[0]?.['id'] as string;
  await w.staff(w.creditSpecialist, 'POST', `/credit/applications/${applicationId}/score-sheets`, {
    subject: 'guarantor',
    guarantorId,
    raw: guarantorRaw,
  });
  await w.staff(w.creditSpecialist, 'POST', `/credit/applications/${applicationId}/to-decision`);
  const proposed = await w.staff(
    w.creditSpecialist,
    'POST',
    `/credit/applications/${applicationId}/decisions`,
    { outcome: 'approved', reason: 'رتبه الف' },
  );
  const confirmed = await w.staff(
    manager,
    'POST',
    `/credit/applications/${applicationId}/decisions/${proposed.body['id'] as string}/confirm`,
  );
  expect(confirmed.status).toBe(201);
  return { patient, guarantor, applicationId, guarantorId };
}

async function proformaTotal(applicationId: string): Promise<bigint> {
  const { rows } = await h.owner.query<Row>(
    `SELECT p.total_rial::text AS total FROM proformas p
     JOIN credit_applications a ON a.proforma_id = p.id WHERE a.id = $1`,
    [applicationId],
  );
  return BigInt(rows[0]?.['total'] as string);
}

interface Cheque {
  readonly issuer: { role: 'borrower' } | { role: 'guarantor'; guarantorId: string };
  readonly amountRial: bigint;
  /** Checked (Sayad confirmed, verified) unless false. */
  readonly checked?: boolean;
}

/** Registers each cheque on its own item of the delivery, and checks it unless told not to. */
const papers =
  (cheques: readonly Cheque[], ids: string[]) =>
  async (deliveryId: string, items: readonly Body[]) => {
    const slots = items.filter((i) => i['kind'] === 'cheque');
    for (const [n, c] of cheques.entries()) {
      const made = await w.staff(w.completion, 'POST', `/deliveries/${deliveryId}/instruments`, {
        itemId: slots[n]?.['id'],
        kind: 'cheque',
        issuer: c.issuer,
        amountRial: c.amountRial.toString(),
        dueOn: '2026-12-01',
        number: `6037${String(randomInt(10 ** 11, 10 ** 12))}`,
      });
      expect(made.status, JSON.stringify(made.body)).toBe(201);
      const id = made.body['id'] as string;
      ids.push(id);
      if (c.checked === false) continue;
      expect((await w.staff(w.completion, 'POST', `/instruments/${id}/sayad`)).status).toBe(201);
      expect((await w.staff(w.completion, 'POST', `/instruments/${id}/verify`)).status).toBe(201);
    }
  };

const chequeItems = (n: number) =>
  Array.from({ length: n }, (_, i) => ({ kind: 'cheque', label: `چک ${String(i + 1)}` }));

const status = async (applicationId: string) =>
  (await w.staff(w.completion, 'GET', `/completion/${applicationId}`)).body;
const complete = (applicationId: string) =>
  w.staff(w.completion, 'POST', `/completion/${applicationId}/complete`);

describe('the cheque rule (owner 1405/07/29, ج۵)', () => {
  it('is off at 0: a case with a guarantor and no cheque completes', async () => {
    const { patient, guarantor, applicationId } = await approvedWithGuarantor();
    await steps.ready(patient, applicationId, { guarantors: [guarantor] });
    const now = await status(applicationId);
    expect(now['missing']).toEqual([]);
    expect((await complete(applicationId)).status).toBe(201);
    // The completion keeps the versions it was read under (both 0 here).
    const { rows } = await h.owner.query<Row>(
      `SELECT after FROM audit_events WHERE action = 'contract.completed' AND entity_id = $1`,
      [applicationId],
    );
    const versions = (rows[0]?.['after'] as Body)['chequeRule'] as Body;
    const { rows: zero } = await h.owner.query<Row>(
      `SELECT key, id::text AS id FROM config_values
       WHERE key IN ('instrument.borrower_cheque_min_count', 'instrument.guarantee_cheque_min_bps')
         AND value = '0'::jsonb AND status = 'approved'`,
    );
    const idOf = (key: string) => zero.find((r) => r['key'] === key)?.['id'];
    expect(versions).toEqual({
      borrowerMinCountVersionId: idOf('instrument.borrower_cheque_min_count'),
      guaranteeMinBpsVersionId: idOf('instrument.guarantee_cheque_min_bps'),
    });
  });

  it('set by two people: blocks until the borrower and each guarantor have given enough', async () => {
    await setKey('instrument.borrower_cheque_min_count', 1);
    await setKey('instrument.guarantee_cheque_min_bps', 11_000);

    // No cheque at all: both short, and completion is refused.
    const bare = await approvedWithGuarantor();
    await steps.ready(bare.patient, bare.applicationId, { guarantors: [bare.guarantor] });
    expect((await status(bare.applicationId))['missing']).toEqual([
      'cheque:borrower',
      'cheque:guarantor:0',
    ]);
    const refused = await complete(bare.applicationId);
    expect(refused.status).toBe(409);
    expect(refused.body).toMatchObject({
      error: 'not_complete',
      missing: ['cheque:borrower', 'cheque:guarantor:0'],
    });

    // The borrower's cheque, however large, is not the guarantor's; and the guarantor's
    // cheques fall one rial short of 110% of the proforma, rounded up (12,000,001 × 1.1 =
    // 13,200,001.1, so 13,200,002 is due).
    const short = await approvedWithGuarantor('6000001');
    const total = await proformaTotal(short.applicationId);
    expect(total % 10n).not.toBe(0n);
    const needed = (total * 11_000n + 9_999n) / 10_000n;
    const guarantee = { role: 'guarantor' as const, guarantorId: short.guarantorId };
    await steps.ready(short.patient, short.applicationId, {
      guarantors: [short.guarantor],
      items: chequeItems(3),
      papers: papers(
        [
          { issuer: { role: 'borrower' }, amountRial: needed * 2n },
          { issuer: guarantee, amountRial: needed / 2n },
          { issuer: guarantee, amountRial: needed - needed / 2n - 1n },
        ],
        [],
      ),
    });
    expect((await status(short.applicationId))['missing']).toEqual(['cheque:guarantor:0']);
    expect((await complete(short.applicationId)).status).toBe(409);

    // Exactly 110%, over two cheques: completed.
    const enough = await approvedWithGuarantor('6000001');
    const exact = (await proformaTotal(enough.applicationId)) * 11_000n;
    const due = (exact + 9_999n) / 10_000n;
    const theirs = { role: 'guarantor' as const, guarantorId: enough.guarantorId };
    await steps.ready(enough.patient, enough.applicationId, {
      guarantors: [enough.guarantor],
      items: chequeItems(3),
      papers: papers(
        [
          { issuer: { role: 'borrower' }, amountRial: 5_000_000n },
          { issuer: theirs, amountRial: due / 2n },
          { issuer: theirs, amountRial: due - due / 2n },
        ],
        [],
      ),
    });
    expect((await status(enough.applicationId))['missing']).toEqual([]);
    expect((await complete(enough.applicationId)).status).toBe(201);
  });

  it('counts a cheque only once it is checked; the borrower rule needs no guarantor', async () => {
    // The keys stay as the previous test set them (1 cheque; 11000 bps).
    const { patient, applicationId } = await steps.approved();
    const ids: string[] = [];
    await steps.ready(patient, applicationId, {
      items: chequeItems(1),
      papers: papers(
        [{ issuer: { role: 'borrower' }, amountRial: 5_000_000n, checked: false }],
        ids,
      ),
    });
    // Received, not checked: the delivery is not verified and the cheque does not count.
    expect((await status(applicationId))['missing']).toEqual(['delivery', 'cheque:borrower']);
    const id = ids[0] ?? '';
    expect((await w.staff(w.completion, 'POST', `/instruments/${id}/sayad`)).status).toBe(201);
    expect((await w.staff(w.completion, 'POST', `/instruments/${id}/verify`)).status).toBe(201);
    const { rows } = await h.owner.query<Row>(
      'SELECT delivery_id::text AS d FROM instruments WHERE id = $1',
      [id],
    );
    await w.staff(w.completion, 'POST', `/deliveries/${rows[0]?.['d'] as string}/check`);
    expect((await status(applicationId))['missing']).toEqual([]);
    expect((await complete(applicationId)).status).toBe(201);
  });

  it('two borrower cheques when two are asked; never a deleted, released or other kind', async () => {
    await setKey('instrument.borrower_cheque_min_count', 2);
    const { patient, applicationId } = await steps.approved();
    await steps.ready(patient, applicationId, {
      items: chequeItems(1),
      papers: papers([{ issuer: { role: 'borrower' }, amountRial: 5_000_000n }], []),
    });
    expect((await status(applicationId))['missing']).toEqual(['cheque:borrower']);

    // Rows the API never writes (the guard keeps a registered row's kind and deletion), put
    // in by the owner to show what does not count: a deleted cheque, a released one, a note.
    const insert = (kind: string, state: string, deleted: boolean) =>
      h.owner.query(
        `INSERT INTO instruments (credit_application_id, kind, issuer_person_id, role, amount_rial,
           number_enc, number_bidx, number_last4, status, created_by, deleted_at,
           sayad_registered_confirmed, sayad_confirmed_at)
         SELECT a.id, $2, a.borrower_person_id, 'borrower', 5000000, 'v1.x', $3, '0000', $4,
           a.borrower_person_id, CASE WHEN $5 THEN now() END,
           $2 = 'cheque', CASE WHEN $2 = 'cheque' THEN now() END
         FROM credit_applications a WHERE a.id = $1`,
        [applicationId, kind, `v1.test-${String(randomInt(10 ** 12))}`, state, deleted],
      );
    await insert('cheque', 'verified', true);
    await insert('cheque', 'released', false);
    await insert('promissory_note', 'verified', false);
    expect((await status(applicationId))['missing']).toEqual(['cheque:borrower']);
    // A second checked cheque of its own: enough.
    await insert('cheque', 'held', false);
    expect((await status(applicationId))['missing']).toEqual([]);
  });
});

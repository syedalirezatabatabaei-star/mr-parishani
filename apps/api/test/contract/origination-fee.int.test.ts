import { randomInt } from 'node:crypto';
import { gregorianDayOf, toJalali } from '@sepehr/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startHarness, type Harness, type loggedInAccount } from '../identity/harness';
import { fundingSteps } from '../credit/funding-steps';
import { LEAD_CASES, type LeadCases } from '../../src/common/lead/lead-cases.port';
import { CREDIT_HARNESS, creditWorld, PDF, PLAN, type Body, type Row } from '../credit/world';

/**
 * ADR-048 (ج۱; owner 1405/07/30, answers 2, 3 and 5; plans approved): the origination fee as a
 * share of the whole proforma; 2% of it waived with five checked cheques of the borrower; up to
 * 1% discounted by an officer under their signature, with no second person; never below 0; a
 * six-month plan has only the discount. What is owed is locked with its receipt (or at completion
 * when nothing is left): later cheques change nothing. The customer club: a recorded membership,
 * locked on the application. No ledger row of its own: the receipt posts the net, as before.
 */

type Staff = Awaited<ReturnType<typeof loggedInAccount>>;

let h: Harness;
let w: Awaited<ReturnType<typeof creditWorld>>;
let steps: ReturnType<typeof fundingSteps>;
let finance: Staff;
let clubOfficer: Staff;

/** The annex's plan: 3% of the proforma; 2% off with 5 cheques; up to 1% by an officer. */
const ANNEX = {
  ...PLAN,
  code: 'annex_12',
  title: 'طرح الحاقیه',
  originationFee: { basis: 'percent', bps: 300, base: 'proforma' },
  originationChequeWaiver: { minCheques: 5, bps: 200 },
  originationOfficerDiscountBps: 100,
} as const;
/** A six-month plan: the discount only (the annex's note 1). */
const SIX = {
  ...PLAN,
  code: 'annex_6',
  title: 'طرح شش‌ماهه',
  originationFee: { basis: 'percent', bps: 300, base: 'proforma' },
  originationOfficerDiscountBps: 100,
} as const;
/** The club's plan, offered to a member only. */
const CLUB = { ...ANNEX, code: 'club_12', title: 'طرح باشگاه', requiresClubMembership: true };

beforeAll(async () => {
  h = await startHarness(CREDIT_HARNESS);
  w = await creditWorld(h);
  const manager = await w.role('credit_manager');
  finance = await w.role('accounting');
  steps = fundingSteps(h, w, { manager, finance });
  clubOfficer = await w.role('club_officer');
  const [a, b] = [await w.role('strategy_manager'), await w.role('strategy_manager')];
  const proposal = await w.staff(a, 'POST', '/config/proposals', {
    key: 'credit.plans',
    scope: { level: 'global' },
    value: { plans: [PLAN, ANNEX, SIX, CLUB] },
    reason: 'طرح‌های الحاقیه، آزمون',
  });
  expect(proposal.status, JSON.stringify(proposal.body)).toBe(201);
  expect(
    (await w.staff(b, 'POST', `/config/proposals/${proposal.body['id'] as string}/approve`)).status,
  ).toBe(200);
}, 180_000);

afterAll(async () => {
  await h.close();
});

const status = async (applicationId: string) =>
  (await w.staff(w.completion, 'GET', `/completion/${applicationId}`)).body;
const complete = (applicationId: string) =>
  w.staff(w.completion, 'POST', `/completion/${applicationId}/complete`);

async function grant(who: Staff, applicationId: string, discountBps: string, file = true) {
  const form = new FormData();
  form.append('discountBps', discountBps);
  form.append('reason', 'تخفیف مسئول تکمیل، با امضا');
  if (file) form.append('file', new Blob([new Uint8Array(PDF)]), 'signed.pdf');
  const res = await fetch(`${h.baseUrl}/completion/${applicationId}/origination-discount`, {
    method: 'POST',
    headers: { authorization: `Bearer ${who.access}` },
    body: form,
  });
  return { status: res.status, body: (await res.json()) as Body };
}

/** `n` cheques of the borrower, each on its own item, all checked. */
const borrowerCheques = (n: number) => ({
  items: Array.from({ length: n }, (_, i) => ({ kind: 'cheque', label: `چک ${String(i + 1)}` })),
  papers: async (deliveryId: string, items: readonly Body[]) => {
    const slots = items.filter((i) => i['kind'] === 'cheque');
    for (let i = 0; i < n; i++) {
      const made = await w.staff(w.completion, 'POST', `/deliveries/${deliveryId}/instruments`, {
        itemId: slots[i]?.['id'],
        kind: 'cheque',
        issuer: { role: 'borrower' },
        amountRial: '2000000',
        dueOn: '2026-12-01',
        number: `6037${String(randomInt(10 ** 11, 10 ** 12))}`,
      });
      expect(made.status, JSON.stringify(made.body)).toBe(201);
      const id = made.body['id'] as string;
      expect((await w.staff(w.completion, 'POST', `/instruments/${id}/sayad`)).status).toBe(201);
      expect((await w.staff(w.completion, 'POST', `/instruments/${id}/verify`)).status).toBe(201);
    }
  },
});

/** The origination fee's journal lines of an application. */
async function feeLines(applicationId: string) {
  const { rows } = await h.owner.query<Row>(
    `SELECT a.code, e.direction, e.amount_rial::text AS amount
       FROM journal_entries j JOIN ledger_entries e ON e.journal_entry_id = j.id
       JOIN ledger_accounts a ON a.id = e.account_id
      WHERE j.credit_application_id = $1 AND j.event_type = 'contract.origination_fee_received'
      ORDER BY e.direction DESC`,
    [applicationId],
  );
  return rows;
}

async function lockRows(applicationId: string) {
  const { rows } = await h.owner.query<Row>(
    `SELECT receipt_id IS NOT NULL AS with_receipt, fee_rial::text AS fee, base_rial::text AS base,
            cheque_count, waiver_bps, discount_bps, net_rial::text AS net
       FROM origination_fee_reductions WHERE credit_application_id = $1 ORDER BY created_at`,
    [applicationId],
  );
  return rows;
}

describe('ADR-048: the origination fee', () => {
  it('is 3% of the whole proforma with base proforma; a fixed fee is unchanged', async () => {
    const annex = await steps.approved(ANNEX.code);
    // The world's proforma: 12,000,000 (visit 6,000,000 + two scalings); 3% is 360,000.
    const now = await status(annex.applicationId);
    expect(now['origination']).toMatchObject({
      feeRial: '360000',
      baseRial: '12000000',
      minCheques: 5,
      waiverBps: 0,
      discountBps: 0,
      maxDiscountBps: 100,
      netRial: '360000',
      locked: false,
      discount: null,
    });
    expect(now['owed']).toContainEqual({
      kind: 'origination_fee',
      expectedRial: '360000',
      approved: false,
    });
    const fixed = await steps.approved();
    expect((await status(fixed.applicationId))['origination']).toMatchObject({
      feeRial: '500000',
      netRial: '500000',
      maxDiscountBps: 0,
      minCheques: null,
    });
    // A fixed fee takes no discount.
    expect((await grant(w.completion, fixed.applicationId, '100')).body).toMatchObject({
      error: 'discount_not_in_plan',
    });
  });

  it('waives 2% from the fifth checked cheque, locked with the receipt; later cheques change nothing', async () => {
    const four = await steps.approved(ANNEX.code);
    const fourCheques = borrowerCheques(4);
    await steps.ready(four.patient, four.applicationId, {
      items: fourCheques.items,
      papers: async (deliveryId, items) => {
        await fourCheques.papers(deliveryId, items);
        // A guarantor's checked cheque (put in by the owner): never the borrower's fifth.
        await h.owner.query(
          `INSERT INTO instruments (credit_application_id, kind, issuer_person_id, role, guarantor_id,
             amount_rial, number_enc, number_bidx, number_last4, status, created_by,
             sayad_registered_confirmed, sayad_confirmed_at)
           SELECT a.id, 'cheque', a.borrower_person_id, 'guarantor', uuidv7(), 2000000, 'v1.x', $2,
             '0000', 'verified', a.borrower_person_id, true, now()
           FROM credit_applications a WHERE a.id = $1`,
          [four.applicationId, `v1.test-${String(randomInt(10 ** 12))}`],
        );
      },
    });
    expect((await status(four.applicationId))['origination']).toMatchObject({
      chequeCount: 4,
      waiverBps: 0,
      netRial: '360000',
      locked: true,
    });
    expect(await feeLines(four.applicationId)).toEqual([
      { code: 'bank.collection', direction: 'debit', amount: '360000' },
      { code: 'company.fee_income', direction: 'credit', amount: '360000' },
    ]);
    // A fifth checked cheque after the lock: nothing changes (owner: a later cheque, bounced or
    // new, does not touch it).
    await h.owner.query(
      `INSERT INTO instruments (credit_application_id, kind, issuer_person_id, role, amount_rial,
         number_enc, number_bidx, number_last4, status, created_by,
         sayad_registered_confirmed, sayad_confirmed_at)
       SELECT a.id, 'cheque', a.borrower_person_id, 'borrower', 2000000, 'v1.x', $2, '0000',
         'verified', a.borrower_person_id, true, now()
       FROM credit_applications a WHERE a.id = $1`,
      [four.applicationId, `v1.test-${String(randomInt(10 ** 12))}`],
    );
    expect((await status(four.applicationId))['origination']).toMatchObject({
      netRial: '360000',
      locked: true,
    });
    // And no discount once locked.
    expect((await grant(w.completion, four.applicationId, '100')).body).toMatchObject({
      error: 'origination_already_locked',
    });

    const five = await steps.approved(ANNEX.code);
    await steps.ready(five.patient, five.applicationId, borrowerCheques(5));
    expect((await status(five.applicationId))['origination']).toMatchObject({
      chequeCount: 5,
      waiverBps: 200,
      netRial: '120000',
      locked: true,
    });
    expect(await feeLines(five.applicationId)).toEqual([
      { code: 'bank.collection', direction: 'debit', amount: '120000' },
      { code: 'company.fee_income', direction: 'credit', amount: '120000' },
    ]);
    expect(await lockRows(five.applicationId)).toEqual([
      {
        with_receipt: true,
        fee: '360000',
        base: '12000000',
        cheque_count: 5,
        waiver_bps: 200,
        discount_bps: 0,
        net: '120000',
      },
    ]);
    expect((await complete(five.applicationId)).status).toBe(201);
  });

  it('adds the discount to the waiver: nothing left to pay, locked at completion, no fee row', async () => {
    const both = await steps.approved(ANNEX.code);
    // Above the plan's 1%: refused. Without the signed file: refused. Not the officer: 403.
    expect((await grant(w.completion, both.applicationId, '101')).body).toMatchObject({
      error: 'discount_not_in_plan',
    });
    expect((await grant(w.completion, both.applicationId, '100', false)).status).toBe(400);
    expect((await grant(finance, both.applicationId, '100')).status).toBe(403);
    const given = await grant(w.completion, both.applicationId, '100');
    expect(given.status, JSON.stringify(given.body)).toBe(201);
    expect(given.body).toMatchObject({ discountBps: 100 });
    expect((await grant(clubOfficer, both.applicationId, '50')).body).toMatchObject({
      error: 'discount_exists',
    });
    // The patient sees the amounts, never who granted it.
    const mine = await w.as(both.patient, 'GET', `/me/completion/${both.applicationId}`);
    expect(mine.body['origination']).toMatchObject({ discountBps: 100, discount: null });

    await steps.ready(both.patient, both.applicationId, borrowerCheques(5));
    const now = await status(both.applicationId);
    expect(now['origination']).toMatchObject({
      waiverBps: 200,
      discountBps: 100,
      netRial: '0',
      locked: false,
    });
    expect((now['owed'] as Body[]).map((o) => o['kind'])).not.toContain('origination_fee');
    expect((await complete(both.applicationId)).status).toBe(201);
    expect(await lockRows(both.applicationId)).toEqual([
      {
        with_receipt: false,
        fee: '360000',
        base: '12000000',
        cheque_count: 5,
        waiver_bps: 200,
        discount_bps: 100,
        net: '0',
      },
    ]);
    expect(await feeLines(both.applicationId)).toEqual([]);
    expect((await status(both.applicationId))['origination']).toMatchObject({ locked: true });

    // The month's list (accounting), with the discount's own part: 120,000.
    const today = toJalali(new Date());
    const month = `${String(today.year)}-${String(today.month).padStart(2, '0')}`;
    const list = await w.staff(finance, 'GET', `/origination-discounts?month=${month}`);
    expect(list.status).toBe(200);
    const row = (list.body as unknown as Body[]).find(
      (r) => r['creditApplicationId'] === both.applicationId,
    );
    expect(row).toMatchObject({ discountBps: 100, reductionRial: '120000' });
    expect(
      (await w.staff(w.completion, 'GET', `/origination-discounts?month=${month}`)).status,
    ).toBe(403);
  });

  it('the club officer finds the case by mobile and grants from there (owner 1405/08/02, plan ب)', async () => {
    const a = await steps.approved(ANNEX.code);
    const find = (who: Staff, mobile: string) =>
      w.staff(who, 'GET', `/origination-discounts/candidates?mobile=${encodeURIComponent(mobile)}`);
    // Only an officer who may grant; a mobile as typed, in any digits.
    expect((await find(finance, a.patient.mobile)).status).toBe(403);
    expect((await find(clubOfficer, '12345')).status).toBe(400);
    expect((await find(clubOfficer, '9120000000')).body).toEqual([]);
    const persian = `0${a.patient.mobile}`.replace(/[0-9]/g, (d) =>
      String.fromCharCode(0x06f0 + Number(d)),
    );
    const found = await find(clubOfficer, persian);
    expect(found.status).toBe(200);
    const row = (found.body as unknown as Body[]).find(
      (r) => r['creditApplicationId'] === a.applicationId,
    );
    // Only what the discount needs: no name, score, reason or treatment.
    expect(Object.keys(row ?? {}).sort()).toEqual([
      'creditApplicationId',
      'origination',
      'planTitle',
    ]);
    expect(row).toMatchObject({
      planTitle: 'طرح الحاقیه',
      origination: { maxDiscountBps: 100, discountBps: 0, locked: false, discount: null },
    });
    expect((await grant(clubOfficer, a.applicationId, '100')).status).toBe(201);
    const after = (await find(clubOfficer, a.patient.mobile)).body as unknown as Body[];
    expect(after.find((r) => r['creditApplicationId'] === a.applicationId)).toMatchObject({
      origination: { maxDiscountBps: 0, discountBps: 100 },
    });
  });

  it('gives a six-month plan only the discount: 3% to 2%, whatever the cheques', async () => {
    const six = await steps.approved(SIX.code);
    expect((await grant(clubOfficer, six.applicationId, '100')).status).toBe(201);
    await steps.ready(six.patient, six.applicationId, borrowerCheques(5));
    expect((await status(six.applicationId))['origination']).toMatchObject({
      minCheques: null,
      waiverBps: 0,
      discountBps: 100,
      netRial: '240000',
      locked: true,
    });
    expect(await feeLines(six.applicationId)).toEqual([
      { code: 'bank.collection', direction: 'debit', amount: '240000' },
      { code: 'company.fee_income', direction: 'credit', amount: '240000' },
    ]);
  });

  it('keeps its rows append-only, even for the owner', async () => {
    await expect(
      h.owner.query('UPDATE origination_fee_reductions SET net_rial = net_rial'),
    ).rejects.toThrow(/append-only/);
    await expect(h.owner.query('DELETE FROM origination_discounts')).rejects.toThrow(/append-only/);
    await expect(h.owner.query('TRUNCATE club_memberships CASCADE')).rejects.toThrow(/append-only/);
  });
});

describe('ADR-048: the customer club', () => {
  it('offers the club plan to a recorded member only, and locks the membership on the case', async () => {
    const outsider = await w.confirmedProforma();
    const plansOf = async (patient: typeof outsider.patient, proformaId: string) =>
      (
        (await w.as(patient, 'GET', `/me/proformas/${proformaId}/plans`)).body['plans'] as Body[]
      ).map((p) => p['code']);
    expect(await plansOf(outsider.patient, outsider.proformaId)).not.toContain(CLUB.code);
    const refused = await w.as(outsider.patient, 'POST', '/me/credit-applications', {
      proformaId: outsider.proformaId,
      planCode: CLUB.code,
      installmentCount: 12,
    });
    expect(refused.body).toMatchObject({ error: 'plan_not_offered' });

    // Only the club officer records a membership; by the member's mobile, in any form.
    const today = gregorianDayOf(toJalali(new Date()));
    const record = (who: Staff) =>
      w.staff(who, 'POST', '/lead/club-memberships', {
        mobile: `0${outsider.patient.mobile}`,
        startsOn: today,
        reason: 'عضو باشگاه مشتریان',
      });
    expect((await record(w.completion)).status).toBe(403);
    const made = await record(clubOfficer);
    expect(made.status, JSON.stringify(made.body)).toBe(201);
    expect(made.body).toMatchObject({ startsOn: today, endsOn: null, activeToday: true });

    expect(await plansOf(outsider.patient, outsider.proformaId)).toContain(CLUB.code);
    const app = await w.as(outsider.patient, 'POST', '/me/credit-applications', {
      proformaId: outsider.proformaId,
      planCode: CLUB.code,
      installmentCount: 12,
    });
    expect(app.status, JSON.stringify(app.body)).toBe(201);
    const locked = async (id: string) =>
      (
        await h.owner.query<Row>(
          'SELECT club_membership_id::text AS m FROM credit_applications WHERE id = $1',
          [id],
        )
      ).rows[0]?.['m'];
    expect(await locked(app.body['id'] as string)).toBe(made.body['id']);

    // Revoked from today: the case keeps it, a new one is not offered the plan.
    const revoked = await w.staff(
      clubOfficer,
      'POST',
      `/lead/club-memberships/${made.body['id'] as string}/revoke`,
      { revokedOn: today, reason: 'لغو عضویت' },
    );
    expect(revoked.status, JSON.stringify(revoked.body)).toBe(200);
    expect(revoked.body).toMatchObject({ activeToday: false });
    expect(
      (
        await w.staff(
          clubOfficer,
          'POST',
          `/lead/club-memberships/${made.body['id'] as string}/revoke`,
          { revokedOn: today, reason: 'لغو دوباره' },
        )
      ).body,
    ).toMatchObject({ error: 'already_revoked' });
    expect(await locked(app.body['id'] as string)).toBe(made.body['id']);
    const again = await w.confirmedProforma(outsider.patient);
    expect(await plansOf(outsider.patient, again.proformaId)).not.toContain(CLUB.code);

    // The officer's list, by mobile.
    const list = await w.staff(
      clubOfficer,
      'GET',
      `/lead/club-memberships?mobile=0${outsider.patient.mobile}`,
    );
    expect(list.status).toBe(200);
    expect(list.body as unknown as Body[]).toHaveLength(1);
    await expect(h.owner.query('UPDATE club_memberships SET reason = reason')).rejects.toThrow(
      /append-only/,
    );
    await expect(h.owner.query('DELETE FROM club_membership_revocations')).rejects.toThrow(
      /append-only/,
    );
  });

  it('checks the membership again in the transaction: revoked meanwhile, refused', async () => {
    const member = await w.confirmedProforma();
    const today = gregorianDayOf(toJalali(new Date()));
    expect(
      (
        await w.staff(clubOfficer, 'POST', '/lead/club-memberships', {
          mobile: member.patient.mobile,
          startsOn: today,
          reason: 'عضو باشگاه، آزمون هم‌زمانی',
        })
      ).status,
    ).toBe(201);
    // The plan is offered (read without a transaction); the insert's own read, in its
    // transaction, sees the membership gone, as if revoked between the two.
    const leads = h.app.get<LeadCases>(LEAD_CASES);
    const real = leads.clubMembershipAt.bind(leads);
    leads.clubMembershipAt = (personId, day, tx) =>
      tx === undefined ? real(personId, day) : Promise.resolve(null);
    try {
      const made = await w.as(member.patient, 'POST', '/me/credit-applications', {
        proformaId: member.proformaId,
        planCode: CLUB.code,
        installmentCount: 12,
      });
      expect(made.status).toBe(409);
      expect(made.body).toMatchObject({ error: 'club_membership_required' });
    } finally {
      leads.clubMembershipAt = real;
    }
  });

  it('refuses a membership whose last day is before its first, or an unknown mobile', async () => {
    const p = await w.patient();
    expect(
      (
        await w.staff(clubOfficer, 'POST', '/lead/club-memberships', {
          mobile: p.mobile,
          startsOn: '2026-10-10',
          endsOn: '2026-10-09',
          reason: 'بازه نادرست',
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await w.staff(clubOfficer, 'POST', '/lead/club-memberships', {
          mobile: '9129999999',
          startsOn: '2026-10-10',
          reason: 'شماره ناشناس',
        })
      ).body,
    ).toMatchObject({ error: 'person_not_found' });
  });
});

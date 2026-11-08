import {
  fromJalali,
  nextJalaliDay,
  toJalali,
  type CreditPlan,
  type JalaliDate,
} from '@sepehr/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CreditApplicationSweeper } from '../../src/modules/credit/credit-application-sweeper';
import { examineAppointment } from '../booking/examine';
import { councilNumber, nationalId, sheba } from '../catalog/fixtures';
import { BASE_DOCUMENTS, CREDIT_HARNESS, PDF } from './world';
import {
  call,
  grantRole,
  loggedInAccount,
  newIp,
  newMobile,
  otpLogin,
  startHarness,
  type Harness,
  type LoggedInAccount,
} from '../identity/harness';

/**
 * Task 3-5 part A (doc 10 §4): the credit application on a confirmed proforma, its plan
 * locked to the configuration of the day, another person as borrower, submission, the
 * move to credit review and its deadline (doc 10 §10 test 14), and expiry.
 */

let h: Harness;
let specialist: LoggedInAccount;
let networkManager: LoggedInAccount;
let approver: LoggedInAccount;
let strategyA: LoggedInAccount;
let strategyB: LoggedInAccount;
let completion: LoggedInAccount;

type Body = Record<string, unknown>;
type Row = Record<string, unknown>;
const reason = { reason: 'آزمون پرونده اعتباری' };
const staff = (who: LoggedInAccount, method: string, path: string, body?: unknown) =>
  call(h, method, path, { bearer: who.access, ...(body === undefined ? {} : { body }) });

interface Patient {
  id: string;
  mobile: string;
  token: string;
}
async function patient(mobile = newMobile()): Promise<Patient> {
  const login = await otpLogin(h, mobile, 'mobile', { ip: newIp() });
  expect(login.status).toBe(200);
  const { rows } = await h.owner.query<Row>('SELECT id FROM user_accounts WHERE mobile = $1', [
    mobile,
  ]);
  return { id: rows[0]?.['id'] as string, mobile, token: login.body['accessToken'] as string };
}
const as = (p: Patient, method: string, path: string, body?: unknown) =>
  call(h, method, path, { bearer: p.token, ...(body === undefined ? {} : { body }) });

function dayAhead(days: number): JalaliDate {
  let date = toJalali(new Date());
  for (let i = 0; i < days; i++) date = nextJalaliDay(date);
  return date;
}

const plan: CreditPlan = {
  code: 'dental_12',
  title: 'طرح دندانپزشکی',
  active: true,
  cityCode: 'tehran',
  treatmentFieldCodes: ['dental'],
  doctorIds: null,
  minAmountRial: '1000000',
  maxAmountRial: '500000000',
  downPayment: { basis: 'percent', bps: 2000 },
  installmentCounts: [6, 12],
  planFee: { basis: 'percent', bps: 1000, timing: 'spread' },
  originationFee: { basis: 'fixed', rial: '500000' },
  // ADR-035: a plan added from now on rounds its shares to whole tomans.
  percentRoundingRial: '10',
};

let workplaceId = '';
let doctor: LoggedInAccount;
let centerManager: LoggedInAccount;
let day: JalaliDate;
let slot = 0;

/** A patient books, the doctor issues 6,000,000 + 2 × 3,000,000 and the patient confirms. */
async function confirmedProforma(p?: Patient) {
  const who = p ?? (await patient());
  const n = slot++;
  const held = await as(who, 'POST', '/booking/appointments/hold', {
    workplaceId,
    serviceCode: 'visit',
    startsAt: fromJalali(day, { hour: 8 + Math.floor(n / 2), minute: (n % 2) * 30 }).toISOString(),
  });
  expect(held.status).toBe(201);
  expect(
    (await as(who, 'POST', `/booking/appointments/${held.body['id'] as string}/request`)).status,
  ).toBe(201);
  // A proforma is issued only after the examination (owner 1405/07/23).
  await examineAppointment(h, centerManager, who.token, held.body['id'] as string);
  const made = await staff(doctor, 'POST', '/proformas', {
    appointmentId: held.body['id'],
    lines: [
      { serviceCode: 'visit', quantity: 1, unitRial: '6000000' },
      { serviceCode: 'scaling', quantity: 2 },
    ],
  });
  expect(made.status).toBe(201);
  const id = made.body['id'] as string;
  expect((await staff(doctor, 'POST', `/proformas/${id}/issue`)).status).toBe(201);
  return { patient: who, proformaId: id };
}

async function confirm(p: Patient, proformaId: string) {
  expect((await as(p, 'POST', `/me/proformas/${proformaId}/confirm`)).status).toBe(201);
}

beforeAll(async () => {
  h = await startHarness(CREDIT_HARNESS);
  [specialist, networkManager, approver, strategyA, strategyB, completion] = await Promise.all([
    loggedInAccount(h, 'staff'),
    loggedInAccount(h, 'staff'),
    loggedInAccount(h, 'staff'),
    loggedInAccount(h, 'staff'),
    loggedInAccount(h, 'staff'),
    loggedInAccount(h, 'staff'),
  ]);
  await grantRole(h, specialist.id, 'network_specialist', { kind: 'city', code: 'tehran' });
  await grantRole(h, networkManager.id, 'network_manager');
  await grantRole(h, approver.id, 'network_manager');
  await grantRole(h, strategyA.id, 'strategy_manager');
  await grantRole(h, strategyB.id, 'strategy_manager');
  await grantRole(h, completion.id, 'case_completion');
  await staff(networkManager, 'POST', '/catalog/fields', {
    code: 'dental',
    name: 'دندانپزشکی',
    ...reason,
  });
  await staff(networkManager, 'POST', '/catalog/services', {
    fieldCode: 'dental',
    code: 'scaling',
    name: 'جرم‌گیری',
    ...reason,
  });

  // An active center in Tehran, its doctor with an account, prices and hours.
  day = dayAhead(5);
  const created = await staff(specialist, 'POST', '/catalog/centers', {
    // Owner 1405/07/27: the registration form requires the contract term.
    contractTerm: { startsOn: '2026-10-01', months: 12 },
    personType: 'natural',
    identifier: nationalId(),
    name: 'کلینیک اعتبار',
    cityCode: 'tehran',
    sheba: sheba(),
    accountHolderName: 'صاحب حساب',
    treatmentFieldCodes: ['dental'],
  });
  const centerId = created.body['id'] as string;
  const setAll = async (status: string) => {
    const detail = await staff(specialist, 'GET', `/catalog/centers/${centerId}`);
    for (const doc of detail.body['documents'] as { code: string }[]) {
      await staff(specialist, 'PUT', `/catalog/centers/${centerId}/documents/${doc.code}`, {
        status,
      });
    }
  };
  await setAll('received');
  await staff(specialist, 'POST', `/catalog/centers/${centerId}/submit`, reason);
  await setAll('verified');
  const proposed = await staff(
    specialist,
    'POST',
    `/catalog/centers/${centerId}/activation-requests`,
    reason,
  );
  await staff(approver, 'POST', `/catalog/requests/${proposed.body['id'] as string}/approve`, {});
  const detail = await staff(specialist, 'GET', `/catalog/centers/${centerId}`);
  const [branch] = detail.body['branches'] as { id: string }[];
  const manager = await loggedInAccount(h, 'center');
  centerManager = manager;
  await grantRole(h, manager.id, 'center_manager', {
    kind: 'center',
    nodeId: created.body['nodeId'] as string,
  });
  const doc = await staff(specialist, 'POST', '/catalog/doctors', {
    // Owner 1405/07/27: the registration form requires the contract term.
    contractTerm: { startsOn: '2026-10-01', months: 12 },
    name: 'دکتر اعتبار',
    medicalCouncilNumber: councilNumber(),
    treatmentFieldCodes: ['dental'],
    workplace: { kind: 'branch', branchId: branch?.id },
    ...reason,
  });
  doctor = await loggedInAccount(h, 'center');
  await staff(specialist, 'POST', `/catalog/doctors/${doc.body['id'] as string}/account`, {
    accountId: doctor.id,
    ...reason,
  });
  const doctorDetail = await staff(
    specialist,
    'GET',
    `/catalog/doctors/${doc.body['id'] as string}`,
  );
  workplaceId = (doctorDetail.body['workplaces'] as { id: string }[])[0]?.id ?? '';
  for (const [serviceCode, min, max] of [
    ['visit', '5000000', '8000000'],
    ['scaling', '3000000', '3000000'],
  ] as const) {
    const priced = await staff(manager, 'POST', '/catalog/tariffs', {
      owner: { kind: 'workplace', workplaceId },
      serviceCode,
      pricing: { kind: 'range', minRial: min, maxRial: max },
      ...reason,
    });
    expect(priced.status).toBe(201);
  }
  await staff(manager, 'POST', `/booking/workplaces/${workplaceId}/exceptions`, {
    kind: 'extra',
    on: day,
    start: '08:00',
    end: '20:00',
    slotMinutes: 30,
    serviceCodes: ['visit'],
    ...reason,
  });

  // The strategy manager defines the plan; a second one approves.
  const proposal = await staff(strategyA, 'POST', '/config/proposals', {
    key: 'credit.plans',
    scope: { level: 'global' },
    value: { plans: [plan] },
    reason: 'طرح آزمون',
  });
  expect(proposal.status).toBe(201);
  expect(
    (await staff(strategyB, 'POST', `/config/proposals/${proposal.body['id'] as string}/approve`))
      .status,
  ).toBe(200);
});

afterAll(async () => {
  await h.close();
});

describe('choosing a plan (doc 10 §3)', () => {
  it('only on the patient’s own confirmed proforma; previews for each offered count', async () => {
    const { patient: p, proformaId } = await confirmedProforma();
    const early = await as(p, 'POST', '/me/credit-applications', {
      proformaId,
      planCode: 'dental_12',
      installmentCount: 12,
    });
    expect(early.status).toBe(409);
    expect(early.body['error']).toBe('proforma_not_confirmed');
    await confirm(p, proformaId);
    expect((await as(await patient(), 'GET', `/me/proformas/${proformaId}/plans`)).status).toBe(
      404,
    );

    const options = await as(p, 'GET', `/me/proformas/${proformaId}/plans`);
    expect(options.status).toBe(200);
    expect(options.body['totalRial']).toBe('12000000');
    const [only] = options.body['plans'] as Body[];
    const counts = (only?.['options'] as Body[]).map((o) => o['installmentCount']);
    expect(counts).toEqual([6, 12]);
    const twelve = (only?.['options'] as { quote: Body }[])[1]?.quote;
    expect(twelve).toMatchObject({
      downPaymentRial: '2400000',
      loanRial: '9600000',
      planFeeRial: '960000',
      totalObligationRial: '10560000',
    });
  });

  it('locks the plan and its preview; one open application per proforma', async () => {
    const { patient: p, proformaId } = await confirmedProforma();
    await confirm(p, proformaId);
    const notOffered = await as(p, 'POST', '/me/credit-applications', {
      proformaId,
      planCode: 'other',
      installmentCount: 12,
    });
    expect(notOffered.status).toBe(409);
    expect(notOffered.body['error']).toBe('plan_not_offered');
    const badCount = await as(p, 'POST', '/me/credit-applications', {
      proformaId,
      planCode: 'dental_12',
      installmentCount: 9,
    });
    expect(badCount.status).toBe(400);
    expect(badCount.body['error']).toBe('installment_count_not_in_plan');

    const made = await as(p, 'POST', '/me/credit-applications', {
      proformaId,
      planCode: 'dental_12',
      installmentCount: 12,
    });
    expect(made.status).toBe(201);
    expect(made.body).toMatchObject({
      status: 'draft',
      borrowerIsPatient: true,
      planTitle: 'طرح دندانپزشکی',
      proformaTotalRial: '12000000',
      downPaymentRial: '2400000',
      loanRial: '9600000',
      totalObligationRial: '10560000',
    });
    const again = await as(p, 'POST', '/me/credit-applications', {
      proformaId,
      planCode: 'dental_12',
      installmentCount: 6,
    });
    expect(again.status).toBe(409);
    expect(again.body['error']).toBe('application_exists');
    const { rows } = await h.owner.query<Row>(
      'SELECT plans_version_id, rounding_version_id, reduction_version_id FROM credit_applications WHERE id = $1',
      [made.body['id']],
    );
    expect(Object.values(rows[0] ?? {}).every((v) => typeof v === 'string')).toBe(true);
    await expect(
      h.owner.query('UPDATE credit_applications SET loan_rial = 1 WHERE id = $1', [
        made.body['id'],
      ]),
    ).rejects.toThrow(/only change its state/);
  });
});

describe('another borrower (doc 01: Borrower ≠ Patient)', () => {
  it('is a person by mobile; they see the application once they log in, a stranger does not', async () => {
    const { patient: p, proformaId } = await confirmedProforma();
    await confirm(p, proformaId);
    const borrowerMobile = newMobile();
    const made = await as(p, 'POST', '/me/credit-applications', {
      proformaId,
      planCode: 'dental_12',
      installmentCount: 6,
      borrowerMobile: `0${borrowerMobile}`,
    });
    expect(made.status).toBe(201);
    expect(made.body['borrowerIsPatient']).toBe(false);
    const borrower = await patient(borrowerMobile);
    const theirs = await as(borrower, 'GET', '/me/credit-applications');
    expect((theirs.body as unknown as Body[]).map((a) => a['id'])).toContain(made.body['id']);
    expect(
      (await as(await patient(), 'GET', `/me/credit-applications/${made.body['id'] as string}`))
        .status,
    ).toBe(404);
    // The borrower may submit it too.
    expect(
      (await as(borrower, 'POST', `/me/credit-applications/${made.body['id'] as string}/submit`))
        .status,
    ).toBe(201);
  });
});

describe('to credit review and its deadline (doc 10 §4; §10 test 14)', () => {
  it('submitted, sent to review by case completion, and announced once when late', async () => {
    const { patient: p, proformaId } = await confirmedProforma();
    await confirm(p, proformaId);
    const made = await as(p, 'POST', '/me/credit-applications', {
      proformaId,
      planCode: 'dental_12',
      installmentCount: 12,
    });
    const id = made.body['id'] as string;
    const submitted = await as(p, 'POST', `/me/credit-applications/${id}/submit`);
    expect(submitted.body['status']).toBe('incomplete');
    expect(submitted.body['submittedAt']).not.toBeNull();
    expect((await as(p, 'POST', `/me/credit-applications/${id}/submit`)).status).toBe(409);

    expect(
      (await staff(doctor, 'POST', `/credit/applications/${id}/ready-for-review`)).status,
    ).toBe(403);
    // Part C: not before the borrower's consent and accepted documents.
    const early = await staff(completion, 'POST', `/credit/applications/${id}/ready-for-review`);
    expect(early.status).toBe(409);
    expect(early.body['error']).toBe('not_complete');
    await as(p, 'POST', `/me/credit-applications/${id}/consent/request`, { role: 'borrower' });
    const consented = await as(p, 'POST', `/me/credit-applications/${id}/consent`, {
      role: 'borrower',
      code: h.sms.lastCodeFor(p.mobile),
    });
    expect(consented.status).toBe(201);
    for (const itemCode of BASE_DOCUMENTS) {
      const form = new FormData();
      form.append('role', 'borrower');
      form.append('itemCode', itemCode);
      form.append('file', new Blob([new Uint8Array(PDF)]), 'document.pdf');
      const sent = await fetch(`${h.baseUrl}/me/credit-applications/${id}/documents`, {
        method: 'POST',
        headers: { authorization: `Bearer ${p.token}`, 'x-forwarded-for': newIp() },
        body: form,
      });
      expect(sent.status).toBe(201);
      const doc = (await sent.json()) as Body;
      await staff(
        completion,
        'POST',
        `/credit/applications/${id}/documents/${doc['id'] as string}/decision`,
        {
          decision: 'accept',
        },
      );
    }
    const ready = await staff(completion, 'POST', `/credit/applications/${id}/ready-for-review`);
    expect(ready.status).toBe(201);
    expect(ready.body['status']).toBe('ready_for_review');
    const hours = (Date.parse(ready.body['slaDueAt'] as string) - Date.now()) / 3_600_000;
    expect(hours).toBeGreaterThan(23.9);
    expect(hours).toBeLessThanOrEqual(24);

    const sweeper = h.app.get(CreditApplicationSweeper);
    const later = new Date(Date.now() + 25 * 3_600_000);
    expect((await sweeper.run(later)).slaBreached).toBeGreaterThanOrEqual(1);
    const { rows } = await h.owner.query<Row>(
      `SELECT count(*)::int AS n FROM outbox_events WHERE event_type = 'credit.sla_breached' AND aggregate_id = $1`,
      [id],
    );
    expect(rows[0]?.['n']).toBe(1);
    expect((await sweeper.run(later)).slaBreached).toBe(0);
  });

  it('a draft left too long expires, and its proforma takes a new application', async () => {
    const { patient: p, proformaId } = await confirmedProforma();
    await confirm(p, proformaId);
    const made = await as(p, 'POST', '/me/credit-applications', {
      proformaId,
      planCode: 'dental_12',
      installmentCount: 12,
    });
    const result = await h.app
      .get(CreditApplicationSweeper)
      .run(new Date(Date.now() + 31 * 86_400_000));
    expect(result.expired).toBeGreaterThanOrEqual(1);
    const after = await as(p, 'GET', `/me/credit-applications/${made.body['id'] as string}`);
    expect(after.body['status']).toBe('expired');
    expect(
      (
        await as(p, 'POST', '/me/credit-applications', {
          proformaId,
          planCode: 'dental_12',
          installmentCount: 6,
        })
      ).status,
    ).toBe(201);
  });
});

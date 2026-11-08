import {
  fromJalali,
  nextJalaliDay,
  toJalali,
  type CreditPlan,
  type JalaliDate,
} from '@sepehr/contracts';
import { expect } from 'vitest';
import { examineAppointment } from '../booking/examine';
import { councilNumber, nationalId, sheba } from '../catalog/fixtures';
import {
  call,
  grantRole,
  loggedInAccount,
  newIp,
  newMobile,
  otpLogin,
  type Harness,
  type LoggedInAccount,
} from '../identity/harness';

/**
 * A credit world for the credit tests (task 3-5): an active center in Tehran, a doctor with
 * an account, prices, a day of hours, an approved plan, and helpers that take a patient
 * from booking to a credit application in review.
 */

export type Body = Record<string, unknown>;
export type Row = Record<string, unknown>;

export interface Patient {
  id: string;
  mobile: string;
  token: string;
}

export const PLAN: CreditPlan = {
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

/** The required items of the starting checklist (migration 0026) asked of every job. */
export const BASE_DOCUMENTS = ['national_card', 'job_proof', 'bank_statement'] as const;
/** The smallest file whose bytes say PDF. */
export const PDF = Buffer.from('%PDF-1.4\n1 0 obj << >> endobj\ntrailer << >>\n%%EOF\n');

/** The harness the credit world needs: files pass through memory and a fake scanner. */
export const CREDIT_HARNESS = { fakeFiles: true } as const;

export async function creditWorld(h: Harness) {
  const reason = { reason: 'آزمون اعتبار' };
  const staff = (who: LoggedInAccount, method: string, path: string, body?: unknown) =>
    call(h, method, path, { bearer: who.access, ...(body === undefined ? {} : { body }) });
  const as = (p: Patient, method: string, path: string, body?: unknown) =>
    call(h, method, path, { bearer: p.token, ...(body === undefined ? {} : { body }) });
  async function patient(mobile = newMobile()): Promise<Patient> {
    const login = await otpLogin(h, mobile, 'mobile', { ip: newIp() });
    expect(login.status).toBe(200);
    const { rows } = await h.owner.query<Row>('SELECT id FROM user_accounts WHERE mobile = $1', [
      mobile,
    ]);
    return { id: rows[0]?.['id'] as string, mobile, token: login.body['accessToken'] as string };
  }
  const role = async (code: string, scope?: Parameters<typeof grantRole>[3]) => {
    const who = await loggedInAccount(h, 'staff');
    await grantRole(h, who.id, code, scope);
    return who;
  };

  const specialist = await role('network_specialist', { kind: 'city', code: 'tehran' });
  const networkManager = await role('network_manager');
  const approver = await role('network_manager');
  const strategyA = await role('strategy_manager');
  const strategyB = await role('strategy_manager');
  const completion = await role('case_completion');
  const creditSpecialist = await role('credit_specialist');

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

  let day: JalaliDate = toJalali(new Date());
  for (let i = 0; i < 5; i++) day = nextJalaliDay(day);
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
  // A center account: the harness gives it a verified mobile (test data), which linking
  // requires and «patient ready» (task 4-5) is sent to.
  const doctor = await loggedInAccount(h, 'center');
  await staff(specialist, 'POST', `/catalog/doctors/${doc.body['id'] as string}/account`, {
    accountId: doctor.id,
    ...reason,
  });
  const doctorDetail = await staff(
    specialist,
    'GET',
    `/catalog/doctors/${doc.body['id'] as string}`,
  );
  const workplaceId = (doctorDetail.body['workplaces'] as { id: string }[])[0]?.id ?? '';
  for (const [serviceCode, min, max] of [
    ['visit', '5000000', '8000000'],
    ['scaling', '3000000', '3000000'],
  ] as const) {
    await staff(manager, 'POST', '/catalog/tariffs', {
      owner: { kind: 'workplace', workplaceId },
      serviceCode,
      pricing: { kind: 'range', minRial: min, maxRial: max },
      ...reason,
    });
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
  const proposal = await staff(strategyA, 'POST', '/config/proposals', {
    key: 'credit.plans',
    scope: { level: 'global' },
    value: { plans: [PLAN] },
    reason: 'طرح آزمون',
  });
  expect(
    (await staff(strategyB, 'POST', `/config/proposals/${proposal.body['id'] as string}/approve`))
      .status,
  ).toBe(200);

  /** The appointment examined at the center, as a proforma needs (owner 1405/07/23). */
  const examine = (who: Patient, appointmentId: string) =>
    examineAppointment(h, manager, who.token, appointmentId);

  let slot = 0;
  /**
   * A patient books, the doctor issues 6,000,000 + `scalings` × 3,000,000 (2 unless told:
   * a loan of 9,600,000, level «low»), the patient confirms.
   */
  async function confirmedProforma(p?: Patient, scalings = 2, visitRial = '6000000') {
    const who = p ?? (await patient());
    const n = slot++;
    const held = await as(who, 'POST', '/booking/appointments/hold', {
      workplaceId,
      serviceCode: 'visit',
      startsAt: fromJalali(day, {
        hour: 8 + Math.floor(n / 2),
        minute: (n % 2) * 30,
      }).toISOString(),
    });
    expect(held.status).toBe(201);
    await as(who, 'POST', `/booking/appointments/${held.body['id'] as string}/request`);
    // A proforma is issued only after the examination (owner 1405/07/23).
    await examine(who, held.body['id'] as string);
    const made = await staff(doctor, 'POST', '/proformas', {
      appointmentId: held.body['id'],
      lines: [
        { serviceCode: 'visit', quantity: 1, unitRial: visitRial },
        { serviceCode: 'scaling', quantity: scalings },
      ],
    });
    const id = made.body['id'] as string;
    expect((await staff(doctor, 'POST', `/proformas/${id}/issue`)).status).toBe(201);
    expect((await as(who, 'POST', `/me/proformas/${id}/confirm`)).status).toBe(201);
    return { patient: who, proformaId: id };
  }

  /** A multipart upload of a document by its own person. */
  async function upload(
    p: Patient,
    applicationId: string,
    role: 'borrower' | 'guarantor',
    itemCode: string,
    file: Buffer,
  ) {
    const form = new FormData();
    form.append('role', role);
    form.append('itemCode', itemCode);
    form.append('file', new Blob([new Uint8Array(file)]), 'document.pdf');
    const res = await fetch(`${h.baseUrl}/me/credit-applications/${applicationId}/documents`, {
      method: 'POST',
      headers: { authorization: `Bearer ${p.token}`, 'x-forwarded-for': newIp() },
      body: form,
    });
    return { status: res.status, body: (await res.json()) as Body };
  }

  /** Uploads every required item without a job and has case completion accept it. */
  async function documented(p: Patient, applicationId: string, role: 'borrower' | 'guarantor') {
    for (const item of BASE_DOCUMENTS) {
      const sent = await upload(p, applicationId, role, item, PDF);
      expect(sent.status).toBe(201);
      const decided = await staff(
        completion,
        'POST',
        `/credit/applications/${applicationId}/documents/${sent.body['id'] as string}/decision`,
        { decision: 'accept' },
      );
      expect(decided.status).toBe(201);
    }
  }

  /** A credit application submitted, consented, documented and sent to review. */
  async function inReview(
    p?: Patient,
    scalings?: number,
    visitRial?: string,
    planCode: string = PLAN.code,
  ) {
    const { patient: who, proformaId } = await confirmedProforma(p, scalings, visitRial);
    const made = await as(who, 'POST', '/me/credit-applications', {
      proformaId,
      planCode,
      installmentCount: 12,
    });
    expect(made.status).toBe(201);
    const id = made.body['id'] as string;
    expect((await as(who, 'POST', `/me/credit-applications/${id}/submit`)).status).toBe(201);
    await consent(who, id, 'borrower');
    await documented(who, id, 'borrower');
    expect(
      (await staff(completion, 'POST', `/credit/applications/${id}/ready-for-review`)).status,
    ).toBe(201);
    return { patient: who, applicationId: id };
  }

  /** The person consents with the code sent to their own mobile. */
  async function consent(p: Patient, applicationId: string, role: 'borrower' | 'guarantor') {
    const sent = await as(p, 'POST', `/me/credit-applications/${applicationId}/consent/request`, {
      role,
    });
    expect(sent.status).toBe(201);
    const given = await as(p, 'POST', `/me/credit-applications/${applicationId}/consent`, {
      role,
      code: h.sms.lastCodeFor(p.mobile),
    });
    expect(given.status).toBe(201);
    return given.body;
  }

  return {
    staff,
    as,
    role,
    patient,
    confirmedProforma,
    examine,
    inReview,
    consent,
    upload,
    documented,
    doctor,
    completion,
    creditSpecialist,
    specialist,
    workplaceId,
    centerId,
    branchId: branch?.id ?? '',
  };
}

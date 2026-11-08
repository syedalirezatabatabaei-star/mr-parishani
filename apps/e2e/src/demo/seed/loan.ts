/**
 * One patient's way through the system, as the people of the demo would walk it through the
 * API: booking, examination, proforma, application, completion, decision, contract, receipts,
 * funding and the service. Each case stops at the stage its story asks for, so the demo has
 * every scenario both finished and in progress (owner 1405/08/07).
 */
import { randomInt } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { secrets, STATE_DIR } from '../runtime.ts';
import type { DemoWorkplace } from './catalog.ts';
import { SERVICES } from './catalog.ts';
import {
  person,
  as,
  asPatient,
  nextCode,
  sleep,
  patientUpload,
  type Body,
  type Patient,
  type Person,
  type SeedState,
} from './context.ts';
import { DEMO } from './settings.ts';

export type Stage =
  | 'booked'
  | 'confirmed'
  | 'examined'
  | 'proforma'
  | 'draft'
  | 'submitted'
  | 'ready_for_review'
  | 'decision_proposed'
  | 'rejected'
  | 'approved'
  | 'contract_accepted'
  | 'receipts_pending'
  | 'completed'
  | 'funding_requested'
  | 'funded'
  | 'served';

const ORDER: Stage[] = [
  'booked',
  'confirmed',
  'examined',
  'proforma',
  'draft',
  'submitted',
  'ready_for_review',
  'decision_proposed',
  'approved',
  'contract_accepted',
  'receipts_pending',
  'completed',
  'funding_requested',
  'funded',
  'served',
];
const reached = (target: Stage, stage: Stage) =>
  target === 'rejected'
    ? ORDER.indexOf(stage) <= ORDER.indexOf('decision_proposed')
    : ORDER.indexOf(stage) <= ORDER.indexOf(target);

export interface LoanStory {
  patient: Patient;
  place: DemoWorkplace;
  stopAt: Stage;
  planCode?: string;
  installments?: number;
  /** The proforma: wage and material lines of the place's field (made up if absent). */
  lines?: { serviceCode: string; unitRial: number }[];
  guarantor?: Patient;
  promissory?: boolean;
}

export interface LoanResult {
  appointmentId?: string;
  proformaId?: string;
  applicationId?: string;
  purseId?: string;
  lineIds?: string[];
  wageLineIds?: string[];
  stage: Stage;
}

const code = () => secrets().patientCode;
const pt = (p: Patient, method: string, path: string, body?: unknown) =>
  asPatient(p, code(), method, path, body);
const today = () => new Date().toISOString().slice(0, 10);
const round = (rial: number) => Math.round(rial / 1e6) * 1e6;

/** A staff action by whichever of `people` the case is assigned to (the queues share it). */
async function byAssignee(
  people: Person[],
  method: string,
  path: string,
  body?: unknown,
): Promise<Body> {
  let last: unknown;
  for (const who of people) {
    try {
      return await as(who, method, path, body);
    } catch (error) {
      last = error;
      if (!(error instanceof Error) || !/→ 403 /.test(error.message)) throw error;
    }
  }
  throw last instanceof Error ? last : new Error(String(last));
}

/**
 * Lines for a place's field, sized to the employer's scoring matrix (amount levels: low up to
 * 40M, medium up to 120M, high up to 200M rials; above that, out of the matrix, to the
 * committee): mostly low and medium, some high, a few above. `level` forces one.
 */
export function linesFor(
  place: DemoWorkplace,
  level?: 'low' | 'medium' | 'high' | 'over',
  withMaterial = false,
): { serviceCode: string; unitRial: number }[] {
  const roll = randomInt(100);
  const chosen = level ?? (roll < 45 ? 'low' : roll < 75 ? 'medium' : roll < 90 ? 'high' : 'over');
  const loan = { low: [15, 38], medium: [45, 115], high: [125, 195], over: [250, 900] }[chosen];
  const target = ((loan[0] ?? 15) + randomInt((loan[1] ?? 38) - (loan[0] ?? 15) + 1)) * 1e6;
  const field =
    place.fieldCodes[randomInt(place.fieldCodes.length)] ?? place.fieldCodes[0] ?? 'dental';
  const services = SERVICES[field] ?? [];
  const wages = services.filter((s) => s.kind === 'wage').sort((x, y) => x.min - y.min);
  const unit = target / 0.85;
  const wage =
    wages.find((w) => w.min <= unit && unit <= w.max) ??
    wages.find((w) => w.max >= unit) ??
    wages[wages.length - 1];
  const lines: { serviceCode: string; unitRial: number }[] = [];
  if (wage)
    lines.push({
      serviceCode: wage.code,
      unitRial: round(Math.min(wage.max, Math.max(wage.min, unit))),
    });
  if (withMaterial) {
    const material = services.find((m) => m.kind === 'material');
    if (material) lines.push({ serviceCode: material.code, unitRial: round(material.min) });
  }
  return lines;
}

function serviceCodeFor(mobile: string): string | undefined {
  const masked = `${mobile.slice(0, 3)}***${mobile.slice(-4)}`;
  try {
    return (
      JSON.parse(readFileSync(resolve(STATE_DIR, 'service-codes.json'), 'utf8')) as Record<
        string,
        string
      >
    )[masked];
  } catch {
    return undefined;
  }
}

export async function runLoan(state: SeedState, story: LoanStory): Promise<LoanResult> {
  const center = person(state, story.place.managerKey);
  const doctor = person(state, story.place.doctorKey);
  const patient = story.patient;
  const result: LoanResult = { stage: 'booked' };
  const want = (s: Stage) => reached(story.stopAt, s);

  // Booking: the first free slot of the coming two weeks.
  const to = new Date(Date.now() + 13 * 86_400_000).toISOString().slice(0, 10);
  const slots = (await pt(
    patient,
    'GET',
    `/booking/workplaces/${story.place.workplaceId}/free-slots?from=${today()}&to=${to}`,
  )) as unknown as { startsAt: string }[];
  const slot = slots[randomInt(Math.min(slots.length, 6))] ?? slots[0];
  if (!slot) throw new Error(`no free slot at ${story.place.centerName}`);
  const held = await pt(patient, 'POST', '/booking/appointments/hold', {
    workplaceId: story.place.workplaceId,
    serviceCode: 'visit',
    startsAt: slot.startsAt,
  });
  const appointmentId = String(held['id']);
  result.appointmentId = appointmentId;
  const requested = await pt(patient, 'POST', `/booking/appointments/${appointmentId}/request`);
  if (!want('confirmed')) return result;
  const visit = `/booking/appointments/${appointmentId}`;
  if (requested['status'] === 'requested')
    await as(center, 'POST', `${visit}/respond`, { decision: 'confirm' });
  result.stage = 'confirmed';
  if (!want('examined')) return result;
  const mine = await pt(patient, 'GET', `/booking/me/appointments/${appointmentId}`);
  await as(center, 'POST', `${visit}/check-in`, { code: mine['checkInCode'] });
  await as(center, 'POST', `${visit}/examined`);
  result.stage = 'examined';
  if (!want('proforma')) return result;

  // The proforma, issued by the doctor and confirmed by the patient.
  const lines = story.lines ?? linesFor(story.place);
  const proforma = await as(doctor, 'POST', '/proformas', {
    appointmentId,
    lines: lines.map((l) => ({
      serviceCode: l.serviceCode,
      quantity: 1,
      unitRial: String(l.unitRial),
    })),
  });
  const proformaId = String(proforma['id']);
  result.proformaId = proformaId;
  const issued = await as(doctor, 'POST', `/proformas/${proformaId}/issue`);
  const issuedLines = ((issued['lines'] ?? proforma['lines']) as Body[] | undefined) ?? [];
  result.lineIds = issuedLines.map((l) => String(l['id']));
  const materialCodes = new Set(
    Object.values(SERVICES)
      .flat()
      .filter((s) => s.kind === 'material')
      .map((s) => s.code),
  );
  result.wageLineIds = issuedLines
    .filter((l) => !materialCodes.has(String(l['serviceCode'])))
    .map((l) => String(l['id']));
  await pt(patient, 'POST', `/me/proformas/${proformaId}/confirm`);
  result.stage = 'proforma';
  if (!want('draft')) return result;

  // The application.
  const app = await pt(patient, 'POST', '/me/credit-applications', {
    proformaId,
    planCode: story.planCode ?? `${story.place.fieldCodes[0] ?? 'dental'}_standard`,
    installmentCount: story.installments ?? 12,
  });
  const applicationId = String(app['id']);
  result.applicationId = applicationId;
  result.stage = 'draft';
  if (!want('submitted')) return result;
  await pt(patient, 'POST', `/me/credit-applications/${applicationId}/submit`);
  await pt(patient, 'POST', `/me/credit-applications/${applicationId}/consent/request`, {
    role: 'borrower',
  });
  await pt(patient, 'POST', `/me/credit-applications/${applicationId}/consent`, {
    role: 'borrower',
    code: await nextCode(patient),
  });
  const completion = [person(state, 'comp1'), person(state, 'comp2'), person(state, 'compfin')];
  for (const itemCode of ['national_card', 'job_proof', 'bank_statement']) {
    if (!patient.token) await pt(patient, 'GET', '/auth/me');
    const sent = await patientUpload(
      patient,
      code(),
      `/me/credit-applications/${applicationId}/documents`,
      { role: 'borrower', itemCode },
    );
    await byAssignee(
      completion,
      'POST',
      `/credit/applications/${applicationId}/documents/${String(sent['id'])}/decision`,
      { decision: 'accept' },
    );
  }
  result.stage = 'submitted';

  if (!want('ready_for_review')) return result;
  await byAssignee(completion, 'POST', `/credit/applications/${applicationId}/ready-for-review`);
  result.stage = 'ready_for_review';
  if (!want('decision_proposed')) return result;

  const analysts = [person(state, 'credspec1'), person(state, 'credspec2')];
  await byAssignee(analysts, 'POST', `/credit/applications/${applicationId}/score-sheets`, {
    subject: 'borrower',
    raw: {
      job: pickJob(),
      employmentStartedOn: {
        year: 1390 + randomInt(12),
        month: 1 + randomInt(12),
        day: 1 + randomInt(28),
      },
      coverage: 'full',
      obligationsRial: String(randomInt(0, 20) * 1_000_000),
      newInstallmentRial: String(randomInt(4, 40) * 1_000_000),
    },
  });
  // A guarantor, introduced once the borrower is graded, consents and is documented.
  let guarantorId = '';
  if (story.guarantor) {
    const g = story.guarantor;
    const invited = await pt(
      patient,
      'POST',
      `/me/credit-applications/${applicationId}/guarantors`,
      { mobile: `0${g.mobile}` },
    );
    guarantorId = String(invited['id']);
    await pt(g, 'POST', `/me/credit-applications/${applicationId}/consent/request`, {
      role: 'guarantor',
    });
    await pt(g, 'POST', `/me/credit-applications/${applicationId}/consent`, {
      role: 'guarantor',
      code: await nextCode(g),
    });
    for (const itemCode of ['national_card', 'job_proof', 'bank_statement']) {
      const sent = await patientUpload(
        g,
        code(),
        `/me/credit-applications/${applicationId}/documents`,
        { role: 'guarantor', itemCode },
      );
      await byAssignee(
        completion,
        'POST',
        `/credit/applications/${applicationId}/documents/${String(sent['id'])}/decision`,
        { decision: 'accept' },
      );
    }
  }
  if (story.guarantor) {
    await byAssignee(analysts, 'POST', `/credit/applications/${applicationId}/score-sheets`, {
      subject: 'guarantor',
      guarantorId,
      raw: {
        job: 'official',
        employmentStartedOn: { year: 1388 + randomInt(8), month: 1, day: 1 },
        averageBalanceRial: String(randomInt(20, 200) * 1_000_000),
        installmentRial: String(randomInt(1, 10) * 1_000_000),
        debts: 'none_or_very_low',
        independence: 'fully_independent',
      },
    });
  }
  // A review by the cost-split reviewer when the case carries materials (ADR-050, wage only).
  // Whatever the checklist still asks for (by job, by guarantor) is sent and accepted.
  for (let attempt = 0; ; attempt++) {
    try {
      await byAssignee(analysts, 'POST', `/credit/applications/${applicationId}/to-decision`);
      break;
    } catch (error) {
      const text = error instanceof Error ? error.message : '';
      const missing = [...text.matchAll(/document:(borrower|guarantor):([a-z_]+)/g)];
      // ADR-050: a case with materials has its wage and material split reviewed by an analyst.
      if (text.includes('cost_split_review') && attempt <= 2) {
        await byAssignee(
          analysts,
          'POST',
          `/credit/applications/${applicationId}/cost-split-review`,
          { note: 'تفکیک دستمزد و مواد با تعرفه مرکز هم‌خوان است' },
        );
        if (missing.length === 0) continue;
      }
      if (attempt > 2 || missing.length === 0) throw error;
      for (const m of missing) {
        const who = m[1] === 'guarantor' && story.guarantor ? story.guarantor : patient;
        const sent = await patientUpload(
          who,
          code(),
          `/me/credit-applications/${applicationId}/documents`,
          { role: m[1] ?? 'borrower', itemCode: m[2] ?? '' },
        );
        await byAssignee(
          completion,
          'POST',
          `/credit/applications/${applicationId}/documents/${String(sent['id'])}/decision`,
          { decision: 'accept' },
        );
      }
    }
  }
  const rejecting = story.stopAt === 'rejected';
  let proposed: Body;
  // The committee's minutes, when the decision is the committee's (doc 10 §8).
  const minutes = () => ({
    minutesNumber: `DEMO-${String(randomInt(100, 999))}/1405`,
    meetingAt: new Date().toISOString(),
    attendeeAccountIds: [
      person(state, 'committee1').accountId,
      person(state, 'committee2').accountId,
      person(state, 'credman1').accountId,
    ],
  });
  const body: Body = rejecting
    ? {
        outcome: 'rejected',
        reason: 'تعهدات قبلی زیاد نسبت به درآمد',
        reasonCode: 'high_obligations',
      }
    : { outcome: 'approved', reason: 'رتبه الف' };
  // 'matrix': the manager confirms; 'committee': the engine gives it to the committee (its
  // units vote); 'out': out of the matrix (the committee votes and a second manager checks).
  let path: 'matrix' | 'committee' | 'out' = 'matrix';
  try {
    proposed = await byAssignee(
      analysts,
      'POST',
      `/credit/applications/${applicationId}/decisions`,
      body,
    );
  } catch (error) {
    const text = error instanceof Error ? error.message : '';
    if (text.includes('committee_minutes_required')) {
      path = 'committee';
      proposed = await byAssignee(
        analysts,
        'POST',
        `/credit/applications/${applicationId}/decisions`,
        { ...body, committee: minutes() },
      );
    } else if (text.includes('out_of_matrix_required')) {
      // Above the matrix's amounts, or a guarantee short of it: the credit manager proposes
      // with the committee's minutes.
      path = 'out';
      proposed = await as(
        person(state, 'credman1'),
        'POST',
        `/credit/applications/${applicationId}/decisions`,
        {
          outcome: 'approved',
          outOfMatrix: true,
          reason: `${DEMO}: مصوبه کمیته ریسک و اعتبار`,
          committee: minutes(),
        },
      );
    } else throw error;
  }
  result.stage = 'decision_proposed';
  if (story.stopAt === 'decision_proposed') return result;
  const decisionPath = `/credit/applications/${applicationId}/decisions/${String(proposed['id'])}`;
  if (path !== 'matrix') {
    const vote = rejecting ? 'object' : 'approve';
    await as(person(state, 'committee1'), 'POST', `${decisionPath}/votes`, {
      unitCode: 'strategy',
      vote,
      note: 'نظر واحد استراتژی',
    });
    await as(person(state, 'committee2'), 'POST', `${decisionPath}/votes`, {
      unitCode: 'collection',
      vote,
      note: 'نظر واحد وصول',
    });
  }
  if (path === 'out') await as(person(state, 'credman2'), 'POST', `${decisionPath}/confirm`);
  if (path === 'matrix') {
    await byAssignee(
      [person(state, 'credman1'), person(state, 'credman2')],
      'POST',
      `${decisionPath}/confirm`,
    );
  }
  if (rejecting) {
    result.stage = 'rejected';
    return result;
  }
  result.stage = 'approved';
  if (!want('contract_accepted')) return result;

  // Completion: the contract printed by the worker and accepted with a code.
  const contract = await byAssignee(completion, 'POST', '/contracts', {
    creditApplicationId: applicationId,
  });
  const contractId = String(contract['id']);
  for (let i = 0; i < 120; i++) {
    const list = (await byAssignee(
      completion,
      'GET',
      `/contracts?creditApplicationId=${applicationId}`,
    )) as unknown as Body[];
    const status = list.find((c) => c['id'] === contractId)?.['status'];
    if (status && status !== 'generating') break;
    await sleep(500);
  }
  await pt(patient, 'POST', `/me/contracts/${contractId}/acceptance/request`, { role: 'borrower' });
  await pt(patient, 'POST', `/me/contracts/${contractId}/acceptance`, {
    role: 'borrower',
    code: await nextCode(patient),
  });
  if (story.guarantor) {
    const g = story.guarantor;
    await pt(g, 'POST', `/me/contracts/${contractId}/acceptance/request`, { role: 'guarantor' });
    await pt(g, 'POST', `/me/contracts/${contractId}/acceptance`, {
      role: 'guarantor',
      code: await nextCode(g),
    });
  }
  result.stage = 'contract_accepted';
  if (!want('receipts_pending')) return result;

  // The paper: the signed contract and the borrower's cheque (one, the demo's rule), or a
  // promissory note; received, the instrument recorded and the delivery checked.
  // The rule asks one borrower cheque of every case; a promissory note comes besides it.
  const kinds: { kind: string; label: string }[] = [
    { kind: 'signed_contract', label: 'قرارداد امضاشده' },
    { kind: 'cheque', label: 'چک وام‌گیرنده' },
    ...(story.promissory ? [{ kind: 'promissory_note', label: 'سفته وام‌گیرنده' }] : []),
  ];
  const delivery = await byAssignee(completion, 'POST', '/deliveries', {
    creditApplicationId: applicationId,
    items: kinds,
  });
  const deliveryId = String(delivery['id']);
  await byAssignee(completion, 'POST', `/deliveries/${deliveryId}/receive`, {
    method: 'in_person',
  });
  for (const item of delivery['items'] as Body[]) {
    await byAssignee(completion, 'POST', `/deliveries/${deliveryId}/items/${String(item['id'])}`, {
      status: 'received',
    });
    if (item['kind'] === 'cheque' || item['kind'] === 'promissory_note') {
      const due = new Date(Date.now() + 365 * 86_400_000).toISOString().slice(0, 10);
      const instrument = await byAssignee(
        completion,
        'POST',
        `/deliveries/${deliveryId}/instruments`,
        {
          itemId: String(item['id']),
          kind: item['kind'],
          issuer: { role: 'borrower' },
          amountRial: String(lines.reduce((s, l) => s + l.unitRial, 0)),
          number:
            String(randomInt(100_000_000, 999_999_999)) + String(randomInt(1_000_000, 9_999_999)),
          bankName: pickBank(),
          dueOn: due,
          notes: DEMO,
        },
      );
      // A cheque is registered in Sayad (and confirmed) before it is verified.
      if (item['kind'] === 'cheque')
        await byAssignee(completion, 'POST', `/instruments/${String(instrument['id'])}/sayad`);
      await byAssignee(completion, 'POST', `/instruments/${String(instrument['id'])}/verify`);
    }
  }
  await byAssignee(completion, 'POST', `/deliveries/${deliveryId}/check`);
  // Into the safe: the instruments are then held, and come back only after full settlement.
  await byAssignee(completion, 'POST', `/deliveries/${deliveryId}/archive`, {
    location: 'گاوصندوق دفتر مرکزی، قفسه ۳',
  });
  // What the borrower owes at completion (down payment, formation fee, deposit), paid by
  // receipt and approved by finance.
  const status = await byAssignee(completion, 'GET', `/completion/${applicationId}`);
  const owed = (status['owed'] as Body[] | undefined) ?? [];
  const finance = [person(state, 'acc1'), person(state, 'acc2')];
  const receiptIds: string[] = [];
  for (const o of owed) {
    const kind = String(o['kind']);
    const sent = await patientUpload(patient, code(), `/me/completion/${applicationId}/receipts`, {
      kind,
      amountRial: String(o['expectedRial']),
      paidOn: today(),
      reference: `DEMO-${kind}-${String(Date.now()).slice(-8)}`,
    });
    receiptIds.push(String(sent['id']));
  }
  result.stage = 'receipts_pending';
  if (!want('completed')) return result;
  for (const id of receiptIds) await byAssignee(finance, 'POST', `/receipts/${id}/approve`);
  await byAssignee(completion, 'POST', `/completion/${applicationId}/complete`);
  result.stage = 'completed';
  if (!want('funding_requested')) return result;

  const asked = await as(person(state, 'compfin'), 'POST', '/funding/requests', {
    creditApplicationId: applicationId,
  });
  result.stage = 'funding_requested';
  if (!want('funded')) return result;
  const funded = await as(
    person(state, 'acc1'),
    'POST',
    `/funding/requests/${String(asked['id'])}/approve`,
  );
  result.purseId = String(funded['purseId']);
  result.stage = 'funded';
  if (!want('served')) return result;

  // The service from the purse: the doctor issues it, the patient reads the code to them.
  const before = serviceCodeFor(patient.mobile);
  // The doctor's own list of the purse's lines: those not cash-only (materials of a wage-only
  // plan are paid in cash) and not yet authorized.
  const purseLines = await as(doctor, 'GET', `/service/patients/${result.purseId}/lines`);
  const lineIds = ((purseLines['lines'] as Body[] | undefined) ?? [])
    .filter((l) => !l['cashOnly'] && !l['authorized'])
    .map((l) => String(l['id']));
  if (lineIds.length === 0) throw new Error('no line to serve from the purse');
  const auth = await as(doctor, 'POST', '/service/authorizations', {
    purseId: result.purseId,
    proformaLineIds: lineIds,
  });
  let serviceCode = '';
  for (let i = 0; i < 60; i++) {
    const c = serviceCodeFor(patient.mobile);
    if (c && c !== before) {
      serviceCode = c;
      break;
    }
    await sleep(500);
  }
  if (!serviceCode) throw new Error('no service code printed');
  await as(doctor, 'POST', `/service/authorizations/${String(auth['id'])}/deliver`, {
    code: serviceCode,
  });
  result.stage = 'served';
  return result;
}

const JOBS = ['official', 'official', 'self_employed_over_5', 'self_employed_under_5'] as const;
const pickJob = () => JOBS[randomInt(JOBS.length)] ?? 'official';
const BANKS = ['ملی', 'ملت', 'تجارت', 'صادرات', 'سپه', 'پاسارگاد', 'سامان', 'رفاه'];
const pickBank = () => `بانک ${BANKS[randomInt(BANKS.length)] ?? 'ملی'}`;

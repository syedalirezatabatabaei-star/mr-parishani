/**
 * The demo's open work, today (owner 1405/08/07): for each of the 14 acceptance scenarios
 * (docs/ops/owner-acceptance-scenarios.md) an example left half done, so the show never has
 * to make data on the spot. Each item is its own try; what fails is written down.
 */
import { randomInt } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { API, secrets, serviceEnv } from '../runtime.ts';
import type { DemoWorkplace } from './catalog.ts';
import { demoMobile } from './catalog.ts';
import {
  patientAt,
  person,
  as,
  asPatient,
  patientUpload,
  type Body,
  type Patient,
  type SeedState,
} from './context.ts';
import { runLoan } from './loan.ts';
import { DEMO } from './settings.ts';

const TICKETS: [string, string][] = [
  ['پرسش درباره قسط', 'سررسید قسط بعدی من چه روزی است و مبلغ آن چقدر است؟'],
  ['تغییر نوبت', 'امکان جابه‌جا کردن نوبت هفته آینده به عصر هست؟'],
  ['فیش پرداخت', 'فیش قسط دوم را بارگذاری کردم ولی هنوز تأیید نشده است.'],
  ['شارژ کیف اعتبار', 'اعتبار کیف من چه زمانی شارژ می‌شود؟'],
  ['کد تأیید خدمت', 'پیامک کد تأیید خدمت به دستم نرسید.'],
  ['تسویه زودهنگام', 'اگر کل مانده را یکجا بپردازم تخفیفی دارد؟'],
  ['مدارک ضامن', 'ضامن من چطور باید مدارکش را بارگذاری کند؟'],
  ['اعتراض به مبلغ', 'مبلغ پیش‌فاکتور با آنچه پزشک گفته بود فرق دارد.'],
  ['استرداد چک', 'اقساط من تمام شده؛ چک ضمانت را کی پس می‌گیرم؟'],
  ['تغییر شماره', 'شماره همراهم عوض شده؛ چطور ثبتش کنم؟'],
  ['پرسش درباره طرح', 'طرح شش‌ماهه باشگاه برای کاشت مو هم هست؟'],
  ['تأخیر در پاسخ مرکز', 'مرکز هنوز نوبت مرا تأیید نکرده است.'],
];

function firstApproverMobile(state: SeedState, key: string, mobile: string, issues: string[]) {
  const done = spawnSync(
    process.execPath,
    ['dist/modules/identity/cli/set-first-approver-mobile.js'],
    {
      cwd: API,
      env: {
        ...serviceEnv(),
        ACCOUNT_USERNAME: person(state, key).username,
        MOBILE: `0${mobile}`,
        OPERATOR: person(state, 'admin1').username,
        WITNESS: person(state, 'third').username,
        REASON: `${DEMO}: شماره اول امضاکننده`,
      },
      encoding: 'utf8',
    },
  );
  if (done.status !== 0)
    issues.push(`شماره اول ${key}: ${(done.stderr || done.stdout).trim().slice(0, 200)}`);
}

export async function seedInProgress(state: SeedState, rawCases: Body[], issues: string[]) {
  const code = secrets().patientCode;
  const places = state.data['places'] as DemoWorkplace[];
  const cases = rawCases as unknown as {
    patient: number;
    story: string;
    repay: string;
    result?: { applicationId?: string; purseId?: string; stage: string };
    cancelled?: boolean;
    cap?: boolean;
    place: number;
  }[];
  const pt = (x: Patient, method: string, path: string, body?: unknown) =>
    asPatient(x, code, method, path, body);
  const step = async (what: string, run: () => Promise<unknown>) => {
    try {
      await run();
    } catch (error) {
      issues.push(`${what}: ${(error as Error).message.slice(0, 220)}`);
    }
  };
  const funded = cases.filter((c) => c.result?.purseId && !c.cancelled);

  // Tickets: some answered and resolved, some waiting on the patient, some new.
  await step('تیکت‌ها', async () => {
    for (const [i, [subject, body]] of TICKETS.entries()) {
      const c = cases[(i * 7) % cases.length];
      if (!c) continue;
      const who = patientAt(state, c.patient);
      const ticket = await pt(who, 'POST', '/me/tickets', {
        topicCode: 'general',
        subject,
        body,
        links: [],
      });
      const id = String(ticket['id']);
      if (i % 3 === 2) continue;
      const support = person(state, i % 2 === 0 ? 'support1' : 'support2');
      await as(support, 'POST', `/tickets/${id}/status`, {
        to: 'in_progress',
        note: 'در حال بررسی',
      }).catch(() => undefined);
      await as(support, 'POST', `/tickets/${id}/messages`, {
        body: 'سلام، درخواست شما بررسی شد. جزئیات در پرونده ثبت شده است.',
        visibility: 'public',
      });
      if (i % 3 === 0)
        await as(support, 'POST', `/tickets/${id}/status`, {
          to: 'resolved',
          note: 'پاسخ داده شد',
        });
      else
        await as(support, 'POST', `/tickets/${id}/status`, {
          to: 'waiting_on_requester',
          note: 'منتظر پاسخ بیمار',
        });
    }
  });

  // Collection: today's overdue queue worked by the two agents (calls, a promise).
  await step('وصول', async () => {
    for (const key of ['coll1', 'coll2']) {
      const queue = await as(person(state, key), 'GET', '/collection/queue?mine=true');
      const items = (
        (queue['items'] as Body[] | undefined) ?? (Array.isArray(queue) ? queue : [])
      ).slice(0, 6);
      for (const [i, item] of items.entries()) {
        const id = String((item as Body)['itemId']);
        await as(person(state, key), 'POST', `/collection/items/${id}/actions`, {
          kind: i % 3 === 2 ? 'guarantor_contact' : 'call',
          outcome: i % 2 === 0 ? 'پاسخ داد؛ قول پرداخت داد' : 'پاسخ نداد',
          note: `${DEMO}: پیگیری تلفنی`,
          occurredAt: new Date().toISOString(),
          nextFollowUpAt: new Date(Date.now() + 3 * 86_400_000).toISOString(),
        });
        if (i % 2 === 0) {
          await as(person(state, key), 'POST', `/collection/items/${id}/promises`, {
            amountRial: String(randomInt(5, 40) * 1_000_000),
            promisedOn: new Date(Date.now() + 5 * 86_400_000).toISOString().slice(0, 10),
            note: 'قول پرداخت تا آخر هفته',
          });
        }
      }
    }
  });

  // Scenario 13: the first signers' mobiles by the server tool (operator and witness); a
  // signer's mobile change approved by two, another waiting for its second signature.
  firstApproverMobile(state, 'ceo', demoMobile(7001), issues);
  firstApproverMobile(state, 'admin1', demoMobile(7002), issues);
  await step('تغییر شماره امضاکننده', async () => {
    const done = await as(person(state, 'ceo'), 'POST', '/identity/staff-mobile-changes', {
      accountId: person(state, 'acc1').accountId,
      mobile: `0${demoMobile(7003)}`,
      reason: `${DEMO}: ثبت شماره حسابدار`,
    });
    await as(
      person(state, 'admin1'),
      'POST',
      `/identity/staff-mobile-changes/${String(done['id'])}/decisions`,
      { outcome: 'approved', reason: 'تأیید هویت حضوری' },
    );
    await as(
      person(state, 'third'),
      'POST',
      `/identity/staff-mobile-changes/${String(done['id'])}/decisions`,
      { outcome: 'approved', reason: 'تأیید نفر سوم' },
    );
    const waiting = await as(person(state, 'ceo'), 'POST', '/identity/staff-mobile-changes', {
      accountId: person(state, 'acc2').accountId,
      mobile: `0${demoMobile(7004)}`,
      reason: `${DEMO}: ثبت شماره حسابدار دوم`,
    });
    await as(
      person(state, 'admin1'),
      'POST',
      `/identity/staff-mobile-changes/${String(waiting['id'])}/decisions`,
      { outcome: 'approved', reason: 'تأیید هویت حضوری' },
    );
  });

  // Scenario 14: a guarantee returned after the last installment (two people), another asked.
  await step('استرداد چک و سفته', async () => {
    const due = await as(person(state, 'release'), 'GET', '/instrument-releases/due');
    const items = (
      (due['items'] as Body[] | undefined) ?? (Array.isArray(due) ? (due as unknown as Body[]) : [])
    ).filter((x) => !x['pendingRequest']);
    for (const [i, item] of items.slice(0, 3).entries()) {
      const asked = await as(
        person(state, 'release'),
        'POST',
        `/instrument-releases/${String(item['instrumentId'])}/requests`,
        { reason: 'همه اقساط پرداخت شده است' },
      );
      if (i < 2)
        await as(
          person(state, 'acc1'),
          'POST',
          `/instrument-releases/requests/${String(asked['id'])}/decision`,
          { outcome: 'approved', reason: 'تسویه کامل تأیید شد' },
        );
    }
  });

  // Scenario 9: a holiday proposed by the CEO, waiting for the deputy.
  await step('تعطیلی در انتظار تأیید', async () => {
    await as(person(state, 'ceo'), 'POST', '/calendar/holidays/batches', {
      year: 1405,
      days: [{ on: { year: 1405, month: 9, day: 23 }, title: `${DEMO}: تعطیلی پیشنهادی` }],
      reason: `${DEMO}: تعطیلی محلی پیشنهادی`,
    });
  });

  // Scenario 12: a borrower's own cancellation rate, asked by finance; one approved by the CEO.
  await step('نرخ خسارت انصراف یک نفر', async () => {
    // Before its contract only (a contract locks the rate): the approved cases.
    const targets = cases.filter((c) => c.result?.stage === 'approved').slice(0, 2);
    for (const [i, c] of targets.entries()) {
      const asked = await as(
        person(state, 'acc1'),
        'POST',
        `/credit/applications/${String(c.result?.applicationId)}/penalty-overrides`,
        { penaltyBps: 1000, reason: `${DEMO}: شرایط خاص بیمار` },
      );
      if (i === 0)
        await as(
          person(state, 'ceo'),
          'POST',
          `/credit/penalty-overrides/${String(asked['id'])}/approve`,
          { reason: 'تأیید شرایط خاص' },
        );
    }
  });

  // Scenario 10: receipts waiting for finance, and one sent twice (suspected duplicate).
  await step('فیش در انتظار و تکراری', async () => {
    const payers = funded.filter((c) => c.repay === 'ontime').slice(0, 3);
    for (const [i, c] of payers.entries()) {
      const who = patientAt(state, c.patient);
      const schedules = (await pt(
        who,
        'GET',
        `/me/repayment/schedules?creditApplicationId=${String(c.result?.applicationId)}`,
      )) as unknown as {
        id: string;
        installments: { outstandingRial: string; status: string }[];
      }[];
      const s = schedules[0];
      const next = s?.installments.find((x) => BigInt(x.outstandingRial) > 0n);
      if (!s || !next) continue;
      const bankRef = `DEMO-WAIT-${String(i)}${String(randomInt(1000, 9999))}`;
      const body = {
        scheduleId: s.id,
        amountRial: next.outstandingRial,
        paidOn: new Date().toISOString().slice(0, 10),
        bankRef,
        payerName: who.name,
      };
      await patientUpload(who, code, '/me/repayment/receipts', body);
      // The same slip sent again a day later: same reference and amount, flagged as a suspected duplicate.
      if (i === 0) {
        const yesterday = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
        await patientUpload(who, code, '/me/repayment/receipts', { ...body, paidOn: yesterday });
      }
    }
  });

  // Scenario 5: a second case of the borrower near the cap: its approval meets the cap.
  await step('سقف مانده وام‌گیرنده', async () => {
    const cap = cases.find((c) => c.cap && c.result?.purseId);
    if (!cap) return;
    const place = places[cap.place];
    if (!place) return;
    const r = await runLoan(state, {
      patient: patientAt(state, cap.patient),
      place,
      stopAt: 'decision_proposed',
      lines: [
        {
          serviceCode:
            place.fieldCodes[0] === 'dental' ? 'dental_implant_wage' : 'beauty_rhinoplasty',
          unitRial: 1_000_000_000,
        },
      ],
    });
    state.data['capSecondApplication'] = r.applicationId;
  });

  // A patient's mobile change needs the code sent to the new number from the panel's own
  // step (POST /identity/patient-mobile-changes takes it): left to the show, not seeded.
}

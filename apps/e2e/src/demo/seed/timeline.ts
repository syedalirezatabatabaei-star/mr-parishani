/**
 * Six months of the demo (owner 1405/08/07): the clock moves three days at a time from the
 * seed's first day to today; on each day new patients come, cases move on, borrowers pay (or
 * not, as their story says), and finance does the month's two-person work. The worker's own
 * nightly jobs (installment states, the collection cycle, statements, payables) run on the
 * moved clock as they would. What fails is written down and the seed goes on.
 */
import { randomInt } from 'node:crypto';
import { toJalali } from '@sepehr/contracts';
import { nationalId } from '../../synthetic.ts';
import { apiCli, setClock } from '../runtime.ts';
import type { DemoWorkplace } from './catalog.ts';
import { demoMobile } from './catalog.ts';
import {
  patientAt,
  person,
  as,
  asPatient,
  patientUpload,
  saveState,
  sleep,
  type Body,
  type Patient,
  type SeedState,
} from './context.ts';
import { linesFor, runLoan, type LoanResult, type Stage } from './loan.ts';
import { secrets } from '../runtime.ts';
import { DEMO, seedTicketTopics } from './settings.ts';
import { startOfHistory } from './index.ts';

const FEMALE = [
  'مریم',
  'زهرا',
  'فاطمه',
  'سارا',
  'نگار',
  'الهام',
  'مینا',
  'لیلا',
  'نرگس',
  'سمیه',
  'پریسا',
  'آزاده',
  'شیما',
  'مهسا',
  'نیلوفر',
  'ریحانه',
  'هدی',
  'کوثر',
  'ساناز',
  'رویا',
];
const MALE = [
  'علی',
  'محمد',
  'رضا',
  'حسین',
  'مهدی',
  'امیر',
  'سعید',
  'کاوه',
  'حمید',
  'مجید',
  'جواد',
  'مصطفی',
  'بهنام',
  'پویا',
  'ایمان',
  'عرفان',
  'سجاد',
  'وحید',
  'یاسر',
  'میلاد',
];
const LAST = [
  'احمدی',
  'محمدی',
  'کریمی',
  'رضایی',
  'موسوی',
  'حسینی',
  'جعفری',
  'صادقی',
  'نوری',
  'طاهری',
  'اصفهانی',
  'شریفی',
  'یزدانی',
  'فرهادی',
  'قاسمی',
  'رحمانی',
  'سلطانی',
  'باقری',
  'کاظمی',
  'نظری',
  'ابراهیمی',
  'هاشمی',
  'مرادی',
  'زارعی',
  'کاشانی',
  'نصیری',
  'عباسی',
  'شفیعی',
  'خلیلی',
  'امامی',
];
const CITIES = ['اصفهان', 'اصفهان', 'اصفهان', 'کاشان', 'شاهین‌شهر'];

type Repay = 'ontime' | 'late10' | 'stop30' | 'stop60' | 'early' | 'done' | 'none';

interface Plan {
  day: number;
  stopAt: Stage;
  repay: Repay;
  story: string;
  planCode?: string;
  installments?: number;
  guarantor?: boolean;
  promissory?: boolean;
  scale?: number;
  wageOnly?: boolean;
  club?: boolean;
  cap?: boolean;
  cancel?: 'done' | 'pending';
  /** At one of the busy centers (the first FEATURED places), not spread over all of them. */
  featured?: boolean;
}

interface Case extends Plan {
  patient: number;
  guarantorIndex?: number;
  place: number;
  result?: LoanResult;
  error?: string;
  settledEarly?: boolean;
  cancelled?: boolean;
}

/**
 * The busy centers (owner 1405/08/09): center.01 to center.06, whose dashboards, monthly
 * statements and payouts are shown; the rest of the network has a case or two each.
 */
const FEATURED = 6;

/** The demo's cases: every stage, every repayment story, spread over the six months. */
function plans(): Plan[] {
  const out: Plan[] = [];
  const add = (n: number, days: [number, number], p: Omit<Plan, 'day'>) => {
    for (let i = 0; i < n; i++)
      out.push({ ...p, day: days[0] + Math.floor(((days[1] - days[0]) * i) / Math.max(1, n - 1)) });
  };
  // Funded and repaying, from the first months.
  add(16, [0, 120], { stopAt: 'served', repay: 'ontime', story: 'وام فعال، اقساط به‌موقع' });
  // The busy centers' loans, more each month (2 in the first, 9 in the last), so the charts
  // grow and each of them has a statement and a payout every month; one in five pays late.
  [2, 3, 5, 6, 8, 9].forEach((n, m) => {
    for (let i = 0; i < n; i++)
      out.push({
        day: m * 30 + 2 + Math.floor((26 * i) / Math.max(1, n - 1)),
        stopAt: 'served',
        featured: true,
        ...(i % 5 === 4
          ? { repay: 'late10' as const, story: 'مرکز پرکار، پرداخت با تأخیر حدود ۱۰ روز' }
          : { repay: 'ontime' as const, story: 'وام فعال در مرکز پرکار' }),
      });
  });
  add(5, [3, 60], {
    stopAt: 'served',
    repay: 'done',
    installments: 6,
    story: 'وام تسویه کامل (شش قسط)',
  });
  add(3, [10, 90], { stopAt: 'served', repay: 'early', story: 'تسویه زودهنگام' });
  add(5, [10, 120], { stopAt: 'served', repay: 'late10', story: 'پرداخت با تأخیر حدود ۱۰ روز' });
  add(5, [20, 100], {
    stopAt: 'served',
    repay: 'stop30',
    guarantor: true,
    story: 'معوق ۳۰ روز (ضامن دارد)',
  });
  add(5, [0, 60], {
    stopAt: 'served',
    repay: 'stop60',
    guarantor: true,
    story: 'معوق ۶۰ روز به بالا (ضامن دارد)',
  });
  add(4, [30, 140], { stopAt: 'served', repay: 'ontime', promissory: true, story: 'وثیقه سفته' });
  add(5, [20, 150], {
    stopAt: 'served',
    repay: 'ontime',
    wageOnly: true,
    planCode: 'p07_220012',
    installments: 12,
    story: 'طرح فقط‌دستمزد ۰۷-۲۲۰۰۱۲ (مواد نقد)',
  });
  add(4, [40, 160], {
    stopAt: 'served',
    repay: 'ontime',
    club: true,
    planCode: 'club_six_month',
    installments: 6,
    story: 'عضو باشگاه، طرح شش‌ماهه',
  });
  add(1, [50, 50], {
    stopAt: 'served',
    repay: 'ontime',
    cap: true,
    scale: 3,
    story: 'نزدیک سقف ۱٫۵ میلیارد مانده',
  });
  add(3, [60, 170], { stopAt: 'funded', repay: 'ontime', story: 'کیف شارژشده، خدمت نگرفته' });
  add(2, [90, 165], {
    stopAt: 'funded',
    repay: 'none',
    cancel: 'done',
    story: 'انصراف پس از شارژ، خسارت ۱۸٪',
  });
  add(1, [175, 175], {
    stopAt: 'funded',
    repay: 'none',
    cancel: 'pending',
    story: 'انصراف در انتظار تأیید دوم',
  });
  // In progress, the last weeks.
  add(3, [170, 180], {
    stopAt: 'funding_requested',
    repay: 'none',
    story: 'درخواست شارژ در انتظار تأیید',
  });
  add(3, [168, 180], {
    stopAt: 'receipts_pending',
    repay: 'none',
    story: 'فیش پیش‌پرداخت در انتظار تأیید حسابداری',
  });
  add(3, [165, 180], {
    stopAt: 'contract_accepted',
    repay: 'none',
    story: 'قرارداد پذیرفته، تکمیل پرونده در جریان',
  });
  add(3, [160, 180], { stopAt: 'approved', repay: 'none', story: 'تأییدشده، منتظر قرارداد' });
  add(3, [170, 181], {
    stopAt: 'decision_proposed',
    repay: 'none',
    story: 'تصمیم پیشنهادشده، منتظر تأیید مدیر اعتبار',
  });
  add(4, [165, 181], { stopAt: 'ready_for_review', repay: 'none', story: 'در صف کارشناسی اعتبار' });
  add(4, [170, 182], {
    stopAt: 'submitted',
    repay: 'none',
    story: 'ارسال‌شده، تکمیل مدارک در جریان',
  });
  add(8, [20, 175], { stopAt: 'rejected', repay: 'none', story: 'ردشده' });
  add(4, [172, 182], { stopAt: 'draft', repay: 'none', story: 'پرونده پیش‌نویس' });
  add(5, [150, 182], { stopAt: 'proforma', repay: 'none', story: 'پیش‌فاکتور تأییدشده' });
  // The busy centers' appointments of today and the coming week.
  add(8, [176, 182], {
    stopAt: 'confirmed',
    repay: 'none',
    featured: true,
    story: 'نوبت تأییدشده',
  });
  add(6, [178, 182], {
    stopAt: 'booked',
    repay: 'none',
    featured: true,
    story: 'نوبت درخواست‌شده (منتظر مرکز)',
  });
  return out;
}

export function makePatients(state: SeedState, n: number) {
  demoMobile(2000);
  while (state.patients.length < n) {
    const female = randomInt(10) < 4;
    const first = (female ? FEMALE : MALE)[randomInt(20)] ?? 'علی';
    const last = LAST[randomInt(LAST.length)] ?? 'احمدی';
    state.patients.push({
      mobile: demoMobile(2000 + state.patients.length),
      name: `${first} ${last}`,
      nationalId: nationalId(),
      city: CITIES[randomInt(CITIES.length)] ?? 'اصفهان',
      female,
      lastCode: '',
    });
  }
}

const DAY = 86_400_000;
const jalaliMonthOf = (d: Date) => {
  const j = toJalali(d);
  return `${String(j.year)}-${String(j.month)}`;
};

async function pay(state: SeedState, c: Case, until: (dueOn: string) => boolean, issues: string[]) {
  const patient = patientAt(state, c.patient);
  const code = secrets().patientCode;
  const schedules = (await asPatient(
    patient,
    code,
    'GET',
    `/me/repayment/schedules?creditApplicationId=${String(c.result?.applicationId)}`,
  )) as unknown as {
    id: string;
    outstandingRial: string;
    installments: {
      id: string;
      dueOn: string;
      outstandingRial: string;
      status: string;
      index: number;
    }[];
  }[];
  const schedule = schedules.find((s) => s.installments.length > 0);
  if (!schedule) return;
  const owed = schedule.installments.filter(
    (i) => BigInt(i.outstandingRial) > 0n && until(i.dueOn),
  );
  for (const inst of owed) {
    // The slip's picture comes with it, as the patient sends it from the page.
    const receipt = await patientUpload(patient, code, '/me/repayment/receipts', {
      scheduleId: schedule.id,
      amountRial: inst.outstandingRial,
      paidOn: new Date().toISOString().slice(0, 10),
      bankRef: `DEMO${String(Date.now()).slice(-7)}${String(inst.index)}`,
      payerName: patient.name,
    });
    try {
      await as(
        person(state, randomInt(2) === 0 ? 'acc1' : 'acc2'),
        'POST',
        `/repayment/payments/${String(receipt['paymentId'])}/approve`,
        { reason: 'فیش با صورت‌حساب بانک تطبیق شد' },
      );
    } catch (error) {
      issues.push(`تأیید فیش قسط ${patient.mobile}: ${(error as Error).message.slice(0, 200)}`);
    }
  }
}

/** The month's statements reviewed by one and approved by another; their payouts paid. */
async function settleStatements(state: SeedState, issues: string[], leaveLast: boolean) {
  const list = (await as(
    person(state, 'acc1'),
    'GET',
    '/settlement/statements?status=draft',
  )) as unknown;
  const items = (
    Array.isArray(list) ? list : (((list as Body)['items'] as Body[] | undefined) ?? [])
  ) as Body[];
  for (const s of items) {
    if (s['status'] !== 'draft') continue;
    try {
      // Today's: half reviewed, waiting for the second person; half still drafts.
      if (leaveLast && items.indexOf(s) % 2 === 1) continue;
      await as(person(state, 'acc1'), 'POST', `/settlement/statements/${String(s['id'])}/review`);
      if (leaveLast) continue;
      await as(person(state, 'acc2'), 'POST', `/settlement/statements/${String(s['id'])}/approve`);
    } catch (error) {
      issues.push(`صورت‌وضعیت ${String(s['id'])}: ${(error as Error).message.slice(0, 200)}`);
    }
  }
  if (leaveLast) return;
  const payouts = (await as(
    person(state, 'acc1'),
    'GET',
    '/settlement/payouts?status=issued',
  )) as unknown;
  const pending = (
    (Array.isArray(payouts)
      ? payouts
      : (((payouts as Body)['items'] as Body[] | undefined) ?? [])) as Body[]
  ).filter((x) => x['status'] === 'issued');
  if (pending.length === 0) return;
  try {
    await as(person(state, 'acc1'), 'POST', '/settlement/payouts/export', {
      payoutIds: pending.map((x) => String(x['id'])),
    });
    for (const x of pending) {
      await as(person(state, 'acc2'), 'POST', `/settlement/payouts/${String(x['id'])}/tracking`, {
        bankTrackingRef: `PAYA${String(randomInt(10_000_000, 99_999_999))}`,
        paidOn: new Date().toISOString().slice(0, 10),
      });
      await as(
        person(state, 'acc1'),
        'POST',
        `/settlement/payouts/${String(x['id'])}/confirm`,
      ).catch(() => undefined);
    }
  } catch (error) {
    issues.push(`پرداخت پزشکان: ${(error as Error).message.slice(0, 200)}`);
  }
}

/** A new patient recorded by an advisor first, with their name, as every case begins. */
export async function introduce(state: SeedState, patient: Patient, place: DemoWorkplace) {
  await as(person(state, randomInt(2) === 0 ? 'advisor1' : 'advisor2'), 'POST', '/lead/intakes', {
    mobile: `0${patient.mobile}`,
    name: patient.name,
    nationalId: patient.nationalId,
    cityCode: 'isfahan',
    treatmentFieldCode: place.fieldCodes[0],
    smsConsent: true,
    note: `${DEMO}: ${patient.city}`,
  });
}

/** One ticket each to every unit, in turn: who opens it, its topic and its words. */
const UNIT_TICKETS: {
  topicCode: string;
  by: 'patient' | 'center';
  subject: string;
  body: string;
  worker: string;
}[] = [
  {
    topicCode: 'installment',
    by: 'patient',
    subject: 'جابه‌جایی روز پرداخت قسط',
    body: 'حقوق من دهم هر ماه واریز می‌شود؛ امکان جابه‌جایی سررسید هست؟',
    worker: 'coll1',
  },
  {
    topicCode: 'payment',
    by: 'patient',
    subject: 'فیش پرداخت هنوز تأیید نشده',
    body: 'فیش قسط را سه روز پیش فرستادم و هنوز در انتظار است.',
    worker: 'acc1',
  },
  {
    topicCode: 'statement',
    by: 'center',
    subject: 'پرسش درباره صورت‌وضعیت ماه قبل',
    body: 'یک خدمت ثبت‌شده در صورت‌وضعیت ماه قبل دیده نمی‌شود؛ لطفاً بررسی کنید.',
    worker: 'acc2',
  },
  {
    topicCode: 'center_onboarding',
    by: 'center',
    subject: 'افزودن شعبه دوم مرکز',
    body: 'می‌خواهیم شعبه دوم مرکز را هم در سامانه فعال کنیم.',
    worker: 'netspec1',
  },
  {
    topicCode: 'documents',
    by: 'patient',
    subject: 'بارگذاری گواهی اشتغال',
    body: 'گواهی اشتغال را از کجا بارگذاری کنم؟',
    worker: 'comp1',
  },
  {
    topicCode: 'credit_question',
    by: 'patient',
    subject: 'سقف اعتبار من چقدر است؟',
    body: 'برای درمان دوم چقدر اعتبار می‌توانم بگیرم؟',
    worker: 'credspec1',
  },
  {
    topicCode: 'advice',
    by: 'patient',
    subject: 'انتخاب طرح مناسب',
    body: 'بین طرح شش‌ماهه و دوازده‌ماهه کدام برای من بهتر است؟',
    worker: 'advisor1',
  },
  {
    topicCode: 'complaint_doctor',
    by: 'patient',
    subject: 'تأخیر طولانی در زمان نوبت',
    body: 'یک ساعت و نیم بیشتر از زمان نوبت منتظر ماندم.',
    worker: 'support1',
  },
];

/**
 * Two tickets of the day, the next ones of UNIT_TICKETS in turn: one in three answered and
 * resolved by the unit, one in three answered and waiting, one in three left new.
 */
async function ticketsOfDay(state: SeedState, cases: Case[], day: number, issues: string[]) {
  const done = ((state.data['ticketDays'] as number[] | undefined) ??= []);
  if (done.includes(day)) return;
  const served = cases.filter((c) => c.result?.purseId && !c.cancelled);
  const places = state.data['places'] as DemoWorkplace[];
  const count = Number(state.data['unitTickets'] ?? 0);
  for (let k = count; k < count + 2; k++) {
    const t = UNIT_TICKETS[k % UNIT_TICKETS.length];
    const c = served[(k * 5) % Math.max(1, served.length)];
    if (!t || !c) continue;
    const body = { topicCode: t.topicCode, subject: t.subject, body: t.body, links: [] };
    try {
      const ticket =
        t.by === 'patient'
          ? await asPatient(
              patientAt(state, c.patient),
              secrets().patientCode,
              'POST',
              '/me/tickets',
              body,
            )
          : await as(
              person(state, places[c.place]?.managerKey ?? 'center1'),
              'POST',
              '/panel/tickets',
              body,
            );
      if (k % 3 === 2) continue;
      // The unit member the queue gave it to, else the first of the unit.
      const id = String(ticket['id']);
      const seen = await as(person(state, t.worker), 'GET', `/tickets/${id}`).catch(
        (): Body => ({}),
      );
      const worker =
        Object.values(state.people).find((p) => p.accountId === seen['assigneeAccountId']) ??
        person(state, t.worker);
      await as(worker, 'POST', `/tickets/${id}/status`, {
        to: 'in_progress',
        note: 'در حال بررسی',
      });
      await as(worker, 'POST', `/tickets/${id}/messages`, {
        body: 'سلام، درخواست شما دریافت و بررسی شد.',
        visibility: 'public',
      });
      await as(worker, 'POST', `/tickets/${id}/status`, {
        to: k % 3 === 0 ? 'resolved' : 'waiting_on_requester',
        note: k % 3 === 0 ? 'پاسخ داده شد' : 'منتظر پاسخ درخواست‌دهنده',
      });
    } catch (error) {
      issues.push(`تیکت ${t.topicCode}: ${(error as Error).message.slice(0, 200)}`);
    }
  }
  state.data['unitTickets'] = count + 2;
  done.push(day);
  saveState(state);
}

export async function seedTimeline(state: SeedState) {
  const places = state.data['places'] as DemoWorkplace[];
  const issues = ((state.data['issues'] as string[] | undefined) ??= []);
  const cases = ((state.data['cases'] as Case[] | undefined) ??= []);
  if (cases.length === 0) {
    const all = plans();
    makePatients(state, all.length + all.filter((x) => x.guarantor).length + 20);
    let next = 0;
    let busy = 0;
    for (const [i, plan] of all.entries()) {
      const c: Case = {
        ...plan,
        patient: next++,
        place: plan.featured ? busy++ % Math.min(FEATURED, places.length) : i % places.length,
      };
      // The wage-only plan is for beauty and skin; the cap case for the most expensive work.
      if (plan.wageOnly)
        c.place = places.findIndex(
          (w, k) =>
            k >= i % places.length && w.fieldCodes.some((f) => f === 'beauty' || f === 'skin_hair'),
        );
      if (plan.cap || c.place < 0)
        c.place = places.findIndex((w) => w.fieldCodes.includes('beauty'));
      if (plan.guarantor) c.guarantorIndex = next++;
      cases.push(c);
    }
    cases.sort((a, b) => a.day - b.day);
    saveState(state);
  }
  const start = startOfHistory().getTime();
  const lastDay = 183;
  let day = Number(state.data['timelineDay'] ?? -3) + 3;
  let month = jalaliMonthOf(new Date(start + day * DAY));
  for (; day <= lastDay; day += 3) {
    // Forward only: never before where the clock already is (TOTP steps, sessions, order).
    const at = new Date(Math.max(start + day * DAY, Date.now() + 60_000));
    await setClock(at);
    // Kept before any work: a stopped run never sends the clock back behind what was signed.
    state.data['clockAt'] = at.getTime();
    saveState(state);
    // The worker's nightly jobs of the day just passed run on the moved clock.
    await sleep(8000);
    const nowMonth = jalaliMonthOf(at);
    if (nowMonth !== month) {
      month = nowMonth;
      await settleStatements(state, issues, false).catch((e: unknown) =>
        issues.push(`ماه ${nowMonth}: ${(e as Error).message.slice(0, 200)}`),
      );
    }
    // New cases of the day (an advisor records each patient first, with their name).
    for (const c of cases.filter((x) => x.day > day - 3 && x.day <= day && !x.result && !x.error)) {
      const patient = patientAt(state, c.patient);
      patient.story = c.story;
      const place = places[c.place];
      if (!place) continue;
      try {
        await introduce(state, patient, place);
        if (c.club) {
          await as(person(state, 'club'), 'POST', '/lead/club-memberships', {
            mobile: `0${patient.mobile}`,
            startsOn: new Date().toISOString().slice(0, 10),
            endsOn: new Date(Date.now() + 365 * DAY).toISOString().slice(0, 10),
            reason: `${DEMO}: عضویت باشگاه مشتریان`,
          });
        }
        const guarantor =
          c.guarantorIndex !== undefined ? state.patients[c.guarantorIndex] : undefined;
        if (guarantor) guarantor.story = `ضامن ${patient.name}`;
        c.result = await runLoan(state, {
          patient,
          place,
          stopAt: c.stopAt,
          ...(c.planCode ? { planCode: c.planCode } : {}),
          ...(c.installments ? { installments: c.installments } : {}),
          ...(guarantor ? { guarantor } : {}),
          ...(c.promissory ? { promissory: true } : {}),
          // Near the 1.5B cap: a 1.4B operation, its loan and spread fee about 1.4B outstanding.
          lines: c.cap
            ? [{ serviceCode: 'beauty_rhinoplasty', unitRial: 1_400_000_000 }]
            : linesFor(
                place,
                c.stopAt === 'rejected'
                  ? 'low'
                  : c.guarantor
                    ? randomInt(2) === 0
                      ? 'medium'
                      : 'high'
                    : c.planCode === 'club_six_month'
                      ? 'low'
                      : undefined,
                c.wageOnly === true,
              ),
        });
      } catch (error) {
        c.error = (error as Error).message.slice(0, 300);
        issues.push(`پرونده «${c.story}» (${patient.mobile}): ${c.error}`);
      }
    }
    // Repayments, as each borrower's story says.
    const todayIso = at.toISOString().slice(0, 10);
    const daysAgo = (n: number) => new Date(at.getTime() - n * DAY).toISOString().slice(0, 10);
    for (const c of cases.filter((x) => x.result?.purseId && !x.cancelled && !x.settledEarly)) {
      const age = day - c.day;
      try {
        if (c.repay === 'ontime' || c.repay === 'done')
          await pay(state, c, (due) => due <= todayIso, issues);
        else if (c.repay === 'late10') await pay(state, c, (due) => due <= daysAgo(10), issues);
        else if (c.repay === 'stop30' && lastDay - day > 40)
          await pay(state, c, (due) => due <= todayIso, issues);
        else if (c.repay === 'stop60' && lastDay - day > 75)
          await pay(state, c, (due) => due <= todayIso, issues);
        else if (c.repay === 'early') {
          if (age >= 60) {
            await pay(state, c, () => true, issues);
            c.settledEarly = true;
          } else await pay(state, c, (due) => due <= todayIso, issues);
        }
      } catch (error) {
        issues.push(
          `بازپرداخت ${patientAt(state, c.patient).mobile}: ${(error as Error).message.slice(0, 200)}`,
        );
      }
      // A cancellation after funding, decided by two in finance (scenario 12).
      if (c.cancel && !c.cancelled && age >= 6) {
        try {
          // After funding the cancellation is a special operation of the purse (scenario 12).
          const asked = await as(person(state, 'acc1'), 'POST', '/wallet/special-operations', {
            kind: 'cancel_after_funding',
            purseId: c.result?.purseId,
            reason: `${DEMO}: انصراف بیمار پس از شارژ`,
          });
          if (c.cancel === 'done')
            await as(
              person(state, 'acc2'),
              'POST',
              `/wallet/special-operations/${String(asked['id'])}/approve`,
              { reason: 'انصراف با خسارت ۱۸٪ طبق قرارداد' },
            );
          c.cancelled = true;
        } catch (error) {
          issues.push(
            `انصراف ${patientAt(state, c.patient).mobile}: ${(error as Error).message.slice(0, 200)}`,
          );
          c.cancelled = true;
        }
      }
    }
    // The last two weeks' tickets, to every unit: some answered, some still open (overdue by
    // today, the units' warnings).
    if (lastDay - day <= 15) await ticketsOfDay(state, cases, day, issues);
    state.data['timelineDay'] = day;
    state.data['clockAt'] = Date.now();
    saveState(state);
    console.log(
      `seed: روز ${String(day)} از ${String(lastDay)} (${String(cases.filter((x) => x.result).length)} پرونده، ${String(issues.length)} ایراد)`,
    );
  }
  // Today: the last month's statements reviewed by one, waiting for the second (in progress).
  await setClock('real');
  await sleep(8000);
  await seedTicketTopics(state).catch((e: unknown) =>
    issues.push(`موضوع‌های تیکت امروز: ${(e as Error).message.slice(0, 200)}`),
  );
  await settleStatements(state, issues, true).catch((e: unknown) =>
    issues.push(`صورت‌وضعیت پایانی: ${(e as Error).message.slice(0, 200)}`),
  );
  // The collection cycle of today, so the queue shows today's overdue.
  try {
    apiCli('dist/modules/collection/cli/run-cycle.js');
  } catch (error) {
    issues.push(`چرخه وصول: ${(error as Error).message.slice(0, 200)}`);
  }
  const { seedInProgress } = await import('./in-progress.ts');
  await seedInProgress(state, cases as unknown as Body[], issues);
  saveState(state);
}

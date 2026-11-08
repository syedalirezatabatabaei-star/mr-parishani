import { expect, test, type Browser, type Page } from '@playwright/test';
import { addJalaliDays, formatJalaliDate, toJalali } from '@sepehr/contracts';
import { STACK, type SeededStaff } from '../src/stack-config.ts';
import { nationalId } from '../src/synthetic.ts';
import {
  fixture,
  newMobile,
  nonJalaliDates,
  patientLogin,
  staffLogin,
  signedPost,
} from './support.ts';

/**
 * The internal panel (task 2-11, part 4), on its own origin: the center review queue with
 * an activation that one person proposes and another approves (doc 08 §15 test 8), the
 * profile review queue (nothing public before approval), the holidays (Isfahan's own, the
 * pilot city), and the Excel import page. Jalali dates only, everywhere.
 */
const admin = (path: string) => `${STACK.adminUrl}${path}`;

async function signedIn(browser: Browser, who: SeededStaff, path: string): Promise<Page> {
  const page = await (await browser.newContext()).newPage();
  await page.goto(admin(`/login?next=${encodeURIComponent(path)}`));
  await expect(page.getByRole('heading', { name: 'ورود به پنل داخلی' })).toBeVisible();
  await staffLogin(page, who);
  await expect(page).toHaveURL(admin(path));
  return page;
}

test('a center under review: documents checked, activation proposed by one, approved by another', async ({
  browser,
}) => {
  const { specialist, approver, networkManager, reviewCenterName, reviewCenterId } = fixture();
  const page = await signedIn(browser, specialist, '/centers');
  await expect(page.getByRole('heading', { level: 1, name: 'بررسی مراکز' })).toBeVisible();
  // The queue: under review by default.
  await page.getByRole('link', { name: reviewCenterName }).click();
  await expect(page).toHaveURL(admin(`/centers/${reviewCenterId}`));
  await expect(page.getByText('در حال بررسی', { exact: true })).toBeVisible();
  expect(await nonJalaliDates(page), 'center review').toEqual([]);

  // Activation needs every document checked first.
  const verify = page.getByRole('button', { name: 'تأیید مدرک' });
  const documents = await verify.count();
  expect(documents).toBeGreaterThan(0);
  for (let left = documents; left > 0; left--) {
    await verify.first().click();
    // The page is read again after each change: one button fewer.
    await expect(verify).toHaveCount(left - 1);
  }

  // A network manager (who could approve an activation) proposes it…
  const proposer = await signedIn(browser, approver, `/centers/${reviewCenterId}`);
  await proposer.getByRole('button', { name: 'پیشنهاد فعال‌سازی' }).click();
  await proposer.getByLabel('دلیل', { exact: true }).fill('مدارک کامل و تأییدشده');
  await proposer.getByRole('button', { name: 'پیشنهاد فعال‌سازی' }).click();
  await expect(proposer.getByText('پیشنهاد ثبت شد؛ نفر دوم باید تأیید کند.')).toBeVisible();
  await expect(proposer.getByText('در انتظار نفر دوم')).toBeVisible();

  // …but cannot approve their own proposal (doc 08 §15 test 8)…
  await proposer.getByRole('button', { name: 'تأیید درخواست' }).click();
  await expect(
    proposer.getByText('این درخواست را باید شخص دیگری جز پیشنهاددهنده تأیید کند.'),
  ).toBeVisible();

  // …and the specialist, who reviews but does not approve activations, cannot either.
  await page.reload();
  await page.getByRole('button', { name: 'تأیید درخواست' }).click();
  await expect(page.getByText('اجازه این کار را ندارید.')).toBeVisible();

  // A second network manager approves; the center is active.
  const second = await signedIn(browser, networkManager, `/centers/${reviewCenterId}`);
  await second.getByRole('button', { name: 'تأیید درخواست' }).click();
  await expect(second.getByText('درخواست تأیید شد.')).toBeVisible();
  await expect(second.getByText('فعال', { exact: true })).toBeVisible();
  expect(await nonJalaliDates(second), 'activated center').toEqual([]);
});

test('a profile in review is not public until the specialist publishes it', async ({
  browser,
  page,
}) => {
  const { specialist, reviewDoctorName, reviewDoctorId, reviewSlug } = fixture();
  expect((await page.goto(`/doctors/${reviewSlug}`))?.status()).toBe(404);

  const reviewer = await signedIn(browser, specialist, '/profiles');
  await reviewer.getByRole('link', { name: reviewDoctorName }).click();
  await expect(reviewer).toHaveURL(admin(`/profiles/${reviewDoctorId}`));
  const submitted = reviewer.getByRole('region', { name: 'نسخه ارسال‌شده' });
  await expect(submitted).toContainText('متخصص دندانپزشکی کودکان');
  await expect(submitted).toContainText('درمان دندان کودکان با رویکرد بی‌درد.');
  expect(await nonJalaliDates(reviewer), 'profile review').toEqual([]);
  await reviewer.getByLabel('دلیل', { exact: true }).fill('محتوا با قواعد نظام پزشکی همخوان است');
  await reviewer.getByRole('button', { name: 'انتشار' }).click();
  await expect(reviewer.getByText('پروفایل منتشر شد.')).toBeVisible();

  const published = await page.goto(`/doctors/${reviewSlug}`);
  expect(published?.status()).toBe(200);
  await expect(page.getByRole('heading', { level: 1, name: reviewDoctorName })).toBeVisible();
  await reviewer.goto(admin('/profiles'));
  await expect(reviewer.getByRole('link', { name: reviewDoctorName })).toHaveCount(0);
});

test("Isfahan's own holiday: asked in Jalali, approved by a second admin, shown on the booking calendar, removed by two", async ({
  browser,
}) => {
  const { admin: sysadmin, admin2, workplaceId } = fixture();
  const page = await signedIn(browser, sysadmin, '/holidays');
  await expect(page.getByRole('heading', { level: 1, name: 'تعطیلات' })).toBeVisible();
  // A day in the pilot's bookable future: thirty days from today, typed in English digits.
  const day = addJalaliDays(toJalali(new Date()), 30);
  const typed = formatJalaliDate(day, { digits: 'latn' });
  await page.getByLabel('روز', { exact: true }).fill(typed);
  await page.getByLabel('روز', { exact: true }).press('Enter');
  await page.getByLabel('عنوان').fill('تعطیلی محلی آزمون اصفهان');
  await page.getByLabel('شهر').last().selectOption({ label: 'اصفهان' });
  await page.getByLabel('دلیل', { exact: true }).fill('مصوبه استانداری اصفهان');
  // Owner 1405/07/27: no single-day path; a one-day batch, saved once a second admin approves.
  await page.getByRole('button', { name: 'درخواست ثبت (با تأیید نفر دوم)' }).click();
  await expect(page.getByText('درخواست ثبت شد. نفر دوم باید آن را تأیید کند.')).toBeVisible();
  await page.reload();
  await expect(page.getByText('درخواست شما؛ نفر دیگری باید تأیید کند')).toBeVisible();

  const second = await signedIn(browser, admin2, '/holidays');
  const batch = second.locator('article', { hasText: 'مصوبه استانداری اصفهان' });
  await batch.getByRole('button', { name: 'تأیید و ذخیره همه' }).click();
  await expect(batch).toHaveCount(0);

  await page.goto(admin(`/holidays?year=${String(day.year)}&city=isfahan`));
  const row = page.getByRole('row', { name: /تعطیلی محلی آزمون اصفهان/ });
  await expect(row).toContainText('اصفهان');
  expect(await nonJalaliDates(page), 'holidays').toEqual([]);

  // The booking calendar of the Isfahan doctor marks it.
  const patient = await (await browser.newContext()).newPage();
  await patient.goto(`/book/${workplaceId}`);
  await patientLogin(patient, newMobile());
  const marked = patient.locator('[role="grid"] button[aria-label*="تعطیلی محلی آزمون اصفهان"]');
  await expect(patient.getByRole('group', { name: 'روز و ساعت نوبت' })).toBeVisible();
  if ((await marked.count()) === 0) {
    // Thirty days ahead may be next month's.
    await patient.getByRole('button', { name: 'ماه بعد' }).click();
  }
  await expect(marked.first()).toBeAttached();

  // Owner 1405/07/29: taken off again by two people; the asker's request waits for the second.
  await page.reload();
  await row.getByText('درخواست برداشتن', { exact: true }).click();
  await row.getByLabel('دلیل برداشتن').fill('مصوبه استانداری لغو شد');
  await row.getByRole('button', { name: 'درخواست برداشتن (با تأیید نفر دوم)' }).click();
  await expect(row.getByText('در انتظار تأیید برداشتن')).toBeVisible();
  await second.goto(admin(`/holidays?year=${String(day.year)}&city=isfahan`));
  const removal = second.locator('article', { hasText: 'مصوبه استانداری لغو شد' });
  await removal.getByRole('button', { name: 'تأیید و برداشتن' }).click();
  await expect(removal).toHaveCount(0);
  await expect(second.getByRole('row', { name: /تعطیلی محلی آزمون اصفهان/ })).toHaveCount(0);
});

test('the Excel import page: on, with its template', async ({ browser }) => {
  const { specialist } = fixture();
  const page = await signedIn(browser, specialist, '/imports');
  await expect(page.getByRole('heading', { level: 1, name: 'ورود از اکسل' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'بارگذاری فایل' })).toBeVisible();
  const template = await page.request.get(admin('/api/v1/catalog/imports/template'));
  expect(template.status()).toBe(200);
  expect(template.headers()['content-type']).toContain('spreadsheetml');
  await expect(page.getByText('دسته‌ای نیست.')).toBeVisible();
  expect(await nonJalaliDates(page), 'imports').toEqual([]);
});

test('a center and a doctor entered by hand: never without the contract term', async ({
  browser,
}) => {
  const { specialist, centerName } = fixture();
  const page = await signedIn(browser, specialist, '/centers');
  await page.getByRole('link', { name: 'ثبت مرکز تازه' }).click();
  const center = page.getByRole('form', { name: 'ثبت مرکز' });
  const centerTitle = `مرکز ثبت دستی ${String(Date.now()).slice(-6)}`;
  await center.getByLabel('نام مرکز').fill(centerTitle);
  await center.getByLabel('شهر').selectOption({ label: 'اصفهان' });
  await center.getByLabel('نوع شخص').selectOption('natural');
  await center.getByLabel('شناسه ملی یا کد ملی').fill(nationalId());
  // Without the term's first day, nothing is sent.
  await center.getByRole('button', { name: 'ثبت مرکز' }).click();
  await expect(center.getByText('روز شروع قرارداد را انتخاب کنید.')).toBeVisible();
  const first = formatJalaliDate(toJalali(new Date()), { digits: 'latn' });
  await center.getByLabel('روز شروع قرارداد').fill(first);
  await center.getByLabel('روز شروع قرارداد').press('Enter');
  await center.getByLabel('مدت قرارداد').selectOption('6');
  await center.getByRole('button', { name: 'ثبت مرکز' }).click();
  await expect(page.getByRole('heading', { level: 1, name: centerTitle })).toBeVisible();
  expect(await nonJalaliDates(page), 'center page').toEqual([]);

  await page.goto(admin('/doctors/new'));
  const doctor = page.getByRole('form', { name: 'ثبت پزشک' });
  await doctor.getByLabel('نام پزشک').fill('دکتر ثبت دستی آزمون');
  await doctor.getByLabel('شماره نظام پزشکی').fill(String(10_000_000 + (Date.now() % 89_999_999)));
  // The fixture's active center: «center · branch».
  const branch = doctor.getByLabel('شعبه').locator('option', { hasText: centerName }).first();
  await doctor.getByLabel('شعبه').selectOption((await branch.getAttribute('value')) ?? '');
  await doctor.getByLabel('روز شروع قرارداد').fill(first);
  await doctor.getByLabel('روز شروع قرارداد').press('Enter');
  await doctor.getByLabel('دلیل ثبت').fill('ورود دستی داده کارفرما');
  await doctor.getByRole('button', { name: 'ثبت پزشک' }).click();
  await expect(doctor.getByText(/پزشک «دکتر ثبت دستی آزمون» ثبت شد/)).toBeVisible();
});

test('a visit price by two people, and a formation deposit recorded with no ledger row (owner 1405/07/29)', async ({
  browser,
}) => {
  const f = fixture();
  // The visit: proposed by the network specialist, approved by the network manager.
  const proposer = await signedIn(browser, f.specialist, '/visit-tariffs');
  await expect(
    proposer.getByRole('heading', { level: 1, name: 'تعرفه ویزیت پزشکان' }),
  ).toBeVisible();
  const form = proposer.getByRole('form', { name: 'پیشنهاد تعرفه ویزیت' });
  await form.getByLabel('پزشک و محل کار').selectOption(f.workplaceId);
  // Still covering the seed's visit range (5,000,000 to 8,000,000): the later specs issue a
  // visit at 6,000,000 for this doctor (credit-path), so the new version must keep it in range.
  await form.getByLabel('کمینه (ریال)').fill('5000000');
  await form.getByLabel('بیشینه (ریال)').fill('9000000');
  await form.getByLabel('دلیل').fill('تعرفه ویزیت از فهرست الحاقیه');
  await form.getByRole('button', { name: 'پیشنهاد (با تأیید نفر دوم)' }).click();
  await expect(form.getByText('پیشنهاد ثبت شد. نفر دوم باید آن را تأیید کند.')).toBeVisible();
  const queue = proposer.getByRole('table', { name: /در انتظار تأیید/ });
  const mine = queue.getByRole('row', { name: new RegExp(f.doctorName) });
  await expect(mine.getByText('پیشنهاد شما؛ نفر دوم تصمیم می‌گیرد.')).toBeVisible();

  const second = await signedIn(browser, f.networkManager, '/visit-tariffs');
  const row = second
    .getByRole('table', { name: /در انتظار تأیید/ })
    .getByRole('row', { name: new RegExp(f.doctorName) });
  await row.getByLabel('دلیل تصمیم').fill('با فهرست کارفرما یکی است');
  await row.getByRole('button', { name: 'تأیید تعرفه' }).click();
  await expect(
    second.getByRole('table', { name: 'تصمیم‌های اخیر' }).getByRole('row', {
      name: new RegExp(`${f.doctorName}.*تأیید شد`),
    }),
  ).toBeVisible();

  // The deposit: its amount set by two people, then recorded on a case by case completion.
  const strategy = await signedIn(browser, f.strategyA, '/settings');
  const me = (await (await strategy.request.get('/api/v1/auth/me')).json()) as {
    csrfToken: string;
  };
  const proposed = await signedPost(strategy, '/api/v1/config/proposals', {
    headers: { 'x-csrf-token': me.csrfToken, origin: STACK.adminUrl },
    data: {
      key: 'credit.formation_deposit_rial',
      scope: { level: 'global' },
      value: '990000',
      reason: 'بیعانه تشکیل طبق الحاقیه (پایگاه دورریختنی)',
    },
  });
  expect(proposed.status(), await proposed.text()).toBe(201);
  const strategyB = await signedIn(browser, f.strategyB, '/settings');
  const meB = (await (await strategyB.request.get('/api/v1/auth/me')).json()) as {
    csrfToken: string;
  };
  const approved = await signedPost(
    strategyB,
    `/api/v1/config/proposals/${((await proposed.json()) as { id: string }).id}/approve`,
    { headers: { 'x-csrf-token': meB.csrfToken, origin: STACK.adminUrl }, data: {} },
  );
  expect(approved.status(), await approved.text()).toBeLessThan(300);

  const completion = await signedIn(browser, f.completion, `/completion/${f.fundedApplicationId}`);
  const section = completion.getByRole('region', { name: /^بیعانه تشکیل/ });
  await expect(section.getByText(/۹۹۰٬۰۰۰/)).toBeVisible();
  const deposit = section.getByRole('form', { name: 'ثبت بیعانه تشکیل' });
  await deposit.getByLabel('شماره پیگیری بانک').fill('TRK-778899001234');
  await deposit.getByRole('button', { name: 'ثبت بیعانه' }).click();
  await expect(deposit.getByText('روز پرداخت بیعانه را انتخاب کنید.')).toBeVisible();
  const today = formatJalaliDate(toJalali(new Date()), { digits: 'latn' });
  await deposit.getByLabel('روز پرداخت بیعانه').fill(today);
  await deposit.getByLabel('روز پرداخت بیعانه').press('Enter');
  await deposit.getByRole('button', { name: 'ثبت بیعانه' }).click();
  await expect(section.getByText('ثبت شد', { exact: true })).toBeVisible();
  await expect(section.getByText('…1234')).toBeVisible();
  // Funded already: past the introduction letter, so no refund.
  await expect(section.getByText('کیف اعتبار شارژ شده است؛ بیعانه برنمی‌گردد.')).toBeVisible();
  await expect(section.getByRole('form', { name: 'ثبت برگشت بیعانه' })).toHaveCount(0);
});

test('ADR-048: a club membership recorded by the club officer; the origination fee shown locked; the month’s discounts', async ({
  browser,
}) => {
  const f = fixture();
  const club = await signedIn(browser, f.clubOfficer, '/club');
  await expect(club.getByRole('heading', { level: 1, name: 'باشگاه مشتریان' })).toBeVisible();
  const find = club.getByRole('form', { name: 'جست‌وجوی عضو' });
  await find.getByLabel('شماره موبایل').fill(`0${f.settlementPatientMobile}`);
  await find.getByRole('button', { name: 'جست‌وجو' }).click();
  await expect(club).toHaveURL(/\/club\?mobile=/);
  const record = club.getByRole('form', { name: 'ثبت عضویت باشگاه' });
  await record.getByLabel('دلیل').fill('عضو باشگاه مشتریان (پایگاه دورریختنی)');
  await record.getByRole('button', { name: 'ثبت عضویت' }).click();
  const members = club.getByRole('table', { name: 'عضویت‌ها' });
  await expect(members.getByText('عضو امروز')).toBeVisible();

  // A funded case: its origination fee is locked with its receipt; no discount form.
  const completion = await signedIn(browser, f.completion, `/completion/${f.fundedApplicationId}`);
  const fee = completion.getByRole('region', { name: /^هزینه تشکیل پرونده/ });
  await expect(fee.getByText('مبلغ قفل شد')).toBeVisible();
  await expect(fee.getByRole('form', { name: 'ثبت تخفیف مسئول' })).toHaveCount(0);

  const finance = await signedIn(browser, f.finance, '/origination-discounts');
  await expect(
    finance.getByRole('heading', { level: 1, name: 'تخفیف‌های تشکیل پرونده' }),
  ).toBeVisible();
  // The throwaway stack has no discount this month: the list says so (DataTable's empty state).
  await expect(finance.getByText('در این ماه تخفیفی ثبت نشده است.')).toBeVisible();
});

import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { addJalaliDays, formatJalaliDate, toJalali } from '@sepehr/contracts';
import { STACK, STACK_DIR } from '../src/stack-config.ts';
import { nationalId } from '../src/synthetic.ts';
import { fixture, newMobile, otpFor, staffPage, signedPost } from './support.ts';

/**
 * The owner's visual approval of round thirty-one's panel parts (1405/07/29): the center and
 * doctor registration forms with the contract term, a holiday's two-person removal (asked, and
 * the second admin's queue), and the transfer queue's paper number on one line. Only with
 * VISUAL=1; saved to VISUAL_OUT (outside the repository), else .stack/visual-owner-29. The
 * transfer flag is turned on in this throwaway database only, by two system administrators
 * through the API, as the panel would.
 */
const OUT = process.env['VISUAL_OUT'] ?? resolve(STACK_DIR, 'visual-owner-29');

const shot = async (page: Page, name: string) => {
  await page.waitForLoadState('networkidle');
  await page.screenshot({ path: resolve(OUT, `${name}.png`), fullPage: true });
};

test.skip(process.env['VISUAL'] !== '1', 'screenshots only for the owner’s review (VISUAL=1)');

test('screenshots for the owner (1405/07/29)', async ({ browser }) => {
  test.setTimeout(900_000);
  mkdirSync(OUT, { recursive: true });
  const f = fixture();
  const today = formatJalaliDate(toJalali(new Date()), { digits: 'latn' });

  // 1. A center by hand, the term required.
  const specialist = await staffPage(browser, f.specialist, STACK.adminUrl, '/login', '/centers');
  await shot(specialist, 'p29-01-centers-page-register-links');
  await specialist.getByRole('link', { name: 'ثبت مرکز تازه' }).click();
  const center = specialist.getByRole('form', { name: 'ثبت مرکز' });
  await center.getByLabel('نام مرکز').fill('مرکز نمونه برای تأیید بصری');
  await center.getByLabel('شهر').selectOption({ label: 'اصفهان' });
  await center.getByLabel('نوع شخص').selectOption('natural');
  await center.getByLabel('شناسه ملی یا کد ملی').fill(nationalId());
  await center.getByRole('button', { name: 'ثبت مرکز' }).click();
  await expect(center.getByText('روز شروع قرارداد را انتخاب کنید.')).toBeVisible();
  await shot(specialist, 'p29-02-center-form-term-missing');
  await center.getByLabel('روز شروع قرارداد').fill(today);
  await center.getByLabel('روز شروع قرارداد').press('Enter');
  await shot(specialist, 'p29-03-center-form-filled');

  // 2. A doctor by hand.
  await specialist.goto(`${STACK.adminUrl}/doctors/new`);
  const doctor = specialist.getByRole('form', { name: 'ثبت پزشک' });
  await doctor.getByLabel('نام پزشک').fill('دکتر نمونه');
  await doctor.getByLabel('شماره نظام پزشکی').fill('12345678');
  await doctor.getByLabel('روز شروع قرارداد').fill(today);
  await doctor.getByLabel('روز شروع قرارداد').press('Enter');
  await doctor.getByLabel('دلیل ثبت').fill('ورود دستی داده کارفرما');
  await shot(specialist, 'p29-04-doctor-form-filled');

  // 3. A holiday removed by two: asked from its row, then the second admin's queue.
  const day = addJalaliDays(toJalali(new Date()), 40);
  const sysadmin = await staffPage(browser, f.admin, STACK.adminUrl, '/login', '/holidays');
  await sysadmin.getByLabel('روز', { exact: true }).fill(formatJalaliDate(day, { digits: 'latn' }));
  await sysadmin.getByLabel('روز', { exact: true }).press('Enter');
  await sysadmin.getByLabel('عنوان').fill('تعطیلی نمونه برای برداشتن');
  await sysadmin.getByLabel('دلیل', { exact: true }).fill('نمونه تأیید بصری');
  await sysadmin.getByRole('button', { name: 'درخواست ثبت (با تأیید نفر دوم)' }).click();
  await expect(sysadmin.getByText('درخواست ثبت شد. نفر دوم باید آن را تأیید کند.')).toBeVisible();
  const second = await staffPage(browser, f.admin2, STACK.adminUrl, '/login', '/holidays');
  const batch = second.locator('article', { hasText: 'نمونه تأیید بصری' });
  await batch.getByRole('button', { name: 'تأیید و ذخیره همه' }).click();
  await expect(batch).toHaveCount(0);
  await sysadmin.goto(`${STACK.adminUrl}/holidays?year=${String(day.year)}`);
  const row = sysadmin.getByRole('row', { name: /تعطیلی نمونه برای برداشتن/ });
  await row.getByText('درخواست برداشتن', { exact: true }).click();
  await row.getByLabel('دلیل برداشتن').fill('روز اشتباه وارد شد');
  await shot(sysadmin, 'p29-05-holiday-removal-request');
  await row.getByRole('button', { name: 'درخواست برداشتن (با تأیید نفر دوم)' }).click();
  await expect(row.getByText('در انتظار تأیید برداشتن')).toBeVisible();
  await second.goto(`${STACK.adminUrl}/holidays?year=${String(day.year)}`);
  await expect(second.locator('article', { hasText: 'روز اشتباه وارد شد' })).toBeVisible();
  await shot(second, 'p29-06-holiday-removal-queue-second-admin');

  // 4. The transfer queue: the paper number on one line.
  const proposeFlag = async (page: Page) => {
    const me = (await (await page.request.get('/api/v1/auth/me')).json()) as {
      csrfToken: string;
    };
    const made = await signedPost(page, '/api/v1/config/proposals', {
      headers: { 'x-csrf-token': me.csrfToken, origin: STACK.adminUrl },
      data: {
        key: 'wallet.credit_transfer_enabled',
        scope: { level: 'global' },
        value: true,
        reason: 'تصویر برای تأیید بصری مالک (پایگاه دورریختنی)',
      },
    });
    expect(made.status(), await made.text()).toBe(201);
    return ((await made.json()) as { id: string }).id;
  };
  const proposal = await proposeFlag(sysadmin);
  const me2 = (await (await second.request.get('/api/v1/auth/me')).json()) as {
    csrfToken: string;
  };
  const approved = await signedPost(second, `/api/v1/config/proposals/${proposal}/approve`, {
    headers: { 'x-csrf-token': me2.csrfToken, origin: STACK.adminUrl },
    data: {},
  });
  expect(approved.status(), await approved.text()).toBeLessThan(300);

  const asker = await staffPage(
    browser,
    f.finance,
    STACK.adminUrl,
    '/login',
    `/completion/${f.repaymentApplicationId}`,
  );
  const transfer = asker.getByRole('form', { name: 'درخواست انتقال اعتبار' });
  await expect(transfer).toBeVisible();
  const recipientMobile = newMobile();
  await transfer.getByLabel('نام گیرنده').fill('مریم رضایی');
  await transfer.getByLabel('کد ملی گیرنده').fill(nationalId());
  await transfer.getByLabel('موبایل گیرنده').fill(`0${recipientMobile}`);
  await transfer.getByLabel('سقف استفاده گیرنده').fill('1000000');
  await transfer.getByLabel('دلیل').fill('بیمار در سفر است و همسرش درمان را پیگیری می‌کند');
  await transfer.getByLabel('شماره سند کاغذی امضاشده انتقال‌دهنده').fill('P-1405-0729');
  await transfer.getByRole('button', { name: 'ثبت و ارسال کدها' }).click();
  const codes = asker.getByRole('form', { name: 'کدهای انتقال اعتبار' });
  await expect(codes).toBeVisible();
  await codes.getByLabel('کد پیامک‌شده به گیرنده').fill(await otpFor(recipientMobile));
  await codes
    .getByLabel('کد رضایت پیامک‌شده به وام‌گیرنده')
    .fill(await otpFor(f.repaymentPatientMobile));
  await codes.getByRole('button', { name: 'ثبت کدها' }).click();
  await expect(codes).toHaveCount(0);

  const approver = await staffPage(
    browser,
    f.completionFinance,
    STACK.adminUrl,
    '/login',
    '/special-operations',
  );
  const queue = approver.getByRole('table', { name: 'انتقال‌های در انتظار تأیید' });
  await expect(queue).toContainText('P-1405-0729');
  await shot(approver, 'p29-07-transfer-queue-paper-number-one-line');
});

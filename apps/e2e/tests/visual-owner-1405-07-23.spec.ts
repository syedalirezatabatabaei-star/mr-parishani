import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, test, type Browser, type Page } from '@playwright/test';
import { CONTROL_URL, STACK, STACK_DIR } from '../src/stack-config.ts';
import { fixture, patientLogin, patientLoginAfterWait, staffLogin, staffPage } from './support.ts';

/**
 * The owner's visual approval (1405/07/23): the eight earlier images taken again on the current
 * build (pm-01 to pm-06, r1, q3), and the new pages: the masked queue, the decision page with
 * the whole number, the two-person decision, and the credit application's draft. Never part of
 * the acceptance run: only with VISUAL=1. Saved to VISUAL_OUT (outside the repository), else
 * .stack/visual-owner. The two identity flags are switched on last, in this throwaway stack.
 */
const OUT = process.env['VISUAL_OUT'] ?? resolve(STACK_DIR, 'visual-owner');
const PHONE = { width: 390, height: 844 };
const DESKTOP = { width: 1280, height: 720 };

const shot = async (page: Page, name: string) => {
  await page.waitForLoadState('networkidle');
  await page.screenshot({ path: resolve(OUT, `${name}.png`), fullPage: true });
};

/**
 * A patient signed in on a phone-sized page, at «my appointments». `codedBefore`: the seed
 * already sent this mobile a code, so the per-mobile wait is waited out first.
 */
async function patientPage(browser: Browser, mobile: string, codedBefore = true) {
  const page = await (await browser.newContext({ viewport: PHONE })).newPage();
  await page.goto('/me/appointments');
  await (codedBefore ? patientLoginAfterWait(page, mobile) : patientLogin(page, mobile));
  // Signed in, the login sends the patient back here.
  await expect(page.getByRole('heading', { name: 'نوبت‌های من' })).toBeVisible();
  return page;
}

test.skip(process.env['VISUAL'] !== '1', 'screenshots only for the owner’s review (VISUAL=1)');

test('screenshots for the owner (1405/07/23)', async ({ browser }) => {
  test.setTimeout(600_000);
  mkdirSync(OUT, { recursive: true });
  const f = fixture();

  // The Person's owner: two mobiles an advisor added, waiting for them (م۵).
  const owner = await patientPage(browser, f.pendingOwnerMobile);
  await expect(owner.getByText('درخواست افزودن شماره تازه به حساب شما')).toBeVisible();
  await shot(owner, 'pm-01-patient-banner-phone');
  await owner.getByRole('button', { name: 'تأیید', exact: true }).first().click();
  await expect(owner.getByRole('button', { name: 'بله، تأیید می‌کنم' })).toBeVisible();
  await shot(owner, 'pm-02-patient-decision-confirm-phone');
  await owner.getByRole('button', { name: 'انصراف' }).click();
  await owner.setViewportSize(DESKTOP);
  await owner.reload();
  await expect(owner.getByText('درخواست افزودن شماره تازه به حساب شما')).toBeVisible();
  await shot(owner, 'pm-03-patient-banner-desktop');

  // The added mobile's own view: nothing of the Person while it waits.
  const added = await patientPage(browser, f.pendingMobiles[1] ?? '', false);
  await expect(added.getByText('این شماره در انتظار تأیید است')).toBeVisible();
  await shot(added, 'pm-04-pending-mobile-own-view-phone');

  // Staff: the queue by the last four digits; the decision page with the whole number, each
  // view recorded; the first holder proposes, a second approves (م۷).
  const [one, two] = f.mobileApprovers;
  const first = await staffPage(
    browser,
    one ?? f.admin,
    STACK.adminUrl,
    '/login',
    '/person-mobiles',
  );
  await expect(first.getByRole('heading', { name: 'موبایل‌های در انتظار تأیید' })).toBeVisible();
  await shot(first, 'pm-05-admin-pending-queue-masked');
  await first.getByRole('link', { name: 'بررسی و تصمیم' }).first().click();
  await expect(first.getByRole('heading', { name: 'تصمیم درباره موبایل' })).toBeVisible();
  await shot(first, 'm7-01-decision-page-full-number');
  await first.getByRole('button', { name: 'پیشنهاد تأیید با مدرک' }).click();
  await first.getByLabel('دلیل').fill('بیمار حضوری مراجعه کرد');
  await first.getByLabel('مدرکی که دیدید').fill('کارت ملی حضوری، ۱۴۰۵/۰۷/۲۳');
  await shot(first, 'pm-06-admin-decision-form-propose');
  await first.getByRole('button', { name: 'ثبت پیشنهاد' }).click();
  await expect(first.getByRole('button', { name: 'تأیید نفر دوم' })).toBeVisible();
  await shot(first, 'm7-02-proposed-by-first');
  const decision = first.url();
  const second = await staffPage(
    browser,
    two ?? f.admin,
    STACK.adminUrl,
    '/login',
    '/person-mobiles',
  );
  await shot(second, 'm7-03-queue-two-person-column');
  await second.goto(decision);
  await second.getByRole('button', { name: 'تأیید نفر دوم' }).click();
  await second.getByLabel('دلیل').fill('مدرک نفر اول بررسی شد');
  await shot(second, 'm7-04-second-person-approves');

  // A credit application left as a draft: its locked quote, «approximate», the installments.
  const borrower = await patientPage(browser, f.draftPatientMobile);
  await borrower.goto(`/me/credit/${f.draftApplicationId}`);
  await expect(borrower.getByText(/تقریبی/).first()).toBeVisible();
  await shot(borrower, 'draft-01-credit-application-phone');
  await borrower.setViewportSize(DESKTOP);
  await borrower.reload();
  await shot(borrower, 'draft-02-credit-application-desktop');

  // R1: re-authentication for a sensitive action, a wrong code refused.
  expect(
    (await fetch(`${CONTROL_URL}/visual-flag?key=identity.reauth`, { method: 'POST' })).status,
  ).toBe(204);
  const strategy = await staffPage(
    browser,
    f.strategyA,
    STACK.adminUrl,
    '/login',
    '/settlement-rates?key=settlement.credit_service_fee',
  );
  const form = strategy.getByRole('form', { name: 'پیشنهاد نرخ تازه' });
  await form.getByLabel('سطح').selectOption('doctor');
  await form.getByLabel('شناسه گره پزشک').fill(randomUUID());
  await form.getByLabel('نوع نرخ').selectOption('fixed');
  await form.getByLabel('مبلغ (ریال)').fill('150000');
  await form.getByLabel('دلیل تغییر').fill('بررسی بازاحراز');
  await form.getByRole('button', { name: 'ثبت پیشنهاد' }).click();
  const dialog = strategy.getByRole('dialog', { name: 'تأیید هویت' });
  await expect(dialog).toBeVisible();
  await dialog.getByLabel('کد تأیید').fill('000000');
  await dialog.getByRole('button', { name: 'تأیید' }).click();
  await expect(dialog.getByText('کد واردشده درست نیست یا منقضی شده است.')).toBeVisible();
  await shot(strategy, 'r1-reauth-wrong');

  // Question 3: a staff member without a proved mobile proves one before anything else.
  expect(
    (
      await fetch(`${CONTROL_URL}/visual-flag?key=identity.staff_mobile_required`, {
        method: 'POST',
      })
    ).status,
  ).toBe(204);
  const support = await (await browser.newContext({ baseURL: STACK.adminUrl })).newPage();
  await support.goto('/login');
  await staffLogin(support, f.support);
  await expect(support.getByRole('heading', { name: 'تأیید موبایل حساب' })).toBeVisible();
  await shot(support, 'q3-required-mobile');
});

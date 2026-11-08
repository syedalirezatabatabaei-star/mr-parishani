import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { STACK, STACK_DIR } from '../src/stack-config.ts';
import { fixture, newMobile, staffPage } from './support.ts';

/**
 * The owner's visual approval of the four pages of 1405/07/24: roles and access, the
 * advisor's leads, the settings and the lead assignment. Never part of the acceptance run:
 * only with VISUAL=1. Saved to VISUAL_OUT (outside the repository), else .stack/visual-owner.
 * Nothing is changed beyond what the acceptance specs of these pages already do.
 */
const OUT = process.env['VISUAL_OUT'] ?? resolve(STACK_DIR, 'visual-owner');
const PHONE = { width: 390, height: 844 };

const shot = async (page: Page, name: string) => {
  await page.waitForLoadState('networkidle');
  await page.screenshot({ path: resolve(OUT, `${name}.png`), fullPage: true });
};

test.skip(process.env['VISUAL'] !== '1', 'screenshots only for the owner’s review (VISUAL=1)');

test('screenshots for the owner (1405/07/24)', async ({ browser }) => {
  test.setTimeout(600_000);
  mkdirSync(OUT, { recursive: true });
  const { admin, advisor, support, strategyA, collectionAgent } = fixture();

  // Roles and access: the roles table, then one account found by username.
  const access = await staffPage(browser, admin, STACK.adminUrl, '/login', '/access');
  await expect(access.getByRole('heading', { level: 1, name: 'نقش‌ها و دسترسی‌ها' })).toBeVisible();
  await shot(access, 'p24-01-access-roles');
  const account = access.getByRole('region', { name: 'دسترسی یک حساب' });
  await account.getByLabel('نام کاربری کارمند یا مرکز').fill(support.username);
  await account.getByRole('button', { name: 'یافتن' }).click();
  await expect(account.getByText(support.username, { exact: true })).toBeVisible();
  await shot(access, 'p24-02-access-account');

  // The advisor's leads: the list, a lead entered by hand, its case; and on a phone.
  const leads = await staffPage(browser, advisor, STACK.adminUrl, '/login', '/leads');
  await expect(leads.getByRole('heading', { level: 1, name: 'سرنخ‌ها و پرونده‌ها' })).toBeVisible();
  await shot(leads, 'p24-03-leads-list');
  const intake = leads.getByRole('region', { name: 'ثبت سرنخ' });
  await intake.getByLabel('موبایل').fill(`0${newMobile()}`);
  await intake.getByLabel('نام', { exact: true }).fill('بیمار نمونه تصویر');
  await intake.getByLabel('رشته درمان').selectOption('dental');
  await intake.getByLabel('شهر').selectOption('isfahan');
  await intake.getByRole('button', { name: 'ثبت سرنخ' }).click();
  await expect(intake.getByText('سرنخ تازه.')).toBeVisible();
  await shot(leads, 'p24-04-leads-intake-done');
  await intake.getByRole('link', { name: 'باز کردن پرونده' }).click();
  await expect(leads.getByRole('heading', { level: 1, name: 'بیمار نمونه تصویر' })).toBeVisible();
  await shot(leads, 'p24-05-lead-case');
  await leads.setViewportSize(PHONE);
  await leads.reload();
  await expect(leads.getByRole('heading', { level: 1, name: 'بیمار نمونه تصویر' })).toBeVisible();
  await shot(leads, 'p24-06-lead-case-phone');

  // Settings: a flag key in force, and a booking key.
  const settings = await staffPage(
    browser,
    admin,
    STACK.adminUrl,
    '/login',
    '/settings?key=identity.factor_change_sms',
  );
  await expect(
    settings.getByRole('heading', { level: 1, name: 'تنظیمات هویت، سرنخ، نوبت و پیامک' }),
  ).toBeVisible();
  await shot(settings, 'p24-07-settings-flag');
  const booking = await staffPage(
    browser,
    strategyA,
    STACK.adminUrl,
    '/login',
    '/settings?key=booking.hold_minutes',
  );
  await expect(booking.getByLabel('دلیل تغییر')).toBeVisible();
  await shot(booking, 'p24-08-settings-booking');

  // Assignment: the advisory queue, then a new queue with two agents (as assignment.spec).
  const assignment = await staffPage(browser, strategyA, STACK.adminUrl, '/login', '/assignment');
  await expect(
    assignment.getByRole('heading', { level: 1, name: 'تخصیص سرنخ و پرونده' }),
  ).toBeVisible();
  await shot(assignment, 'p24-09-assignment');
  const queue = `vis_${String(Date.now()).slice(-8)}`;
  const editing = await staffPage(
    browser,
    strategyA,
    STACK.adminUrl,
    '/login',
    `/assignment?other=${queue}`,
  );
  await expect(editing.getByText('این صف هنوز سهمی ندارد.')).toBeVisible();
  const editor = editing.getByRole('region', { name: 'سهم‌های تازه' });
  const percents = editor.getByRole('list', { name: 'سهم کارشناسان' }).getByRole('textbox');
  for (const [i, agent] of [support, collectionAgent].entries()) {
    await editor.getByLabel('نام کاربری کارشناس').fill(agent.username);
    await editor.getByRole('button', { name: 'افزودن کارشناس' }).click();
    await expect(percents).toHaveCount(i + 1);
  }
  await percents.nth(0).fill('60');
  await percents.nth(1).fill('40');
  await expect(editor.getByText('جمع: ۱۰۰ از ۱۰۰')).toBeVisible();
  await shot(editing, 'p24-10-assignment-editor');
});

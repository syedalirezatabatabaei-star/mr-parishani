import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import { STACK } from '../src/stack-config.ts';
import { checkPage } from './credit-steps.ts';
import { fixture, staffPage } from './support.ts';

/**
 * Task 5-7 (doc 06 §7; doc 14 5-7; owner 5.5): accounting's settlement pages. The queue and
 * the reports read Jalali only; the Odoo mapping is set from the panel; a month's export is
 * a file the browser saves, with an ISO date column for Odoo and a Jalali one beside it.
 * (A statement itself cannot be made here: its month is not over. Review, approval and
 * payment are the integration tests of 5-5.)
 */
test('accounting: the queue, the reports, an Odoo mapping and the export file', async ({
  browser,
}) => {
  test.setTimeout(180_000);
  const f = fixture();
  const page = await staffPage(browser, f.finance, STACK.adminUrl, '/login', '/settlement');
  await expect(page.getByRole('heading', { name: 'صورت‌وضعیت پزشکان' })).toBeVisible();
  await expect(page.getByRole('search', { name: 'وضعیت صورت‌وضعیت' })).toBeVisible();
  expect(await page.locator('main').innerText()).not.toMatch(/\b20\d\d\b/);
  await checkPage(page);

  await page.getByRole('link', { name: 'اقلام معلق و مانده منفی' }).click();
  await expect(page.getByRole('heading', { name: 'گزارش‌های تسویه' })).toBeVisible();
  expect(await page.locator('main').innerText()).not.toMatch(/\b20\d\d\b/);
  await checkPage(page);

  await page.goto('/settlement/odoo');
  const code = `doctor.test_${randomUUID()
    .slice(0, 6)
    .replace(/[0-9-]/g, 'x')}`;
  const mapping = page.getByRole('form', { name: 'ثبت نگاشت حساب' });
  await mapping.getByLabel('حساب داخلی (مثل doctor.payable)').fill(code);
  await mapping.getByLabel('کد حساب در Odoo').fill('2101');
  await mapping.getByLabel('دلیل').fill('نگاشت آزمون');
  await mapping.getByRole('button', { name: 'ثبت نگاشت' }).click();
  await expect(mapping.getByText('نگاشت ثبت شد.')).toBeVisible();
  await expect(page.getByRole('table', { name: 'نگاشت حساب‌ها' })).toContainText(code);
  await checkPage(page);

  // Last month's file: whatever it holds, the header names both dates.
  const exportForm = page.getByRole('form', { name: 'ساخت خروجی Odoo' });
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    exportForm.getByRole('button', { name: 'ساخت و دریافت فایل' }).click(),
  ]);
  const csv = readFileSync(await download.path(), 'utf8');
  expect(csv.replace(String.fromCharCode(0xfeff), '').split('\r\n')[0]).toBe(
    'external_id,line_id,date,date_jalali,journal_ref,account,internal_account,partner_ref,debit,credit',
  );
  await expect(page.getByRole('table', { name: 'خروجی‌های ساخته‌شده' })).not.toContainText(
    'هنوز خروجی‌ای ساخته نشده است.',
  );
  expect(await page.locator('main').innerText()).not.toMatch(/\b20\d\d\b/);
  await checkPage(page);
});

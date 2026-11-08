import { expect, test } from '@playwright/test';
import { STACK } from '../src/stack-config.ts';
import { checkPage } from './credit-steps.ts';
import { fixture, staffPage } from './support.ts';

/**
 * Roles and access (owner 1405/07/24, go-live blocker م۱۰): the system admin makes a role,
 * grants it to an account found by username, and revokes it, each with a reason.
 */
test('a role made, granted by username and revoked, from the panel', async ({ browser }) => {
  test.setTimeout(180_000);
  const { admin, support } = fixture();
  const page = await staffPage(browser, admin, STACK.adminUrl, '/login', '/access');
  await expect(page.getByRole('heading', { level: 1, name: 'نقش‌ها و دسترسی‌ها' })).toBeVisible();
  await expect(page.getByRole('table', { name: 'نقش‌ها' })).toContainText('system_admin');
  await checkPage(page);

  const code = `e2e_${String(Date.now()).slice(-8)}`;
  const made = page.getByRole('region', { name: 'نقش تازه' });
  await made.getByLabel('کد نقش').fill(code);
  await made.getByLabel('نام نقش').fill('نقش آزمون e2e');
  await made.getByLabel('access.read_roles').check();
  await made.getByLabel('دلیل').fill('آزمون صفحه نقش‌ها');
  await made.getByRole('button', { name: 'ساخت نقش' }).click();
  await expect(made.getByText('نقش ساخته شد.')).toBeVisible();
  const row = page
    .getByRole('table', { name: 'نقش‌ها' })
    .getByRole('row', { name: new RegExp(code) });
  await expect(row).toContainText('ساخته‌شده در پنل');

  const account = page.getByRole('region', { name: 'دسترسی یک حساب' });
  await account.getByLabel('نام کاربری کارمند یا مرکز').fill(support.username);
  await account.getByRole('button', { name: 'یافتن' }).click();
  await expect(account.getByText(support.username, { exact: true })).toBeVisible();
  await account.getByLabel('نقش', { exact: true }).selectOption({ label: 'نقش آزمون e2e' });
  await account.getByLabel('دلیل', { exact: true }).fill('آزمون دادن نقش');
  await account.getByRole('button', { name: 'دادن نقش' }).click();
  await expect(account.getByText('نقش داده شد.')).toBeVisible();
  const granted = account.getByRole('listitem').filter({ hasText: code });
  await expect(granted).toContainText('همه‌جا');

  await granted.getByLabel('دلیل لغو').fill('پایان آزمون');
  await granted.getByRole('button', { name: 'لغو نقش' }).click();
  await expect(account.getByText('نقش لغو شد.')).toBeVisible();
  await expect(account.getByRole('listitem').filter({ hasText: code })).toHaveCount(0);
  await checkPage(page);
});

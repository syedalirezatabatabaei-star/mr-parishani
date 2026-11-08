import { expect, test } from '@playwright/test';
import { STACK } from '../src/stack-config.ts';
import { checkPage } from './credit-steps.ts';
import { fixture, staffPage } from './support.ts';

/**
 * Task 4-8 (doc 12 §7): cancelling part of what is unused on a funded purse, asked by one
 * person in finance on the application's page and approved by another on «عملیات ویژه».
 * The asker is told they cannot approve their own request; the page has no serious
 * accessibility violation at each step.
 */
test('partial cancellation of what is unused: asked by one, approved by another', async ({
  browser,
}) => {
  test.setTimeout(300_000);
  const f = fixture();
  const page = `/completion/${f.fundedApplicationId}`;

  // One person in finance asks to cancel part of what is unused, on the application's page.
  const asker = await staffPage(browser, f.completionFinance, STACK.adminUrl, '/login', page);
  const form = asker.getByRole('form', { name: 'درخواست ابطال مانده مصرف‌نشده' });
  await form.getByLabel('مبلغ ابطال (خالی: همه مانده)').fill('1000000');
  await form.getByLabel('دلیل').fill('بیمار بخشی از درمان را نمی‌خواهد');
  await checkPage(asker);
  await form.getByRole('button', { name: 'درخواست ابطال' }).click();
  const operations = asker.getByRole('table', { name: 'عملیات این کیف' });
  await expect(operations).toContainText('در انتظار تأیید');
  await checkPage(asker);

  // On the queue, the asker is told they cannot approve their own request.
  await asker.goto('/special-operations');
  const own = asker.getByRole('table', { name: 'عملیات کیف در انتظار تأیید' });
  await expect(own).toContainText('تأییدکننده نمی‌تواند درخواست خودش را تأیید کند.');
  await expect(own.getByRole('button', { name: 'تأیید و اجرا' })).toHaveCount(0);
  await checkPage(asker);

  // Another person in finance approves it, with a reason.
  const approver = await staffPage(
    browser,
    f.finance,
    STACK.adminUrl,
    '/login',
    '/special-operations',
  );
  const queue = approver.getByRole('table', { name: 'عملیات کیف در انتظار تأیید' });
  await expect(queue).toContainText('ابطال مانده مصرف‌نشده');
  await checkPage(approver);
  await queue.getByRole('button', { name: 'تأیید و اجرا' }).first().click();
  await approver.getByLabel('دلیل تأیید').fill('با درخواست بیمار تطبیق شد');
  await approver.getByRole('button', { name: 'تأیید و اجرا' }).click();
  // An empty queue says so in place of its table.
  await expect(
    approver
      .getByRole('region', { name: 'عملیات کیف اعتبار' })
      .getByText('درخواستی در انتظار نیست.'),
  ).toBeVisible();

  // Done: the purse's operations say so, with the amount cancelled.
  await approver.goto(page);
  const done = approver.getByRole('table', { name: 'عملیات این کیف' });
  await expect(done).toContainText('انجام شد');
  await expect(done).toContainText('۱٬۰۰۰٬۰۰۰');
  await checkPage(approver);
});

/**
 * F7 (owner 1405/07/23, plan 2): a new doctor is picked from the list the service offers
 * (the purse's treatment field, an active center, not its doctor), not typed as an id. The
 * second person rejects it here, so the shared purse keeps its doctor for the specs after.
 */
test('a new doctor, picked from the list: asked by one, decided by another', async ({
  browser,
}) => {
  test.setTimeout(300_000);
  const f = fixture();
  const page = `/completion/${f.fundedApplicationId}`;

  const asker = await staffPage(browser, f.completionFinance, STACK.adminUrl, '/login', page);
  const form = asker.getByRole('form', { name: 'درخواست تغییر پزشک' });
  await form.getByRole('button', { name: 'نمایش پزشکان' }).click();
  const pick = form.getByLabel('پزشک تازه');
  await expect(pick).toBeVisible();
  // The seeded second doctor of the same field and center (the panel's review doctor).
  await expect(pick.locator('option')).not.toHaveCount(1);
  await pick.selectOption({ index: 1 });
  await form.getByLabel('دلیل').fill('بیمار پزشک دیگری می‌خواهد');
  await checkPage(asker);
  await form.getByRole('button', { name: 'درخواست تغییر پزشک' }).click();
  const operations = asker.getByRole('table', { name: 'عملیات این کیف' });
  await expect(operations).toContainText('در انتظار تأیید');

  // The credit manager decides a doctor change; here, a rejection with a reason.
  const decider = await staffPage(
    browser,
    f.creditManager,
    STACK.adminUrl,
    '/login',
    '/special-operations',
  );
  const queue = decider.getByRole('table', { name: 'عملیات کیف در انتظار تأیید' });
  await expect(queue).toContainText('تغییر پزشک');
  await checkPage(decider);
  await queue.getByRole('button', { name: 'رد با دلیل' }).first().click();
  await decider.getByLabel('دلیل رد').fill('بیمار منصرف شد');
  await decider.getByRole('button', { name: 'رد درخواست' }).click();
  await expect(
    decider
      .getByRole('region', { name: 'عملیات کیف اعتبار' })
      .getByText('درخواستی در انتظار نیست.'),
  ).toBeVisible();

  // The asker sees it decided on the application's page (the credit manager has no such table).
  await asker.goto(page);
  await expect(asker.getByRole('table', { name: 'عملیات این کیف' })).toContainText('رد شد');
});

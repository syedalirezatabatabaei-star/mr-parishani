import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import { STACK } from '../src/stack-config.ts';
import { checkPage } from './credit-steps.ts';
import { fixture, staffPage } from './support.ts';

/**
 * Task 5-1 (doc 06 §3; CLAUDE.md §4): a settlement rate is set in the admin panel, a percent
 * or a fixed amount at a level, proposed by one person and approved by another; the proposer
 * cannot approve their own. Set at a doctor's level nobody holds, so the other tests' fees
 * stay at the first value, 0.
 */
test('a settlement rate: proposed by one, refused to the same person, approved by another', async ({
  browser,
}) => {
  test.setTimeout(180_000);
  const f = fixture();
  const ref = randomUUID();
  const page = '/settlement-rates?key=settlement.credit_service_fee';

  const proposer = await staffPage(browser, f.strategyA, STACK.adminUrl, '/login', page);
  await expect(proposer.getByRole('table', { name: 'نسخه‌های کارمزد خدمت اعتباری' })).toBeVisible();
  await checkPage(proposer);
  const form = proposer.getByRole('form', { name: 'پیشنهاد نرخ تازه' });
  await form.getByLabel('سطح').selectOption('doctor');
  await form.getByLabel('شناسه گره پزشک').fill(ref);
  await form.getByLabel('نوع نرخ').selectOption('fixed');
  await form.getByLabel('مبلغ (ریال)').fill('150000');
  await form.getByLabel('دلیل تغییر').fill('قرارداد تازه پزشک');
  await form.getByRole('button', { name: 'ثبت پیشنهاد' }).click();
  await expect(form.getByText('پیشنهاد ثبت شد و منتظر تأیید نفر دوم است.')).toBeVisible();

  // The proposer's own approval is refused.
  const row = proposer.getByRole('row').filter({ hasText: ref });
  await expect(row).toContainText('در انتظار تأیید');
  await row.getByRole('button', { name: 'تأیید' }).click();
  await expect(row).toContainText('این درخواست را باید شخص دیگری جز پیشنهاددهنده تأیید کند.');
  await checkPage(proposer);

  // Another person approves it.
  const approver = await staffPage(browser, f.strategyB, STACK.adminUrl, '/login', page);
  const theirs = approver.getByRole('row').filter({ hasText: ref });
  await theirs.getByRole('button', { name: 'تأیید' }).click();
  await expect(theirs).toContainText('تأییدشده');
  await expect(theirs).toContainText('برای هر خدمت');
  await checkPage(approver);
});

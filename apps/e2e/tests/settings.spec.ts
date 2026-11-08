import { expect, test } from '@playwright/test';
import { STACK } from '../src/stack-config.ts';
import { checkPage } from './credit-steps.ts';
import { fixture, staffPage } from './support.ts';

/**
 * The settings page (owner 1405/07/24, م۱۰): a flag proposed off by one person waits for a
 * second; a booking value proposed by one strategy manager is approved by the other. Values
 * are proposed as they already are, so the shared stack behaves as before.
 */
test('flags and booking keys: proposed by one, decided by another', async ({ browser }) => {
  test.setTimeout(180_000);
  const { admin, strategyA, strategyB } = fixture();

  const flags = await staffPage(
    browser,
    admin,
    STACK.adminUrl,
    '/login',
    '/settings?key=identity.factor_change_sms',
  );
  await expect(
    flags.getByRole('heading', { level: 1, name: 'تنظیمات هویت، سرنخ، نوبت و پیامک' }),
  ).toBeVisible();
  const inForce = flags.getByRole('region', { name: 'پیامک تغییر عامل ورود' });
  await expect(inForce).toContainText('خاموش');
  const form = flags.getByRole('form', { name: 'پیشنهاد روشن یا خاموش' });
  await expect(form.getByLabel('مقدار تازه')).toHaveValue('off');
  await form.getByLabel('دلیل تغییر').fill('آزمون صفحه تنظیمات');
  await form.getByRole('button', { name: 'ثبت پیشنهاد' }).click();
  await expect(form.getByText('منتظر تأیید نفر دوم')).toBeVisible();
  await expect(
    flags.getByRole('table', { name: /نسخه‌های/ }).getByText('پیشنهاد خودتان؛ منتظر نفر دوم'),
  ).toBeVisible();
  await checkPage(flags);

  const proposer = await staffPage(
    browser,
    strategyA,
    STACK.adminUrl,
    '/login',
    '/settings?key=booking.hold_minutes',
  );
  await proposer.getByLabel('دلیل تغییر').fill('آزمون تأیید دونفره');
  await proposer.getByRole('button', { name: 'ثبت پیشنهاد' }).click();
  await expect(proposer.getByText('پیشنهاد ثبت شد و منتظر تأیید نفر دوم است.')).toBeVisible();

  const approver = await staffPage(
    browser,
    strategyB,
    STACK.adminUrl,
    '/login',
    '/settings?key=booking.hold_minutes',
  );
  const row = approver.getByRole('row', { name: /آزمون تأیید دونفره/ });
  await row.getByRole('button', { name: 'تأیید' }).click();
  await expect(approver.getByRole('row', { name: /آزمون تأیید دونفره/ })).toContainText('جاری');
  await checkPage(approver);
});

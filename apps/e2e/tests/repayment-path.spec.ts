import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import { formatJalaliDate, normalizeDigits, toJalali, toPersianDigits } from '@sepehr/contracts';
import { STACK } from '../src/stack-config.ts';
import { checkPage } from './credit-steps.ts';
import { fixture, patientLogin, staffPage } from './support.ts';

const PDF = Buffer.from('%PDF-1.4\n1 0 obj << >> endobj\ntrailer << >>\n%%EOF\n');

/** Tomans as the page writes them (Persian digits, separators) back to rials. */
const rialsOf = (text: string) => `${normalizeDigits(text).replace(/[^0-9]/g, '')}0`;

/**
 * Task 6-9 acceptance (doc 16): «فیش ← تأیید ← تخصیص». The borrower sends a slip of the first
 * installment from their page; finance approves it in the panel; the borrower's page shows the
 * installment paid and less owed. Every page Jalali only and without a serious axe violation.
 */
test('slip → approval → allocation', async ({ browser }) => {
  test.setTimeout(240_000);
  const f = fixture();
  const bankRef = `TRK${randomUUID().slice(0, 8).toUpperCase()}`;
  // The page shows the reference with Persian digits (style guide 2-10); the panel shows it as typed.
  const shownRef = toPersianDigits(bankRef);

  const patient = await (await browser.newContext({ baseURL: STACK.webUrl })).newPage();
  await patient.goto('/login?next=%2Fme%2Frepayment');
  await patientLogin(patient, f.repaymentPatientMobile);
  await expect(patient).toHaveURL(/\/me\/repayment$/);
  const installments = patient.getByRole('table', { name: 'اقساط' });
  const first = installments.getByRole('row').nth(1);
  await expect(first).toContainText('سررسید نشده');
  const owedBefore = await patient
    .getByText('مانده بدهی')
    .locator('xpath=following-sibling::dd[1]')
    .innerText();
  const amountText = await first.getByRole('cell').nth(2).innerText();
  await checkPage(patient);

  // The slip: the installment's amount, today, the bank's tracking number, the file.
  const form = patient.getByRole('form', { name: 'ارسال فیش قسط' });
  await form.getByLabel('مبلغ واریزی، مطابق فیش').fill(rialsOf(amountText));
  await form.getByLabel('روز واریز').fill(formatJalaliDate(toJalali(new Date())));
  await form.getByLabel('روز واریز').press('Tab');
  await form.getByLabel('شماره پیگیری بانک').fill(bankRef);
  await form.getByLabel('نام واریزکننده').fill('واریزکننده آزمون');
  await form
    .getByLabel('فایل فیش')
    .setInputFiles({ name: 'slip.pdf', mimeType: 'application/pdf', buffer: PDF });
  await form.getByRole('button', { name: 'ارسال فیش' }).click();
  await expect(patient.getByText(/فیش ثبت شد/)).toBeVisible();
  const slips = patient.getByRole('table', { name: 'فیش‌ها و پرداخت‌ها' });
  await expect(slips.getByRole('row').filter({ hasText: shownRef })).toContainText(
    'در انتظار تأیید مالی',
  );

  // Finance approves it in the panel.
  const finance = await staffPage(browser, f.finance, STACK.adminUrl, '/login', '/repayment');
  const row = finance
    .getByRole('table', { name: 'فیش‌های در انتظار تأیید مالی' })
    .getByRole('row')
    .filter({ hasText: bankRef });
  await expect(row).toBeVisible();
  await checkPage(finance);
  await row.getByRole('button', { name: 'تأیید' }).click();
  await expect(row).toHaveCount(0);

  // Allocated to the oldest installment: paid, and less owed.
  await patient.reload();
  await expect(slips.getByRole('row').filter({ hasText: shownRef })).toContainText('تأییدشده');
  await expect(installments.getByRole('row').nth(1)).toContainText('پرداخت‌شده');
  const owedAfter = await patient
    .getByText('مانده بدهی')
    .locator('xpath=following-sibling::dd[1]')
    .innerText();
  expect(BigInt(rialsOf(owedAfter))).toBeLessThan(BigInt(rialsOf(owedBefore)));
  expect(await patient.locator('main').innerText()).not.toMatch(/[0-9]{4}/);
  await checkPage(patient);
});

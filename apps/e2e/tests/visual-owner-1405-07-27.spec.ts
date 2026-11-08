import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { STACK, STACK_DIR } from '../src/stack-config.ts';
import { nationalId } from '../src/synthetic.ts';
import { throughDecision } from './credit-steps.ts';
import { fixture, newMobile, otpFor, staffPage, signedPost } from './support.ts';

/**
 * The owner's visual approval of round twenty-nine's panel parts (1405/07/27): the penalty
 * rate's request on the completion page (accounting) and its queue (the general manager), the
 * contract term on the settlement rates, and a credit transfer's paper number and the receipt
 * tick. Only with VISUAL=1; saved to VISUAL_OUT (outside the repository), else
 * .stack/visual-owner. The transfer flag is turned on in this throwaway database only, by two
 * system administrators through the API, as the panel would.
 */
const OUT = process.env['VISUAL_OUT'] ?? resolve(STACK_DIR, 'visual-owner');

const shot = async (page: Page, name: string) => {
  await page.waitForLoadState('networkidle');
  await page.screenshot({ path: resolve(OUT, `${name}.png`), fullPage: true });
};

test.skip(process.env['VISUAL'] !== '1', 'screenshots only for the owner’s review (VISUAL=1)');

test('screenshots for the owner (1405/07/27)', async ({ browser }) => {
  test.setTimeout(900_000);
  mkdirSync(OUT, { recursive: true });
  const f = fixture();

  // 1. The penalty rate: accounting asks on the completion page of an approved case.
  const { applicationId } = await throughDecision(browser);
  const finance = await staffPage(
    browser,
    f.finance,
    STACK.adminUrl,
    '/login',
    `/completion/${applicationId}`,
  );
  const ask = finance.getByRole('form', { name: 'درخواست نرخ خسارت این پرونده' });
  await expect(ask).toBeVisible();
  await ask.getByLabel('نرخ خسارت (درصد)').fill('10');
  await ask.getByLabel('دلیل').fill('وضعیت خاص بیمار، با تأیید مدیرکل');
  await shot(finance, 'p27-01-penalty-request-completion-accounting');
  await ask.getByRole('button', { name: 'درخواست نرخ' }).click();
  await expect(finance.getByText('در انتظار تأیید').first()).toBeVisible();

  // 2. The general manager's queue on «عملیات ویژه».
  const ceo = await staffPage(browser, f.ceo, STACK.adminUrl, '/login', '/special-operations');
  await expect(ceo.getByRole('table', { name: 'نرخ‌های خسارت در انتظار تأیید' })).toBeVisible();
  await shot(ceo, 'p27-02-penalty-queue-general-manager');
  await ceo.getByRole('button', { name: 'تأیید نرخ' }).first().click();
  await shot(ceo, 'p27-03-penalty-queue-approve-form');

  // 3. The contract term on the settlement rates.
  const strategy = await staffPage(
    browser,
    f.strategyA,
    STACK.adminUrl,
    '/login',
    '/settlement-rates?key=settlement.provider_contract',
  );
  await expect(strategy.getByRole('form', { name: 'پیشنهاد نرخ تازه' })).toBeVisible();
  await strategy.getByLabel('مدت قرارداد').selectOption('6');
  await shot(strategy, 'p27-04-contract-term-form');

  // 4. A credit transfer: the flag on here only, by two system administrators (the API, as the
  // panel's configuration path), then asked with the paper number and approved with its tick.
  // A technical key: two system administrators (config.manage_technical).
  const sysadmin = await staffPage(browser, f.admin, STACK.adminUrl, '/login', '/');
  const proposeFlag = async () => {
    const me = (await (await sysadmin.request.get('/api/v1/auth/me')).json()) as {
      csrfToken: string;
    };
    const made = await signedPost(sysadmin, '/api/v1/config/proposals', {
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
  const proposal = await proposeFlag();
  const second = await staffPage(browser, f.admin2, STACK.adminUrl, '/login', '/');
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
  await transfer.getByLabel('شماره سند کاغذی امضاشده انتقال‌دهنده').fill('P-1405-0727');
  await shot(asker, 'p27-05-transfer-paper-number');
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
  await expect(queue).toContainText('P-1405-0727');
  await queue.getByRole('button', { name: 'تأیید انتقال' }).first().click();
  await approver.getByLabel('دلیل تأیید').fill('سند کاغذی دیده شد');
  await expect(approver.getByText('سند امضاشده شماره P-1405-0727 دریافت شد.')).toBeVisible();
  await shot(approver, 'p27-06-transfer-paper-received-tick');
});

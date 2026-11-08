import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { formatJalaliDate, toJalali, toPersianDigits } from '@sepehr/contracts';
import { STACK, STACK_DIR } from '../src/stack-config.ts';
import { fixture, patientLoginAfterWait, staffPage } from './support.ts';

/**
 * Task 6-9: screenshots of the phase's main pages for the owner's visual approval (CLAUDE.md
 * §4), never part of the acceptance run: only with VISUAL=1. Saved under .stack/visual-6-9/.
 * Run after the acceptance specs, so the pages have data (a slip, an overdue case, a campaign).
 */
const OUT = resolve(STACK_DIR, 'visual-6-9');
const PDF = Buffer.from('%PDF-1.4\n1 0 obj << >> endobj\ntrailer << >>\n%%EOF\n');
const shot = async (page: Page, name: string) => {
  await page.waitForLoadState('networkidle');
  await page.screenshot({ path: resolve(OUT, `${name}.png`), fullPage: true });
};

test.skip(process.env['VISUAL'] !== '1', 'screenshots only for the owner’s review (VISUAL=1)');

test('screenshots of phase 6’s pages', async ({ browser }) => {
  test.setTimeout(300_000);
  mkdirSync(OUT, { recursive: true });
  const f = fixture();

  // The borrower: installments, slips, their cheques (phone width, then desktop).
  const phone = await (
    await browser.newContext({ baseURL: STACK.webUrl, viewport: { width: 390, height: 844 } })
  ).newPage();
  await phone.goto('/login?next=%2Fme%2Frepayment');
  await patientLoginAfterWait(phone, f.repaymentPatientMobile);
  await expect(phone).toHaveURL(/\/me\/repayment$/);
  await shot(phone, '01-borrower-installments-phone');
  const desk = await (await browser.newContext({ baseURL: STACK.webUrl })).newPage();
  await desk.goto('/login?next=%2Fme%2Frepayment');
  await patientLoginAfterWait(desk, f.collectionPatientMobile);
  await expect(desk).toHaveURL(/\/me\/repayment$/);
  await shot(desk, '02-borrower-installments-overdue');
  // A slip waiting for finance, so the finance queue is not empty in the picture.
  const slip = desk.getByRole('form', { name: 'ارسال فیش قسط' });
  await slip.getByLabel('مبلغ واریزی، مطابق فیش').fill('440000');
  await slip.getByLabel('روز واریز').fill(formatJalaliDate(toJalali(new Date())));
  await slip.getByLabel('روز واریز').press('Tab');
  await slip.getByLabel('شماره پیگیری بانک').fill('TRK20261007');
  await slip.getByLabel('نام واریزکننده').fill('واریزکننده نمونه');
  await slip
    .getByLabel('فایل فیش')
    .setInputFiles({ name: 'slip.pdf', mimeType: 'application/pdf', buffer: PDF });
  await slip.getByRole('button', { name: 'ارسال فیش' }).click();
  await expect(desk.getByText(/فیش ثبت شد/)).toBeVisible();
  await desk.reload();
  await shot(desk, '02b-borrower-slip-pending');

  // The guarantor: their commitment only.
  const guarantor = await (await browser.newContext({ baseURL: STACK.webUrl })).newPage();
  await guarantor.goto('/login?next=%2Fme%2Fguarantees');
  await patientLoginAfterWait(guarantor, f.collectionGuarantorMobile);
  await guarantor.getByRole('link', { name: 'رضایت و مدارک' }).first().click();
  await expect(guarantor.getByText('وضعیت ضمانت شما')).toBeVisible();
  await shot(guarantor, '03-guarantor-commitment');

  // Finance: the slip queue and suspense; the bank statement; cheques.
  const finance = await staffPage(browser, f.finance, STACK.adminUrl, '/login', '/repayment');
  await shot(finance, '04-finance-slips');
  await finance.goto('/bank-statements');
  await shot(finance, '05-finance-bank-statement');
  await finance.goto('/instruments');
  await shot(finance, '06-finance-cheques');

  // Collection: the queue and one case.
  const agent = await staffPage(
    browser,
    f.collectionAgent,
    STACK.adminUrl,
    '/login',
    '/collection',
  );
  await shot(agent, '07-collection-queue');
  // The case with a guarantor (the collection path's loan), found by its mobile's last digits.
  const first = agent
    .getByRole('table', { name: 'پرونده‌های معوق' })
    .getByRole('row')
    .filter({ hasText: toPersianDigits(f.collectionPatientMobile.slice(-7)) })
    .getByRole('link')
    .first();
  if ((await first.count()) > 0) {
    await first.click();
    await expect(agent).toHaveURL(/\/collection\/[0-9a-f-]{36}$/);
    await shot(agent, '08-collection-case');
  }
  const manager = await staffPage(
    browser,
    f.collectionManager,
    STACK.adminUrl,
    '/login',
    '/collection',
  );
  await shot(manager, '09-collection-manager-decisions');

  // SMS: the strategy manager adds a template the overdue filter can fill (the seeded reminders
  // also use the installment's number and due date, which a campaign filter does not have).
  const strategy = await staffPage(browser, f.strategyA, STACK.adminUrl, '/login', '/sms');
  const tpl = strategy.getByRole('form', { name: 'قالب تازه یا نسخه تازه' });
  await tpl.getByLabel('کد (مثل repayment.notice)').fill('campaign.overdue_short');
  await tpl.getByLabel('گیرنده').selectOption('borrower');
  await tpl.getByLabel('دسته').selectOption('transactional');
  await tpl
    .getByLabel('متن')
    .fill('{{name}} گرامی، قسط شما {{days_overdue}} روز معوق است: {{amount}}');
  await tpl.getByLabel('دلیل تغییر').fill('قالب کمپین یادآوری معوق');
  await tpl.getByRole('button', { name: 'ذخیره قالب' }).click();
  await expect(tpl.getByText('قالب ذخیره شد.')).toBeVisible();

  // Templates, scheduling, record; a campaign made, previewed, waiting for a second person.
  const support = await staffPage(browser, f.support, STACK.adminUrl, '/login', '/sms');
  await shot(support, '10-sms-panel');
  await support.goto('/sms/campaigns');
  const form = support.getByRole('form', { name: 'کمپین تازه' });
  await form.getByLabel('نام کمپین').fill('یادآوری اقساط معوق');
  await form.getByLabel('دست‌کم چند روز معوق').fill('1');
  const code = form.getByLabel('کد قالب (خدماتی)');
  if ((await code.count()) > 0) await code.fill('campaign.overdue_short');
  else await form.getByLabel(/^قالب/).selectOption('campaign.overdue_short');
  await form.getByRole('button', { name: 'ساخت پیش‌نویس و پیش‌نمایش' }).click();
  await expect(support).toHaveURL(/\/sms\/campaigns\/[0-9a-f-]{36}$/);
  await shot(support, '11-sms-campaign-preview');
  await strategy.goto(new URL(support.url()).pathname);
  await shot(strategy, '12-sms-campaign-second-person');
});

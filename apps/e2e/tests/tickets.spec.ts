import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import { toPersianDigits } from '@sepehr/contracts';
import { STACK } from '../src/stack-config.ts';
import { checkPage } from './credit-steps.ts';
import { fixture, newMobile, patientLogin, serviceCodeFor, staffPage } from './support.ts';

/**
 * Task 7-7 acceptance (doc 18; doc 17 §1, §2, §4, §5): a financial complaint from the
 * doctor's panel holds its item, accounting answers and rejects it, and the complaint is
 * resolved with the item back for its statement; a patient's ticket answered by support,
 * the internal note never shown; a report run with the one filter, saved, run again and
 * exported. Every page Jalali only, with no serious axe violation.
 */

test('financial complaint → on_hold → answer → decided', async ({ browser }) => {
  test.setTimeout(300_000);
  const f = fixture();
  const tag = randomUUID().slice(0, 8);
  const subject = `مبلغ خدمت ${tag}`;

  // A final service on the complaint's purse: its payable is the item complained about.
  const doctor = await staffPage(
    browser,
    f.doctor,
    STACK.webUrl,
    '/panel/login',
    `/panel/patients/${f.complaintPurseId}`,
  );
  await doctor.getByRole('checkbox').first().check();
  await doctor.getByRole('button', { name: 'صدور و ارسال کد به بیمار' }).click();
  await expect(doctor).toHaveURL(/\/panel\/authorizations\//);
  await doctor
    .getByLabel('کد پیامک‌شده به بیمار')
    .fill(await serviceCodeFor(f.complaintPatientMobile));
  await doctor.getByRole('button', { name: 'ثبت خدمت' }).click();
  await expect(doctor.getByText('خدمت ثبت و قطعی شد.')).toBeVisible();

  // The complaint: the worker makes the payable from the event, so wait for the item.
  const held = doctor.getByRole('table', { name: 'اقلام معلق به‌دلیل اعتراض' });
  await doctor.goto('/panel/settlement');
  await expect(held.getByText('باز، در دست بررسی')).toHaveCount(0);
  await doctor.goto('/panel/tickets/new');
  const form = doctor.getByRole('form', { name: 'تیکت تازه' });
  await form.getByLabel('موضوع').selectOption({ label: 'شکایت: شکایت مالی' });
  const item = form.getByLabel('قلم مورد اعتراض');
  await expect(async () => {
    await doctor.reload();
    await form.getByLabel('موضوع').selectOption({ label: 'شکایت: شکایت مالی' });
    expect(await item.locator('option').count()).toBeGreaterThan(1);
  }).toPass({ timeout: 90_000 });
  await item.selectOption({ index: (await item.locator('option').count()) - 1 });
  await form.getByLabel('عنوان').fill(subject);
  await form.getByLabel('شرح').fill('مبلغ این خدمت با تعرفه نمی‌خواند.');
  await checkPage(doctor);
  await form.getByRole('button', { name: 'ثبت' }).click();
  await expect(doctor).toHaveURL(/\/panel\/tickets\/[0-9a-f-]{36}$/);
  await expect(doctor.getByText('در صورت‌وضعیت نمی‌آید')).toBeVisible();
  await checkPage(doctor);
  const ticketUrl = doctor.url();

  // on_hold: held in the panel, its dispute open.
  await doctor.goto('/panel/settlement');
  await expect(held.getByText('باز، در دست بررسی')).toHaveCount(1);

  // Accounting: the complaint in its unit's queue; an answer, then the decision.
  const finance = await staffPage(browser, f.finance, STACK.adminUrl, '/login', '/tickets');
  await finance.getByLabel('واحد').selectOption({ label: 'حسابداری و تسویه' });
  await finance.getByRole('button', { name: 'اعمال فیلتر' }).click();
  const queue = finance.getByRole('table', { name: 'صف تیکت' });
  await expect(queue.getByRole('row').filter({ hasText: subject })).toBeVisible();
  await checkPage(finance);
  await queue.getByRole('row').filter({ hasText: subject }).getByRole('link').click();
  await expect(finance.getByRole('heading', { name: 'اختلاف مالی' })).toBeVisible();
  await expect(finance.getByText('باز، در دست بررسی')).toBeVisible();
  // «resolved» is not offered: only the dispute's decision closes it.
  await expect(
    finance.getByLabel('وضعیت تازه').locator('option', { hasText: 'حل‌شده' }),
  ).toHaveCount(0);
  const reply = finance.getByRole('form', { name: 'پاسخ' });
  await reply.getByLabel('پیام').fill('اعتراض شما بررسی می‌شود.');
  await reply.getByRole('button', { name: 'ارسال' }).click();
  await expect(finance.getByText('اعتراض شما بررسی می‌شود.')).toBeVisible();
  await checkPage(finance);
  const decision = finance.getByRole('form', { name: 'تعیین تکلیف' });
  await decision.getByLabel('یادداشت تصمیم').fill('بررسی شد؛ مبلغ با تعرفه درست است.');
  await decision.getByRole('button', { name: 'رد اعتراض' }).click();
  await expect(finance.getByText('ردشده', { exact: true })).toBeVisible();

  // Resolved by 7-2's consumer once the decision's event is handled.
  await expect(async () => {
    await doctor.goto(ticketUrl);
    await expect(doctor.getByText('حل‌شده').first()).toBeVisible({ timeout: 2_000 });
  }).toPass({ timeout: 90_000 });
  await expect(doctor.getByText('اعتراض شما بررسی می‌شود.')).toBeVisible();
  await checkPage(doctor);
  await doctor.goto('/panel/settlement');
  await expect(held.getByText('باز، در دست بررسی')).toHaveCount(0);
});

test('a patient’s ticket: answered by support, the internal note unseen, closed', async ({
  browser,
}) => {
  test.setTimeout(180_000);
  const f = fixture();
  const tag = randomUUID().slice(0, 8);
  const subject = `پرسش ${tag}`;
  const note = `یادداشت داخلی ${tag}`;
  // Shown with Persian digits (stored Latin, rule 23).
  const shownNote = toPersianDigits(note);

  const patient = await (await browser.newContext({ baseURL: STACK.webUrl })).newPage();
  await patient.goto('/login?next=%2Fme%2Ftickets');
  await patientLogin(patient, newMobile());
  await expect(patient).toHaveURL(/\/me\/tickets$/);
  await checkPage(patient);
  await patient.getByRole('link', { name: 'تیکت تازه' }).click();
  const form = patient.getByRole('form', { name: 'تیکت تازه' });
  // A patient never sees the financial complaint (7-2 ج۴).
  await expect(form.getByLabel('موضوع').locator('option', { hasText: 'شکایت مالی' })).toHaveCount(
    0,
  );
  await form.getByLabel('موضوع').selectOption({ label: 'پرسش عمومی' });
  await form.getByLabel('عنوان').fill(subject);
  await form.getByLabel('شرح').fill('ساعت کاری پشتیبانی چیست؟');
  await checkPage(patient);
  await form.getByRole('button', { name: 'ثبت' }).click();
  await expect(patient).toHaveURL(/\/me\/tickets\/[0-9a-f-]{36}$/);
  const ticketUrl = patient.url();

  // Support: taken by the queue's share; a public answer and an internal note.
  const support = await staffPage(browser, f.support, STACK.adminUrl, '/login', '/tickets');
  const row = support.getByRole('table', { name: 'صف تیکت' }).getByRole('row').filter({
    hasText: subject,
  });
  await expect(row).toBeVisible();
  await row.getByRole('link').click();
  const reply = support.getByRole('form', { name: 'پاسخ' });
  await reply.getByLabel('پیام').fill('هر روز از ۸ تا ۱۶.');
  await reply.getByRole('button', { name: 'ارسال' }).click();
  await expect(support.getByText('هر روز از ۸ تا ۱۶.')).toBeVisible();
  await reply.getByLabel('پیام').fill(note);
  await reply.getByLabel('یادداشت داخلی').check();
  await reply.getByRole('button', { name: 'ارسال' }).click();
  await expect(support.getByText(shownNote)).toBeVisible();
  await expect(support.getByText('یادداشت داخلی', { exact: true }).first()).toBeVisible();
  const status = support.getByRole('form', { name: 'تغییر وضعیت' });
  await status.getByLabel('وضعیت تازه').selectOption({ label: 'حل‌شده' });
  await status.getByRole('button', { name: 'ثبت وضعیت' }).click();
  await expect(support.getByText('حل‌شده').first()).toBeVisible();
  await checkPage(support);

  // The patient: the answer, never the note; then closed.
  await patient.goto(ticketUrl);
  await expect(patient.getByText('هر روز از ۸ تا ۱۶.')).toBeVisible();
  await expect(patient.getByText(shownNote)).toHaveCount(0);
  await expect(patient.getByText(note)).toHaveCount(0);
  await checkPage(patient);
  await patient.getByRole('button', { name: 'بستن تیکت' }).click();
  await expect(patient.getByText('بسته‌شده')).toBeVisible();
});

test('a report: the one filter, a saved filter run again, an export recorded', async ({
  browser,
}) => {
  test.setTimeout(180_000);
  const f = fixture();
  const name = `تیکت‌های پشتیبانی ${randomUUID().slice(0, 6)}`;
  const page = await staffPage(browser, f.support, STACK.adminUrl, '/login', '/reports');
  await checkPage(page);
  await page.getByRole('link', { name: 'شکایات و تیکت', exact: true }).click();
  await expect(page).toHaveURL(/\/reports\/tickets$/);
  await page.getByLabel('بازه', { exact: true }).selectOption({ label: '۳۰ روز گذشته' });
  await page.getByLabel('واحد', { exact: true }).selectOption({ label: 'پشتیبانی' });
  await page.getByRole('button', { name: 'اعمال فیلتر' }).click();
  await expect(page).toHaveURL(/range=last_30_days/);
  await expect(page.getByText('بازه: ۳۰ روز گذشته')).toBeVisible();
  const table = page.getByRole('table', { name: 'شکایات و تیکت' });
  await expect(table).toBeVisible();
  // Unit and topic by their Persian names, never the codes (the owner's ruling, 7-7).
  await expect(table.getByRole('cell', { name: 'پشتیبانی', exact: true }).first()).toBeVisible();
  await expect(table.getByRole('cell', { name: 'پرسش عمومی', exact: true }).first()).toBeVisible();
  await expect(table.getByRole('cell', { name: 'support', exact: true })).toHaveCount(0);
  await expect(table.getByRole('cell', { name: 'general', exact: true })).toHaveCount(0);
  expect(await page.locator('main').innerText()).not.toMatch(/\b20\d\d\b/);
  await checkPage(page);

  // Saved: its conditions only; run again from its link, the same view.
  const save = page.getByRole('form', { name: 'ذخیره فیلتر' });
  await save.getByLabel('نام فیلتر').fill(name);
  await save.getByRole('button', { name: 'ذخیره فیلتر' }).click();
  await expect(page.getByText('فیلتر ذخیره شد.')).toBeVisible();
  await page.goto('/reports/tickets');
  await page.getByRole('link', { name }).click();
  await expect(page).toHaveURL(/range=last_30_days/);
  await expect(page).toHaveURL(/unit=support/);

  // An export of this view: recorded in «خروجی‌های من», ready.
  const exportForm = page.getByRole('form', { name: 'خروجی' });
  await exportForm.getByLabel('قالب').selectOption('csv');
  const popup = page
    .context()
    .waitForEvent('page', { timeout: 10_000 })
    .catch(() => null);
  await exportForm.getByRole('button', { name: 'دریافت خروجی' }).click();
  await popup;
  await page.reload();
  await expect(page.getByText(/^CSV،.*آماده/).first()).toBeVisible();
  await checkPage(page);
});

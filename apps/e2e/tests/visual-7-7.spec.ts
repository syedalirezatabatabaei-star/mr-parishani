import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { STACK, STACK_DIR } from '../src/stack-config.ts';
import { fixture, newMobile, patientLogin, staffPage } from './support.ts';

/**
 * Task 7-7: screenshots of phase 7's pages for the owner's visual approval (CLAUDE.md §4),
 * never part of the acceptance run: only with VISUAL=1, after tickets.spec.ts made the data.
 * Saved under .stack/visual-7-7/, desktop and phone.
 */
const OUT = resolve(STACK_DIR, 'visual-7-7');
const PHONE = { width: 390, height: 844 };
const shot = async (page: Page, name: string) => {
  await page.waitForLoadState('networkidle');
  await page.screenshot({ path: resolve(OUT, `${name}.png`), fullPage: true });
};

test.skip(process.env['VISUAL'] !== '1', 'screenshots only for the owner’s review (VISUAL=1)');

test('screenshots of phase 7’s pages', async ({ browser }) => {
  test.setTimeout(300_000);
  mkdirSync(OUT, { recursive: true });
  const f = fixture();

  // The doctor's panel: the tickets, the financial complaint, a new one, patients' complaints.
  const doctor = await staffPage(browser, f.doctor, STACK.webUrl, '/panel/login', '/panel/tickets');
  await shot(doctor, '01-panel-tickets');
  await doctor.getByRole('table', { name: 'تیکت‌های مرکز' }).getByRole('link').first().click();
  await expect(doctor.getByRole('heading', { level: 1 })).toBeVisible();
  await shot(doctor, '02-panel-complaint');
  await doctor.goto('/panel/tickets/new');
  await doctor.getByLabel('موضوع').selectOption({ label: 'شکایت: شکایت مالی' });
  await shot(doctor, '03-panel-new-financial');
  await doctor.goto('/panel/complaints');
  await shot(doctor, '04-panel-patient-complaints');

  // Accounting and support: the queue, a complaint with its dispute, a patient's ticket.
  const finance = await staffPage(browser, f.finance, STACK.adminUrl, '/login', '/tickets');
  await shot(finance, '05-admin-queue');
  await finance.goto('/tickets?unit=accounting&status=resolved');
  await finance.getByRole('table', { name: 'صف تیکت' }).getByRole('link').first().click();
  await expect(finance.getByRole('heading', { name: 'اختلاف مالی' })).toBeVisible();
  await shot(finance, '06-admin-complaint-decided');
  const support = await staffPage(browser, f.support, STACK.adminUrl, '/login', '/tickets');
  await support.getByRole('table', { name: 'صف تیکت' }).getByRole('link').first().click();
  await expect(support.getByRole('form', { name: 'پاسخ' })).toBeVisible();
  await shot(support, '07-admin-ticket-live');
  await support.goto('/tickets/new');
  await shot(support, '08-admin-on-behalf');

  // Reports: the list, one with the filter, its saved filters and exports; printed.
  await support.goto('/reports');
  await shot(support, '09-reports');
  await support.goto('/reports/tickets?range=last_30_days&unit=support');
  await shot(support, '10-report-tickets');
  await support.emulateMedia({ media: 'print' });
  await shot(support, '11-report-print');
  await support.emulateMedia({ media: 'screen' });

  // A patient on a phone: a new ticket, the list, and the ticket itself.
  const patient = await (
    await browser.newContext({ baseURL: STACK.webUrl, viewport: PHONE })
  ).newPage();
  await patient.goto('/login?next=%2Fme%2Ftickets');
  await patientLogin(patient, newMobile());
  await expect(patient).toHaveURL(/\/me\/tickets$/);
  await patient.goto('/me/tickets/new');
  await shot(patient, '12-phone-patient-new');
  const form = patient.getByRole('form', { name: 'تیکت تازه' });
  await form.getByLabel('عنوان').fill('پرسش درباره نوبت');
  await form.getByLabel('شرح').fill('نوبت هفته آینده را چطور جابه‌جا کنم؟');
  await form.getByRole('button', { name: 'ثبت' }).click();
  await expect(patient).toHaveURL(/\/me\/tickets\/[0-9a-f-]{36}$/);
  await shot(patient, '13-phone-patient-ticket');
  await patient.goto('/me/tickets');
  await shot(patient, '14-phone-patient-list');

  const phoneDoctor = await staffPage(
    browser,
    f.doctor,
    STACK.webUrl,
    '/panel/login',
    '/panel/tickets/new',
  );
  await phoneDoctor.setViewportSize(PHONE);
  await shot(phoneDoctor, '15-phone-panel-new');
  await support.setViewportSize(PHONE);
  await support.goto('/tickets');
  await shot(support, '16-phone-admin-queue');
  await support.getByRole('table', { name: 'صف تیکت' }).getByRole('link').first().click();
  await shot(support, '17-phone-admin-ticket');
});

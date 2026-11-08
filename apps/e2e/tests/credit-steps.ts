import { expect, type Browser, type Page } from '@playwright/test';
import { STACK } from '../src/stack-config.ts';
import {
  bookedAndExamined,
  fixture,
  maskedMobile,
  newMobile,
  nextOtpFor,
  nonJalaliDates,
  otpFor,
  patientLogin,
  seriousA11yViolations,
  staffPage,
} from './support.ts';

/**
 * Doc 11's acceptance path for 3-8, as steps shared by the specs that start from its end
 * (task 4-4): «صدور پیش‌فاکتور ← تأیید بیمار ← انتخاب طرح ← مدارک ← امتیاز ← ضامن ← تصمیم».
 */

/** The smallest file whose bytes say PDF. */
const PDF = Buffer.from('%PDF-1.4\n1 0 obj << >> endobj\ntrailer << >>\n%%EOF\n');
const DOCUMENTS = [
  'تصویر کارت ملی',
  'مدرک شغل (حکم، قرارداد یا جواز کسب)',
  'گردش حساب سه ماه اخیر',
] as const;

/** Jalali only, and no serious accessibility violation. */
export async function checkPage(page: Page) {
  expect(await nonJalaliDates(page)).toEqual([]);
  expect(await seriousA11yViolations(page)).toEqual([]);
}

/** The person uploads each required document on the page they are on. */
async function uploadAll(page: Page) {
  for (const title of DOCUMENTS) {
    const input = page.getByLabel(`فایل ${title}`);
    await input.setInputFiles({ name: 'document.pdf', mimeType: 'application/pdf', buffer: PDF });
    await input.locator('xpath=ancestor::form').getByRole('button', { name: 'بارگذاری' }).click();
    await expect(page.getByRole('listitem').filter({ hasText: title })).toContainText(
      'در انتظار بررسی',
    );
  }
}

/** Case completion accepts every submitted document of the application. */
async function acceptAll(page: Page) {
  for (;;) {
    const accept = page.getByRole('button', { name: 'پذیرش', exact: true }).first();
    if ((await accept.count()) === 0) break;
    const before = await page.getByRole('button', { name: 'پذیرش', exact: true }).count();
    await accept.click();
    await expect(page.getByRole('button', { name: 'پذیرش', exact: true })).toHaveCount(before - 1);
  }
}

/**
 * The doctor issues a proforma for a patient received at the center; the patient confirms
 * it, compares the plans and chooses one, submits, consents and uploads documents; case
 * completion accepts them; the credit specialist scores the borrower; a guarantor consents
 * and is documented and scored; the specialist proposes the approval and the credit
 * manager gives the second check. Every page on the way is checked.
 */
export async function throughDecision(browser: Browser) {
  const f = fixture();
  const { patient, mobile } = await bookedAndExamined(browser);

  // The doctor issues the proforma from the appointment of the received patient.
  const doctor = await staffPage(
    browser,
    f.doctor,
    STACK.webUrl,
    '/panel/login',
    '/panel/appointments',
  );
  const row = doctor.getByRole('row').filter({ hasText: maskedMobile(mobile) });
  await row.getByRole('link', { name: 'صدور پیش‌فاکتور' }).click();
  await expect(doctor).toHaveURL(/\/panel\/proformas\/new/);
  await doctor.getByLabel('قیمت واحد (ریال)').fill('۶٬۰۰۰٬۰۰۰');
  await doctor.getByRole('button', { name: 'ذخیره و صدور برای بیمار' }).click();
  await expect(doctor.getByText('صادرشده، در انتظار بیمار')).toBeVisible();
  await checkPage(doctor);

  // The patient confirms it, compares the plans (Jalali installments) and chooses one.
  await patient.goto('/me/proformas');
  await patient.getByRole('link', { name: 'مشاهده و پاسخ' }).first().click();
  await patient.getByRole('button', { name: 'تأیید پیش‌فاکتور' }).click();
  await expect(patient.getByRole('group', { name: 'انتخاب طرح اعتباری' })).toBeVisible();
  await patient.getByText('۱۲ قسط', { exact: false }).first().click();
  await expect(patient.getByRole('table', { name: 'جدول اقساط' }).getByRole('row')).toHaveCount(13);
  // M1 §8.7 option ب (owner 1405/07/22): every preview figure is labelled approximate.
  await expect(patient.getByRole('heading', { name: /پیش‌نمایش تقریبی/ })).toBeVisible();
  await expect(patient.getByRole('table', { name: 'جدول اقساط (تقریبی)' })).toBeVisible();
  await expect(patient.getByText('این مبالغ تقریبی‌اند.', { exact: false })).toBeVisible();
  await checkPage(patient);
  await patient.getByRole('button', { name: 'درخواست اعتبار با این طرح' }).click();
  await expect(patient).toHaveURL(/\/me\/credit\/[0-9a-f-]{36}$/);
  const applicationId = patient.url().split('/').pop() ?? '';

  // The draft shows its locked figures before it is submitted: fees, totals and installments.
  await expect(patient.getByRole('heading', { name: 'مبالغ قطعی این درخواست' })).toBeVisible();
  const locked = patient.getByRole('region', { name: 'مبالغ قطعی این درخواست' });
  await expect(locked.getByRole('table', { name: 'جدول اقساط' }).getByRole('row')).toHaveCount(13);
  await expect(locked.getByText('سررسید (تقریبی)')).toBeVisible();
  await checkPage(patient);

  // Submitted; the borrower consents by code and uploads the documents.
  await patient.getByRole('button', { name: 'ارسال درخواست برای بررسی' }).click();
  await expect(patient.getByText('در حال تکمیل مدارک')).toBeVisible();
  const loginCode = await otpFor(mobile);
  await patient.getByRole('button', { name: 'ارسال کد تأیید به موبایل من' }).click();
  await patient.getByLabel('کد پیامک‌شده').fill(await nextOtpFor(mobile, loginCode));
  await patient.getByRole('button', { name: 'موافقم و رضایت می‌دهم' }).click();
  await expect(patient.getByText('رضایت شما ثبت شد.')).toBeVisible();
  await uploadAll(patient);
  await checkPage(patient);

  // Case completion accepts them and sends the application on to credit review.
  const completion = await staffPage(
    browser,
    f.completion,
    STACK.adminUrl,
    '/login',
    `/credit/${applicationId}`,
  );
  await acceptAll(completion);
  await completion.getByRole('button', { name: 'ارسال به بررسی اعتبار' }).click();
  await expect(completion.getByText('آماده بررسی').first()).toBeVisible();

  // The credit specialist enters the borrower's raw data; the engine grades «الف».
  const specialist = await staffPage(
    browser,
    f.creditSpecialist,
    STACK.adminUrl,
    '/login',
    `/credit/${applicationId}`,
  );
  const borrowerForm = specialist
    .getByRole('heading', { name: 'ثبت داده خام وام‌گیرنده' })
    .locator('xpath=following-sibling::form[1]');
  await borrowerForm.getByLabel('شغل فعال و قابل احراز').selectOption('official');
  await borrowerForm.getByLabel('شروع اشتغال').fill('۱۳۹۸/۰۱/۰۱');
  await borrowerForm.getByLabel('شروع اشتغال').press('Tab');
  await borrowerForm.getByLabel('پوشش حقوق / روزهای مجاز').selectOption('full');
  await borrowerForm.getByLabel('قسط تعهدات قبلی (ریال)').fill('1000000');
  await borrowerForm.getByLabel('قسط تازه (ریال)').fill('4000000');
  await borrowerForm.getByRole('button', { name: 'ثبت داده خام و اجرای موتور' }).click();
  await expect(
    specialist.getByRole('heading', { name: /برگه وام‌گیرنده.*رتبه الف/ }),
  ).toBeVisible();
  await checkPage(specialist);

  // A guarantor: introduced by the patient, consents by code, uploads, is documented.
  const guarantorMobile = newMobile();
  await patient.reload();
  await patient.getByLabel('موبایل ضامن').fill(`0${guarantorMobile}`);
  await patient.getByRole('button', { name: 'معرفی ضامن' }).click();
  await expect(patient.getByText('ضامن معرفی شد.')).toBeVisible();
  const guarantor = await (await browser.newContext()).newPage();
  await guarantor.goto('/login?next=%2Fme%2Fguarantees');
  await patientLogin(guarantor, guarantorMobile);
  await guarantor.getByRole('link', { name: 'رضایت و مدارک' }).click();
  await expect(guarantor.getByText(/تعهد شما/)).toBeVisible();
  const guarantorLogin = await otpFor(guarantorMobile);
  await guarantor.getByRole('button', { name: 'ارسال کد تأیید به موبایل من' }).click();
  await guarantor
    .getByLabel('کد پیامک‌شده')
    .fill(await nextOtpFor(guarantorMobile, guarantorLogin));
  await guarantor.getByRole('button', { name: 'موافقم و رضایت می‌دهم' }).click();
  // Once given, the form gives way to the state (the page reads it again).
  await expect(guarantor.getByText('رضایت داده‌اید')).toBeVisible();
  await uploadAll(guarantor);
  // The guarantor sees their commitment only: no score, grade or treatment.
  expect(await guarantor.locator('main').innerText()).not.toMatch(/رتبه|امتیاز|الف|دندان|ویزیت/);
  await checkPage(guarantor);
  await completion.reload();
  await acceptAll(completion);

  // The specialist scores the guarantor, sends the application to its decision, proposes.
  await specialist.reload();
  const guarantorForm = specialist
    .getByRole('heading', { name: 'ثبت داده خام ضامن ۱' })
    .locator('xpath=following-sibling::form[1]');
  await guarantorForm.getByLabel('شغل فعال و قابل احراز').selectOption('official');
  await guarantorForm.getByLabel('شروع اشتغال').fill('۱۳۹۵/۰۱/۰۱');
  await guarantorForm.getByLabel('شروع اشتغال').press('Tab');
  await guarantorForm.getByLabel('میانگین مانده حساب (ریال)').fill('30000000');
  await guarantorForm.getByLabel('قسط مورد ضمانت (ریال)').fill('900000');
  await guarantorForm.getByLabel('بدهی و ضمانت‌های قبلی').selectOption('none_or_very_low');
  await guarantorForm.getByLabel('استقلال مالی از وام‌گیرنده').selectOption('fully_independent');
  await guarantorForm.getByRole('button', { name: 'ثبت داده خام و اجرای موتور' }).click();
  await expect(specialist.getByRole('heading', { name: /برگه ضامن.*رتبه ممتاز/ })).toBeVisible();
  await specialist.getByRole('button', { name: 'ارسال به تصمیم' }).click();
  await expect(specialist.getByText('کارشناس اعتبار + کنترل دوم').first()).toBeVisible();
  await specialist.getByLabel('دلیل (الزامی)').fill('رتبه الف، ضامن ممتاز، مدارک کامل');
  await specialist.getByRole('button', { name: 'ثبت پیشنهاد' }).click();
  await expect(specialist.getByText('پیشنهادشده')).toBeVisible();

  // The credit manager gives the second check: approved.
  const manager = await staffPage(
    browser,
    f.creditManager,
    STACK.adminUrl,
    '/login',
    `/credit/${applicationId}`,
  );
  await manager.getByRole('button', { name: 'تأیید پیشنهاد' }).click();
  await expect(manager.getByText('نهایی')).toBeVisible();
  await checkPage(manager);

  // The patient sees the approval, the approved amount, and no score.
  await patient.reload();
  await expect(patient.getByText('تأییدشده').first()).toBeVisible();
  await expect(patient.getByText('مبلغ مصوب')).toBeVisible();
  expect(await patient.locator('main').innerText()).not.toMatch(/رتبه|امتیاز/);
  await checkPage(patient);

  return { patient, mobile, guarantor, guarantorMobile, applicationId, completion };
}

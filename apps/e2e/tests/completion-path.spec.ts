import { expect, test, type Page } from '@playwright/test';
import { formatJalaliDate, toJalali } from '@sepehr/contracts';
import { STACK } from '../src/stack-config.ts';
import { checkPage, throughDecision } from './credit-steps.ts';
import { fixture, nextOtpFor, otpFor, serviceCodeFor, staffPage } from './support.ts';

/**
 * Doc 13's acceptance path for 4-4: «تصمیم ← قرارداد ← پذیرش ← تحویل فیزیکی ← تأیید فیش ←
 * تکمیل». From an approved application (the 3-8 path), case completion asks for the
 * contract and the worker prints it; the borrower and the guarantor each accept it with a
 * code; the papers are listed, sent, received, the cheque registered (its number shown by
 * its last four only), confirmed in Sayad, verified and archived; the patient uploads each
 * receipt owed and finance approves them; case completion records the completion. Every
 * page on the way is Jalali only and has no serious accessibility violation.
 */

/** The smallest file whose bytes say PDF. */
const PDF = Buffer.from('%PDF-1.4\n1 0 obj << >> endobj\ntrailer << >>\n%%EOF\n');

/** A party accepts the contract on its page, with the code sent to their mobile. */
async function acceptContract(page: Page, mobile: string) {
  const previous = await otpFor(mobile);
  await page.getByRole('button', { name: 'ارسال کد پذیرش به موبایل من' }).click();
  await page.getByLabel('کد پیامک‌شده').fill(await nextOtpFor(mobile, previous));
  await page.getByRole('button', { name: 'قرارداد را می‌پذیرم' }).click();
  await expect(page.getByRole('listitem').filter({ hasText: '(شما)' })).toContainText('پذیرفت');
}

/** Clicks the first button of this name until none is left, each one refreshing the page. */
async function clickAll(page: Page, name: string) {
  for (;;) {
    const buttons = page.getByRole('button', { name, exact: true });
    const before = await buttons.count();
    if (before === 0) break;
    await buttons.first().click();
    await expect(buttons).toHaveCount(before - 1);
  }
}

test('decision → contract → acceptance → physical delivery → receipt approval → completion → funding → authorization → code → final', async ({
  browser,
}) => {
  test.setTimeout(900_000);
  const f = fixture();
  const { patient, mobile, guarantor, guarantorMobile, applicationId, completion } =
    await throughDecision(browser);
  // Unique per run: the stack may be reused, and numbers and references must not repeat.
  const stamp = String(Date.now()).slice(-10);
  const chequeNumber = `۱۲۳۴۵۶${stamp.replace(/\d/g, (d) => '۰۱۲۳۴۵۶۷۸۹'[Number(d)] ?? d)}`;
  const chequeLatin = `123456${stamp}`;

  // The completion queue lists the approved application; its checklist opens.
  await completion.goto('/completion');
  await expect(completion.getByRole('table', { name: 'پرونده‌های در صف تکمیل' })).toBeVisible();
  await checkPage(completion);
  await completion.goto(`/completion/${applicationId}`);
  await expect(completion.getByRole('list', { name: 'شرط‌های مانده' })).toContainText(
    'پذیرش قرارداد',
  );

  // The contract is asked for; the worker prints it.
  await completion.getByRole('button', { name: 'ساخت قرارداد' }).click();
  await expect(async () => {
    await completion.reload();
    await expect(completion.getByText('آماده پذیرش')).toBeVisible({ timeout: 2_000 });
  }).toPass({ timeout: 90_000 });
  await checkPage(completion);

  // The borrower accepts it with a code, then the guarantor, each on their own page.
  await patient.goto('/me/contracts');
  await checkPage(patient);
  await patient.getByRole('link', { name: 'مشاهده و پذیرش' }).first().click();
  await expect(patient.getByRole('heading', { name: 'قرارداد وام' })).toBeVisible();
  await acceptContract(patient, mobile);
  await checkPage(patient);
  await guarantor.reload();
  await guarantor.getByRole('link', { name: 'مشاهده و پذیرش قرارداد' }).click();
  await acceptContract(guarantor, guarantorMobile);
  await expect(guarantor.getByText('پذیرفته‌شده به‌دست همه طرفین')).toBeVisible();
  // The guarantor sees roles only: no score, grade, treatment or the borrower's mobile.
  expect(await guarantor.locator('main').innerText()).not.toMatch(/رتبه|امتیاز|دندان|ویزیت/);
  expect(await guarantor.locator('main').innerText()).not.toContain(mobile.slice(-4));
  await checkPage(guarantor);

  // Case completion lists the papers: the signed contract and one cheque.
  await completion.reload();
  await expect(completion.getByText('پذیرفته‌شده به‌دست همه طرفین')).toBeVisible();
  await completion.getByRole('button', { name: 'ثبت فهرست مدارک فیزیکی' }).click();
  await expect(completion.getByText('در انتظار ارسال')).toBeVisible();

  // The patient says they were sent by courier.
  await patient.goto(`/me/credit/${applicationId}`);
  await expect(patient.getByRole('heading', { name: 'قرارداد و تکمیل پرونده' })).toBeVisible();
  await patient.getByRole('button', { name: 'اعلام ارسال مدارک' }).click();
  await expect(patient.getByText('ارسال‌شده')).toBeVisible();
  await checkPage(patient);

  // Received; each item ticked; the cheque registered, confirmed in Sayad and verified.
  await completion.reload();
  await completion.getByRole('button', { name: 'ثبت دریافت مدارک' }).click();
  await expect(completion.getByText('رسیده، در حال بررسی')).toBeVisible();
  await clickAll(completion, 'رسید');
  const cheque = completion.getByRole('form', { name: 'ثبت چک' });
  await cheque.getByLabel('مبلغ چک (ریال)').fill('۲۰۰۰۰۰۰۰');
  await cheque.getByLabel('شماره صیادی').fill(chequeNumber);
  await cheque.getByRole('button', { name: 'ثبت چک' }).click();
  await expect(completion.getByText(`…${chequeLatin.slice(-4)}`)).toBeVisible();
  // The number is shown by its last four only (rule 27).
  expect(await completion.locator('main').innerText()).not.toContain(chequeLatin);
  await completion.getByRole('button', { name: 'تأیید ثبت در سامانه صیاد' }).click();
  await expect(completion.getByText('صیاد تأییدشده')).toBeVisible();
  await completion.getByRole('button', { name: 'بررسی‌شده', exact: true }).click();
  await completion.getByRole('button', { name: 'بررسی تحویل' }).click();
  await expect(completion.getByText('بررسی‌شده و کامل')).toBeVisible();
  await completion.getByLabel('محل بایگانی').fill('قفسه ۳، ردیف ۲');
  await completion.getByRole('button', { name: 'بایگانی', exact: true }).click();
  await expect(completion.getByText('بایگانی‌شده')).toBeVisible();
  await checkPage(completion);

  // The patient uploads a receipt for each amount owed, the exact amount, paid today.
  await patient.reload();
  const today = formatJalaliDate(toJalali(new Date()));
  const references: string[] = [];
  for (;;) {
    const forms = patient.getByRole('form', { name: /^فیش / });
    if ((await forms.count()) === 0) break;
    const form = forms.first();
    const title = ((await form.getAttribute('aria-label')) ?? '').replace(/^فیش /, '');
    const reference = `RF${stamp}${String(references.length)}`;
    references.push(reference);
    await form.getByLabel(`روز پرداخت ${title}`).fill(today);
    await form.getByLabel(`روز پرداخت ${title}`).press('Tab');
    await form.getByLabel('شماره پیگیری بانک').fill(reference);
    await form
      .getByLabel(`فایل فیش ${title}`)
      .setInputFiles({ name: 'receipt.pdf', mimeType: 'application/pdf', buffer: PDF });
    await form.getByRole('button', { name: `ارسال فیش ${title}` }).click();
    await expect(
      patient.getByRole('list', { name: `فیش‌های ${title}` }).getByText('در انتظار تأیید مالی'),
    ).toBeVisible();
  }
  // The plan's down payment and its origination fee (its plan fee is spread).
  expect(references).toHaveLength(2);
  await checkPage(patient);

  // Finance approves this application's receipts, which posts them (task 4-3).
  const finance = await staffPage(browser, f.finance, STACK.adminUrl, '/login', '/receipts');
  for (const reference of references) {
    const row = finance.getByRole('row').filter({ hasText: reference });
    await expect(row).toBeVisible();
    await checkPage(finance);
    await row.getByRole('button', { name: 'تأیید فیش' }).click();
    await expect(row).toHaveCount(0);
  }

  // Every condition holds; case completion records the completion.
  await completion.reload();
  await expect(completion.getByText('همه شرط‌ها برقرار است.')).toBeVisible();
  await completion.getByRole('button', { name: 'ثبت تکمیل پرونده' }).click();
  await expect(completion.getByText(/پرونده در .* تکمیل شد/)).toBeVisible();
  await checkPage(completion);

  // The patient sees it completed.
  await patient.reload();
  await expect(patient.getByText(/پرونده شما در .* تکمیل/)).toBeVisible();
  await checkPage(patient);

  // Task 4-7: funding (doc 12 §5). One person holding case completion and finance asks for
  // it, and is told they cannot approve their own request (doc 12 §9 test 2).
  const dual = await staffPage(
    browser,
    f.completionFinance,
    STACK.adminUrl,
    '/login',
    `/completion/${applicationId}`,
  );
  await dual.getByRole('button', { name: 'درخواست شارژ کیف اعتبار' }).click();
  await expect(dual.getByText('در انتظار تأیید مالی')).toBeVisible();
  await expect(dual.getByText('تأییدکننده نمی‌تواند درخواست خودش را تأیید کند.')).toBeVisible();
  await expect(dual.getByRole('button', { name: 'تأیید شارژ' })).toHaveCount(0);
  await checkPage(dual);
  await dual.goto('/funding');
  const ownRow = dual
    .getByRole('row')
    .filter({ has: dual.locator(`a[href="/completion/${applicationId}"]`) });
  await expect(ownRow).toContainText('تأییدکننده نمی‌تواند درخواست خودش را تأیید کند.');
  await checkPage(dual);

  // Another person in finance approves it on the funding queue.
  await finance.goto('/funding');
  const fundRow = finance
    .getByRole('row')
    .filter({ has: finance.locator(`a[href="/completion/${applicationId}"]`) });
  await expect(fundRow).toBeVisible();
  await checkPage(finance);
  await fundRow.getByRole('button', { name: 'تأیید شارژ' }).click();
  await expect(fundRow).toHaveCount(0);

  // The patient sees the purse, named from configuration, with its Jalali installments.
  await patient.reload();
  await expect(patient.getByRole('heading', { name: 'کیف اعتبار' })).toBeVisible();
  await expect(patient.getByRole('table', { name: 'اقساط' })).toBeVisible();
  await checkPage(patient);

  // The doctor sees the funded patient, allowed, with no amount (owner, task 4-6 پ۲); the
  // worker lists them from wallet.funded, so the page is read again until they appear.
  const doctor = await staffPage(
    browser,
    f.doctor,
    STACK.webUrl,
    '/panel/login',
    '/panel/patients',
  );
  await expect(async () => {
    await doctor.reload();
    await expect(doctor.getByRole('link', { name: 'صدور مجوز خدمت' }).first()).toBeVisible({
      timeout: 2_000,
    });
  }).toPass({ timeout: 90_000 });
  expect(await doctor.locator('main').innerText()).not.toMatch(/ریال|تومان/);
  await checkPage(doctor);

  // Authorization: one line of the proforma; the code goes to the borrower.
  await doctor.getByRole('link', { name: 'صدور مجوز خدمت' }).first().click();
  await expect(doctor.getByRole('heading', { name: 'صدور مجوز خدمت' })).toBeVisible();
  await doctor.getByRole('checkbox').first().check();
  await checkPage(doctor);
  await doctor.getByRole('button', { name: 'صدور و ارسال کد به بیمار' }).click();
  await expect(doctor).toHaveURL(/\/panel\/authorizations\//);
  await expect(doctor.getByText('منتظر کد بیمار')).toBeVisible();
  await checkPage(doctor);

  // The code, entered: recorded and, with no dispute window (doc 13 open item 5), final.
  await doctor.getByLabel('کد پیامک‌شده به بیمار').fill(await serviceCodeFor(mobile));
  await doctor.getByRole('button', { name: 'ثبت خدمت' }).click();
  await expect(doctor.getByText('خدمت ثبت و قطعی شد.')).toBeVisible();
  await checkPage(doctor);
  await doctor.goto('/panel/authorizations');
  await expect(doctor.getByRole('table', { name: 'مجوزهای خدمت' })).toContainText('قطعی‌شده');
  await checkPage(doctor);

  // The patient sees what was used, and where; never what the treatment was.
  await patient.reload();
  await expect(patient.getByRole('table', { name: 'تاریخچه مصرف' })).toContainText('قطعی‌شده');
  await checkPage(patient);

  // Finance's cancellations: a final service offers none (owner, task 4-6 ت۲).
  await finance.goto('/services');
  await expect(finance.getByRole('table', { name: 'مجوزهای خدمت' })).toContainText('قطعی‌شده');
  await checkPage(finance);

  // My account: the doctor proves a new mobile with the code sent to it (task 4-6, ف۴).
  await doctor.goto('/panel/account');
  const newDoctorMobile = `913${String(Math.floor(Math.random() * 1e7)).padStart(7, '0')}`;
  await doctor.getByLabel('موبایل تازه').fill(`0${newDoctorMobile}`);
  await doctor.getByRole('button', { name: 'ارسال کد' }).click();
  await doctor.getByLabel('کد پیامک‌شده').fill(await otpFor(newDoctorMobile));
  await doctor.getByRole('button', { name: 'تأیید موبایل' }).click();
  await expect(doctor.getByText(/تأیید شده است/)).toContainText(
    newDoctorMobile.slice(-4).replace(/\d/g, (d) => String.fromCharCode(0x06f0 + Number(d))),
  );
  await checkPage(doctor);
});

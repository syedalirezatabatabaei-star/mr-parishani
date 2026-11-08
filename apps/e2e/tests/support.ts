import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { expect, type APIResponse, type Browser, type Page } from '@playwright/test';
import { STACK_DIR, STAFF_PASSWORD, type Fixture, type SeededStaff } from '../src/stack-config.ts';
import { freshCode, totpStep } from '../src/totp.ts';

export const fixture = (): Fixture =>
  JSON.parse(readFileSync(resolve(STACK_DIR, 'fixture.json'), 'utf8')) as Fixture;

/** A mobile no other test uses, as 9XXXXXXXXX. */
export const newMobile = () => `912${String(Math.floor(Math.random() * 1e7)).padStart(7, '0')}`;

/** The login code the worker's development SMS printed for this mobile. */
export async function otpFor(mobile: string): Promise<string> {
  const masked = `${mobile.slice(0, 3)}***${mobile.slice(-4)}`;
  let code: string | undefined;
  await expect
    .poll(
      () => {
        try {
          const codes = JSON.parse(readFileSync(resolve(STACK_DIR, 'otp.json'), 'utf8')) as Record<
            string,
            string
          >;
          code = codes[masked];
        } catch {
          code = undefined;
        }
        return code;
      },
      { timeout: 20_000 },
    )
    .toBeTruthy();
  return code ?? '';
}

/**
 * The service code (task 4-7) the worker's development SMS printed for this mobile, other
 * than `previous`: read from .stack/service-codes.json, never written to a log here.
 */
export async function serviceCodeFor(mobile: string, previous = ''): Promise<string> {
  const masked = `${mobile.slice(0, 3)}***${mobile.slice(-4)}`;
  let code = '';
  await expect
    .poll(
      () => {
        try {
          const codes = JSON.parse(
            readFileSync(resolve(STACK_DIR, 'service-codes.json'), 'utf8'),
          ) as Record<string, string>;
          code = codes[masked] ?? '';
        } catch {
          code = '';
        }
        return code !== '' && code !== previous;
      },
      { timeout: 30_000 },
    )
    .toBe(true);
  return code;
}

/** A code sent after `previous` (a consent code after the login code, task 3-8). */
export async function nextOtpFor(mobile: string, previous: string): Promise<string> {
  let code = previous;
  await expect
    .poll(
      async () => {
        code = await otpFor(mobile);
        return code;
      },
      { timeout: 20_000 },
    )
    .not.toBe(previous);
  return code;
}

/** Signs a patient in on the login page the browser is on. */
export async function patientLogin(page: Page, mobile: string) {
  await page.getByLabel('شماره موبایل').fill(`0${mobile}`);
  await page.getByRole('button', { name: 'دریافت کد ورود' }).click();
  await expect(page.getByText('کد ورود به شماره')).toBeVisible();
  await page.getByLabel('کد ورود').fill(await otpFor(mobile));
  await page.getByRole('button', { name: 'ورود', exact: true }).click();
}

/**
 * Signs a patient in, as patientLogin, but when a code was sent to them moments before (the
 * seed, or an earlier test) waits out the per-mobile wait as a person would, then asks again
 * and takes the new code (task 6-9).
 */
export async function patientLoginAfterWait(page: Page, mobile: string) {
  const previous = await otpFor(mobile);
  for (let i = 0; i < 40; i += 1) {
    await page.getByLabel('شماره موبایل').fill(`0${mobile}`);
    await page.getByRole('button', { name: 'دریافت کد ورود' }).click();
    const asked = page.getByText('کد ورود به شماره');
    const wait = page.getByText(/کد قبلی هنوز معتبر است/);
    await expect(asked.or(wait)).toBeVisible();
    if (await asked.isVisible()) break;
    await page.waitForTimeout(5_000);
    await page.reload();
  }
  await page.getByLabel('کد ورود').fill(await nextOtpFor(mobile, previous));
  await page.getByRole('button', { name: 'ورود', exact: true }).click();
}

const GREGORIAN_MONTHS = [
  'ژانویه',
  'فوریه',
  'مارس',
  'آوریل',
  'ژوئن',
  'ژوئیه',
  'اوت',
  'آگوست',
  'سپتامبر',
  'اکتبر',
  'نوامبر',
  'دسامبر',
  'January',
  'February',
  'March',
  'April',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];
const HIJRI_MONTHS = [
  'محرم',
  'ربیع‌الاول',
  'ربیع الاول',
  'ربیع‌الثانی',
  'ربیع الثانی',
  'جمادی‌الاول',
  'جمادی الاول',
  'جمادی‌الثانی',
  'جمادی الثانی',
  'رجب',
  'شعبان',
  'رمضان',
  'شوال',
  'ذی‌القعده',
  'ذی القعده',
  'ذی‌الحجه',
  'ذی الحجه',
];

const toAscii = (text: string) =>
  text
    .replace(/[۰-۹]/g, (d) => String(d.charCodeAt(0) - 0x06f0))
    .replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660));

/**
 * What a page shows or reads aloud that is a Gregorian or Hijri date (ADR-011, owner
 * decision 1405/07/08–09: Jalali only, everywhere): the month names of either calendar,
 * ISO days, and numeric dates whose year is not a Jalali year of this era (13xx–14xx up to
 * 1420; the Hijri year is past 1440). Machine-readable `<time dateTime>` is not shown.
 */
export async function nonJalaliDates(page: Page): Promise<string[]> {
  const shown = await page.evaluate(() => {
    const names = [...document.querySelectorAll('[aria-label], [title], [alt], [placeholder]')]
      .flatMap((e) => ['aria-label', 'title', 'alt', 'placeholder'].map((a) => e.getAttribute(a)))
      .filter((v): v is string => Boolean(v));
    const meta = document.querySelector('meta[name="description"]')?.getAttribute('content') ?? '';
    return [document.body.innerText, document.title, meta, ...names].join('\n');
  });
  const text = toAscii(shown);
  const found: string[] = [];
  for (const name of [...GREGORIAN_MONTHS, ...HIJRI_MONTHS]) {
    // A whole word: not inside another word (letters or a half-space around it).
    const word = String.raw`(^|[^\p{L}\u200c])${name}($|[^\p{L}\u200c])`;
    if (new RegExp(word, 'u').test(shown)) {
      found.push(`month name «${name}»`);
    }
  }
  for (const m of text.matchAll(/\b(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})\b/g)) {
    const year = Number(m[1]);
    if (year < 1300 || year > 1420) found.push(`date ${m[0]}`);
  }
  for (const m of text.matchAll(/\b(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})\b/g)) {
    found.push(`day-first date ${m[0]}`);
  }
  // A year written as a year: «سال ۲۰۲۶», «۲۰۲۶ میلادی», «2026 AD». A bare four-digit number
  // is not a year by itself (the last four digits of an ID, a code); dates are caught above.
  for (const m of text.matchAll(/(سال|year)\s*((19|20)\d{2})\b/giu)) {
    found.push(`Gregorian year ${m[2] ?? ''}`);
  }
  for (const m of text.matchAll(/\b((19|20)\d{2})\s*(میلادی|م\.|AD|CE)/gu)) {
    found.push(`Gregorian year ${m[1] ?? ''}`);
  }
  return found;
}

/**
 * Signs a seeded staff member in on a panel's login page (password, then TOTP). Every
 * code is for a step not used before (the API refuses a replay); the steps used are kept
 * in .stack/totp.json, and a step too far ahead of the clock waits for it.
 */
export async function staffLogin(page: Page, staff: SeededStaff) {
  const file = resolve(STACK_DIR, 'totp.json');
  let used: Record<string, number>;
  try {
    used = JSON.parse(readFileSync(file, 'utf8')) as Record<string, number>;
  } catch {
    used = {};
  }
  const last = used[staff.username] ?? staff.lastStep;
  // One step of drift is allowed: wait until the next unused step is at most one ahead.
  while (totpStep(Date.now()) + 1 < last + 1) await page.waitForTimeout(1000);
  const { step, code } = freshCode(staff.totpSecret, last);
  writeFileSync(file, JSON.stringify({ ...used, [staff.username]: step }));

  answerStepUps(page);
  await page.getByLabel('نام کاربری').fill(staff.username);
  await page.getByLabel('رمز عبور').fill(STAFF_PASSWORD);
  await page.getByRole('button', { name: 'ادامه' }).click();
  await page.getByLabel('کد تأیید').fill(code);
  await page.getByRole('button', { name: 'ورود', exact: true }).click();
}

/** Step-up codes this test process has typed, by masked mobile (each is good once). */
const typedStepUps = new Map<string, Set<string>>();

/**
 * ADR-052: answers every «SMS code» dialog on this staff page as the signer would, with the
 * code the worker's development SMS printed for the masked mobile the dialog shows (read from
 * .stack/step-up-codes.json). It watches in the background, so a test clicks «approve» and
 * expects the result as before; a test about the dialog itself uses its own page.
 */
export function answerStepUps(page: Page) {
  const dialog = page.getByRole('dialog', { name: 'کد تأیید پیامکی' });
  void (async () => {
    for (;;) {
      await dialog.waitFor({ state: 'visible', timeout: 0 });
      const sent = dialog.getByText(/پیامک شد/);
      await sent.waitFor({ state: 'visible' });
      const masked = ((await sent.locator('span[dir="ltr"]').textContent()) ?? '').trim();
      const typed = typedStepUps.get(masked) ?? new Set<string>();
      typedStepUps.set(masked, typed);
      let code = '';
      await expect
        .poll(
          () => {
            try {
              const codes = JSON.parse(
                readFileSync(resolve(STACK_DIR, 'step-up-codes.json'), 'utf8'),
              ) as Record<string, string[]>;
              code = [...(codes[masked] ?? [])].reverse().find((c) => !typed.has(c)) ?? '';
            } catch {
              code = '';
            }
            return code;
          },
          { timeout: 20_000 },
        )
        .not.toBe('');
      typed.add(code);
      await dialog.getByLabel('کد پیامک‌شده').fill(code);
      await dialog.getByRole('button', { name: 'تأیید', exact: true }).click();
      await dialog.waitFor({ state: 'hidden' });
    }
  })().catch(() => {
    // The page closed (or the test ended) while waiting: nothing left to answer.
  });
}

/** The newest code printed for this masked mobile that this test process has not typed yet. */
async function untypedStepUpCode(masked: string): Promise<string> {
  const typed = typedStepUps.get(masked) ?? new Set<string>();
  typedStepUps.set(masked, typed);
  let code = '';
  await expect
    .poll(
      () => {
        try {
          const codes = JSON.parse(
            readFileSync(resolve(STACK_DIR, 'step-up-codes.json'), 'utf8'),
          ) as Record<string, string[]>;
          code = [...(codes[masked] ?? [])].reverse().find((c) => !typed.has(c)) ?? '';
        } catch {
          code = '';
        }
        return code;
      },
      { timeout: 20_000 },
    )
    .not.toBe('');
  typed.add(code);
  return code;
}

/**
 * ADR-052: a POST a test sends to the API itself (not through a page's dialog), signed as its
 * staff member would: answered `step_up_required`, a code is asked for that operation, the one
 * the development SMS printed is read, and the same POST is sent again with it.
 */
export async function signedPost(
  page: Page,
  url: string,
  options: { headers: Record<string, string>; data?: unknown },
): Promise<APIResponse> {
  const first = await page.request.post(url, options);
  if (first.status() !== 403) return first;
  const body = (await first.json().catch(() => ({}))) as { error?: string; operation?: unknown };
  if (body.error !== 'step_up_required') return first;
  const sent = await page.request.post('/api/v1/identity/step-up/challenges', {
    headers: options.headers,
    data: body.operation,
  });
  expect(sent.status(), await sent.text()).toBe(201);
  const challenge = (await sent.json()) as { challengeId: string; maskedMobile: string };
  const code = await untypedStepUpCode(challenge.maskedMobile);
  return page.request.post(url, {
    ...options,
    headers: { ...options.headers, 'x-step-up': `${challenge.challengeId}.${code}` },
  });
}

/** In a center panel page, chooses the workplace of this doctor (a center has several). */
export async function chooseWorkplace(page: Page, doctorName: string, submit: string) {
  const select = page.getByLabel('پزشک و محل', { exact: true });
  const option = select.locator('option', { hasText: doctorName });
  await select.selectOption((await option.getAttribute('value')) ?? '');
  const value = (await option.getAttribute('value')) ?? '';
  await page.getByRole('button', { name: submit }).click();
  // nosemgrep: detect-non-literal-regexp -- test helper; the pattern comes from the test itself
  await expect(page).toHaveURL(new RegExp(`workplace=${value}`));
  // The page now shows that doctor.
  await expect(select).toHaveValue(value);
}

/** A mobile as the panel shows it, masked, in Persian digits (e.g. ۰۹۱۲***۱۲۳۴). */
export const maskedMobile = (mobile: string) =>
  `۰${mobile.slice(0, 3)}***${mobile.slice(-4)}`.replace(/\d/g, (d) =>
    String.fromCharCode(0x06f0 + Number(d)),
  );

/**
 * A new patient books the seeded doctor, the center manager approves and receives them
 * with the check-in code (the path of task 2-11), then records the examination, which a
 * proforma needs (owner 1405/07/23). Returns the patient's signed-in page.
 */
export async function bookedAndExamined(browser: Browser) {
  const { workplaceId, manager } = fixture();
  const mobile = newMobile();
  const patient = await (await browser.newContext()).newPage();
  await patient.goto(`/book/${workplaceId}`);
  await patientLogin(patient, mobile);
  await patient
    .getByRole('group', { name: 'روز و ساعت نوبت' })
    .locator('[role="grid"] button[aria-label*="ظرفیت"]:not([aria-disabled="true"])')
    .first()
    .click();
  await patient
    .getByRole('group', { name: /^زمان‌های/ })
    .getByRole('button')
    .first()
    .click();
  await patient.getByRole('button', { name: 'ثبت درخواست نوبت' }).click();
  await expect(patient.getByText('درخواست نوبت ثبت شد')).toBeVisible();

  const staff = await (await browser.newContext()).newPage();
  await staff.goto(
    `/panel/login?next=${encodeURIComponent(`/panel/appointments?workplace=${workplaceId}`)}`,
  );
  await staffLogin(staff, manager);
  const row = staff.getByRole('row').filter({ hasText: maskedMobile(mobile) });
  await row.getByRole('button', { name: 'تأیید' }).click();
  await expect(row).toContainText('تأییدشده');
  await patient.goto('/me/appointments');
  const mine = patient.getByRole('list', { name: 'فهرست نوبت‌ها' }).getByRole('listitem').first();
  const code = (await mine.getByText('کد پذیرش در مرکز').locator('span').textContent()) ?? '';
  await row.getByRole('button', { name: 'پذیرش' }).click();
  await row.getByLabel('کد پذیرش بیمار').fill(code);
  await row.getByRole('button', { name: 'پذیرش' }).click();
  await expect(row).toContainText('پذیرش‌شده');
  // A proforma is issued only once the visit is examined (owner 1405/07/23).
  await row.getByRole('button', { name: 'معاینه شد' }).click();
  await expect(row.getByRole('button', { name: 'معاینه شد' })).toHaveCount(0);
  await staff.context().close();
  return { patient, mobile };
}

/**
 * A new page in a fresh context, signed in to a panel as this staff member: the center
 * panel (`/panel/login` on the web app) or the internal panel (`/login` on its own app).
 */
export async function staffPage(
  browser: Browser,
  staff: SeededStaff,
  baseURL: string,
  login: '/panel/login' | '/login',
  path: string,
) {
  const page = await (await browser.newContext({ baseURL })).newPage();
  await page.goto(`${login}?next=${encodeURIComponent(path)}`);
  await staffLogin(page, staff);
  await expect(page).toHaveURL((url) => `${url.pathname}${url.search}` === path);
  return page;
}

/** axe-core on the page as it stands: the serious and critical violations (WCAG A and AA). */
export async function seriousA11yViolations(page: Page): Promise<string[]> {
  await page.addScriptTag({ path: createRequire(import.meta.url).resolve('axe-core') });
  const result = await page.evaluate(async () => {
    const axe = (
      window as unknown as {
        axe: {
          run: (
            ctx: Document,
            opts: unknown,
          ) => Promise<{ violations: { id: string; impact: string | null; nodes: unknown[] }[] }>;
        };
      }
    ).axe;
    return axe.run(document, { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa'] } });
  });
  return result.violations
    .filter((v) => v.impact === 'serious' || v.impact === 'critical')
    .map((v) => `${v.id} (${String(v.nodes.length)})`);
}

/** The ☰ menu opened (owner 1405/08/10): its navigation of every section the account has. */
export async function menuNav(page: Page, name: string) {
  await page.getByRole('button', { name: 'منو', exact: true }).click();
  const nav = page.getByRole('dialog').getByRole('navigation', { name });
  await expect(nav).toBeVisible();
  return nav;
}

/** Owner 1405/08/10: the one-time link's token the dev SMS printed for this mobile. */
export async function setupTokenFor(mobile: string): Promise<string> {
  const masked = `${mobile.slice(0, 3)}***${mobile.slice(-4)}`;
  let token: string | undefined;
  await expect
    .poll(
      () => {
        try {
          const links = JSON.parse(
            readFileSync(resolve(STACK_DIR, 'setup-links.json'), 'utf8'),
          ) as Record<string, string>;
          token = links[masked];
        } catch {
          token = undefined;
        }
        return token;
      },
      { timeout: 30_000 },
    )
    .toBeTruthy();
  return token ?? '';
}

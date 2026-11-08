import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, test, type Browser, type Page } from '@playwright/test';
import { fundedPurse } from '../src/seed-funded.ts';
import { STACK, STACK_DIR, type SeededStaff } from '../src/stack-config.ts';
import { bookedAndExamined, fixture, staffPage } from './support.ts';

/**
 * The owner's visual approval of ج۳ (ADR-050, 1405/08/01): the wage-only plan's materials row in
 * the patient's plan chooser; the plan absent when the down payment reaches the wage; the split
 * check on the credit page, waiting then done; and the doctor's form with the material line
 * greyed out. Only with VISUAL=1; saved to VISUAL_OUT (outside the repository), else
 * .stack/visual-owner-0801. The material service, its price and the wage-only plan exist in this
 * throwaway database only, set through the API as the panel's people would.
 */
const OUT = process.env['VISUAL_OUT'] ?? resolve(STACK_DIR, 'visual-owner-0801');
const reason = { reason: 'آزمون بصری طرح فقط دستمزد' };

const shot = async (page: Page, name: string) => {
  await page.waitForLoadState('networkidle');
  await page.screenshot({ path: resolve(OUT, `${name}.png`), fullPage: true });
};

type Body = Record<string, unknown>;

/** API calls with a signed-in page's own session (cookie and CSRF), as the panel makes them. */
async function as(page: Page) {
  const me = (await (await page.request.get('/api/v1/auth/me')).json()) as { csrfToken: string };
  return async (method: string, path: string, body?: unknown): Promise<Body> => {
    const res = await page.request.fetch(`/api/v1${path}`, {
      method,
      headers: { 'x-csrf-token': me.csrfToken, origin: new URL(page.url()).origin },
      ...(body === undefined ? {} : { data: body }),
    });
    const text = await res.text();
    if (!res.ok()) throw new Error(`${method} ${path} → ${String(res.status())} ${text}`);
    return (text ? JSON.parse(text) : {}) as Body;
  };
}

const WAGE_PLAN = {
  code: 'wage_isfahan',
  title: 'طرح فقط دستمزد (آزمون)',
  active: true,
  cityCode: 'isfahan',
  treatmentFieldCodes: ['dental'],
  doctorIds: null,
  minAmountRial: '1000000',
  maxAmountRial: '500000000',
  downPayment: { basis: 'percent', bps: 1800 },
  installmentCounts: [6, 12],
  planFee: { basis: 'percent', bps: 0, timing: 'spread' },
  originationFee: { basis: 'fixed', rial: '500000' },
  percentRoundingRial: '10',
  financeableBasis: 'wage',
};
/** The seed's own plan, kept as it is (the new version lists both). */
const SEED_PLAN = {
  code: 'dental_isfahan',
  title: 'طرح درمان دندان اصفهان',
  active: true,
  cityCode: 'isfahan',
  treatmentFieldCodes: ['dental'],
  doctorIds: null,
  minAmountRial: '1000000',
  maxAmountRial: '500000000',
  downPayment: { basis: 'percent', bps: 2000 },
  installmentCounts: [6, 12],
  planFee: { basis: 'percent', bps: 1000, timing: 'spread' },
  originationFee: { basis: 'fixed', rial: '500000' },
  percentRoundingRial: '10',
};

async function signed(browser: Browser, who: SeededStaff, panel: 'admin' | 'web', path: string) {
  return panel === 'admin'
    ? staffPage(browser, who, STACK.adminUrl, '/login', path)
    : staffPage(browser, who, STACK.webUrl, '/panel/login', path);
}

/** A patient booked and examined, then a proforma of these lines issued and confirmed. */
async function confirmedProforma(
  browser: Browser,
  doctor: (method: string, path: string, body?: unknown) => Promise<Body>,
  lines: Body[],
) {
  const { patient } = await bookedAndExamined(browser);
  // A new patient: their one appointment, the one just examined.
  const page = (await (await patient.request.get('/api/v1/booking/me/appointments')).json()) as {
    items: { id: string }[];
  };
  const appointmentId = page.items[0]?.id;
  const made = await doctor('POST', '/proformas', { appointmentId, lines });
  const proformaId = String(made['id']);
  await doctor('POST', `/proformas/${proformaId}/issue`);
  await patient.goto(`/me/proformas/${proformaId}`);
  await patient.getByRole('button', { name: 'تأیید پیش‌فاکتور' }).click();
  await expect(patient.getByRole('group', { name: 'انتخاب طرح اعتباری' })).toBeVisible();
  return { patient, proformaId };
}

test.skip(process.env['VISUAL'] !== '1', 'screenshots only for the owner’s review (VISUAL=1)');

test('screenshots for the owner (1405/08/01, ج۳)', async ({ browser }) => {
  test.setTimeout(1_200_000);
  mkdirSync(OUT, { recursive: true });
  const f = fixture();

  // The material service and its price at the doctor's workplace; the wage-only plan.
  const network = await as(await signed(browser, f.networkManager, 'admin', '/'));
  await network('POST', '/catalog/services', {
    fieldCode: 'dental',
    code: 'implant_material',
    name: 'مواد ایمپلنت',
    costKind: 'material',
    ...reason,
  });
  const center = await as(await signed(browser, f.manager, 'web', '/panel'));
  await center('POST', '/catalog/tariffs', {
    owner: { kind: 'workplace', workplaceId: f.workplaceId },
    serviceCode: 'implant_material',
    pricing: { kind: 'range', minRial: '1000000', maxRial: '50000000' },
    ...reason,
  });
  const strategyA = await as(await signed(browser, f.strategyA, 'admin', '/settings'));
  const strategyB = await as(await signed(browser, f.strategyB, 'admin', '/settings'));
  const proposed = await strategyA('POST', '/config/proposals', {
    key: 'credit.plans',
    scope: { level: 'global' },
    value: { plans: [SEED_PLAN, WAGE_PLAN] },
    ...reason,
  });
  await strategyB('POST', `/config/proposals/${String(proposed['id'])}/approve`, {});
  const doctorPage = await signed(browser, f.doctor, 'web', '/panel');
  const doctor = await as(doctorPage);

  // 1. The materials row: T = 15,000,000; W = 6,000,000 (the visit); M = 9,000,000.
  const first = await confirmedProforma(browser, doctor, [
    { serviceCode: 'visit', quantity: 1, unitRial: '6000000' },
    { serviceCode: 'implant_material', quantity: 1, unitRial: '9000000' },
  ]);
  await first.patient.locator(`label[for="plan-${WAGE_PLAN.code}-12"]`).click();
  await expect(first.patient.getByText('از آن، هزینه مواد (وام فقط دستمزد)')).toBeVisible();
  await shot(first.patient, 'p39-01-plan-chooser-materials-row');

  // 2. Down payment ≥ W: T = 35,000,000; D = 6,300,000 ≥ W = 5,000,000. The plan is not offered.
  const second = await confirmedProforma(browser, doctor, [
    { serviceCode: 'visit', quantity: 1, unitRial: '5000000' },
    { serviceCode: 'implant_material', quantity: 1, unitRial: '30000000' },
  ]);
  // ADR-050 amendment: named only, with the neutral message and no figure.
  await expect(
    second.patient.getByText(
      `${WAGE_PLAN.title}: این طرح برای این پیش‌فاکتور قابل ارائه نیست؛ با کارشناس تماس بگیرید.`,
    ),
  ).toBeVisible();
  await expect(second.patient.locator(`label[for^="plan-${WAGE_PLAN.code}-"]`)).toHaveCount(0);
  await shot(second.patient, 'p39-02-plan-chooser-wage-plan-not-offered-message');

  // 3–4. The split check on the credit page: waiting, then done.
  await first.patient.getByRole('button', { name: 'درخواست اعتبار با این طرح' }).click();
  await expect(first.patient).toHaveURL(/\/me\/credit\/[0-9a-f-]{36}$/);
  const applicationId = first.patient.url().split('/').pop() ?? '';
  await first.patient.getByRole('button', { name: 'ارسال درخواست برای بررسی' }).click();
  const credit = await signed(browser, f.creditSpecialist, 'admin', `/credit/${applicationId}`);
  const split = credit.getByRole('region', { name: /^تفکیک دستمزد و مواد/ });
  await expect(split.getByText('منتظر بررسی')).toBeVisible();
  await split.scrollIntoViewIfNeeded();
  await shot(credit, 'p39-03-credit-cost-split-waiting');
  await split.getByLabel('یادداشت بررسی').fill('دستمزد و مواد با پیش‌فاکتور خوانده شد');
  await split.getByRole('button', { name: 'تفکیک بررسی شد' }).click();
  await expect(split.getByText('بررسی شد', { exact: true })).toBeVisible();
  await shot(credit, 'p39-04-credit-cost-split-reviewed');

  // 5. A funded wage-only purse: the doctor's form greys the material line out.
  const pages = new Map<string, (m: string, p: string, b?: unknown) => Promise<Body>>([
    ['doctor', doctor],
    ['center', center],
    ['completion', await as(await signed(browser, f.completion, 'admin', '/'))],
    ['creditSpecialist', await as(credit)],
    ['creditManager', await as(await signed(browser, f.creditManager, 'admin', '/'))],
    ['finance', await as(await signed(browser, f.finance, 'admin', '/'))],
    ['completionFinance', await as(await signed(browser, f.completionFinance, 'admin', '/'))],
  ]);
  // Staff by name through their pages; a patient's bearer token straight to the API.
  const call = async (method: string, path: string, token?: string, body?: unknown) => {
    const staff = token === undefined ? undefined : pages.get(token);
    if (staff) return staff(method, path, body);
    const res = await fetch(`${STACK.apiUrl}/api/v1${path}`, {
      method,
      headers: {
        'content-type': 'application/json',
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`${method} ${path} → ${String(res.status)} ${text}`);
    return (text ? JSON.parse(text) : {}) as Body;
  };
  const funded = await fundedPurse(
    call,
    {
      doctor: 'doctor',
      center: 'center',
      completion: 'completion',
      creditSpecialist: 'creditSpecialist',
      creditManager: 'creditManager',
      finance: 'finance',
      completionFinance: 'completionFinance',
    },
    f.workplaceId,
    {
      planCode: WAGE_PLAN.code,
      lines: [
        { serviceCode: 'visit', quantity: 1, unitRial: '6000000' },
        { serviceCode: 'implant_material', quantity: 1, unitRial: '9000000' },
      ],
      beforeDecision: async (id) => {
        await call('POST', `/credit/applications/${id}/cost-split-review`, 'creditSpecialist', {
          note: 'تفکیک بررسی شد (آزمون بصری)',
        });
      },
    },
  );
  await doctorPage.goto(`/panel/patients/${funded.purseId}`);
  await expect(doctorPage.getByText('(هزینه مواد؛ بیمار نقد به شما می‌پردازد)')).toBeVisible();
  await shot(doctorPage, 'p39-05-doctor-lines-material-greyed');
});

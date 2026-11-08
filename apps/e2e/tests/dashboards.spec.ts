import { expect, test, type Page } from '@playwright/test';
import { CONTROL_URL, STACK } from '../src/stack-config.ts';
import { checkPage } from './credit-steps.ts';
import { fixture, staffPage } from './support.ts';

/**
 * Task 7-5 acceptance (doc 18; doc 17 §3): the CEO's dashboard and one unit's, with their tiles,
 * their chart and its equivalent data table and how fresh they are; Jalali only and no serious
 * axe violation; another unit's dashboard refused; the panel's performance budget.
 */

/** The reports' views refreshed now, through the stack's control (as the worker does). */
async function refresh() {
  const res = await fetch(`${CONTROL_URL}/report-refresh`, { method: 'POST' });
  expect(res.status, await res.text()).toBe(200);
}

const PERSIAN_NUMBER = /^[۰-۹٬,.٪\s]+(?:تومان)?\s*٪?$/;

async function tiles(page: Page, labels: readonly string[]) {
  for (const label of labels) {
    const value = page.getByText(label, { exact: true }).locator('xpath=following-sibling::dd[1]');
    await expect(value).toBeVisible();
    expect((await value.innerText()).trim(), label).toMatch(/[۰-۹]|—/);
  }
}

test.beforeAll(async () => {
  await refresh();
});

test('the CEO’s dashboard: tiles, the six months’ chart and its table, how fresh', async ({
  browser,
}) => {
  const f = fixture();
  const page = await staffPage(browser, f.ceo, STACK.adminUrl, '/login', '/dashboard');
  await expect(page.getByRole('heading', { name: 'داشبورد مدیرعامل' })).toBeVisible();
  await expect(page.getByText(/^به‌روز تا [۰-۹]{4}\/[۰-۹]{2}\/[۰-۹]{2}/)).toBeVisible();
  await tiles(page, ['پرونده‌های فعال', 'شارژ این ماه', 'مانده بدهی', 'نسبت معوق', 'شکایات باز']);
  const chart = page.getByRole('figure', { name: 'شارژ و وصول شش ماه اخیر' });
  await expect(chart.getByRole('img')).toBeVisible();
  // Two series: a legend names them (identity never by color alone).
  await expect(chart.getByRole('listitem')).toHaveText(['شارژشده', 'وصول‌شده']);
  await chart.getByText('جدول داده').click();
  const table = chart.getByRole('table', { name: 'شارژ و وصول شش ماه اخیر' });
  await expect(table.getByRole('row')).toHaveCount(7);
  // The seeded loans were funded this month: the last month's charge is not zero.
  const last = await table.getByRole('row').last().getByRole('cell').first().innerText();
  expect(last).not.toBe('۰ تومان');
  expect(last).toMatch(PERSIAN_NUMBER);
  await checkPage(page);
});

test('a unit’s dashboard: its queue and agents; another unit refused', async ({ browser }) => {
  const f = fixture();
  const page = await staffPage(browser, f.support, STACK.adminUrl, '/login', '/dashboard/units');
  await page.getByRole('link', { name: 'پشتیبانی', exact: true }).click();
  await expect(page).toHaveURL(/\/dashboard\/units\/support$/);
  await expect(page.getByRole('heading', { name: 'داشبورد پشتیبانی' })).toBeVisible();
  await tiles(page, ['تیکت باز', 'بی کارشناس', 'گذشته از مهلت', 'در خطر']);
  const chart = page.getByRole('figure', { name: 'تیکت‌های ثبت‌شده در ۱۴ روز اخیر' });
  await expect(chart.getByRole('img')).toBeVisible();
  // One series: no legend box; the title names it.
  await expect(chart.getByRole('listitem')).toHaveCount(0);
  await chart.getByText('جدول داده').click();
  await expect(chart.getByRole('table').getByRole('row')).toHaveCount(15);
  // The seed's ticket, taken by support: open, and in support's load.
  const open = page
    .getByText('تیکت باز', { exact: true })
    .locator('xpath=following-sibling::dd[1]');
  expect(await open.innerText()).toMatch(/[۱-۹]/);
  await expect(page.getByRole('table', { name: 'بار باز کارشناسان' })).toBeVisible();
  await checkPage(page);
  // Not a unit of support's: refused by the API, said on the page.
  await page.goto('/dashboard/units/accounting');
  // The page's own alert, not Next's (empty) route announcer, which is an alert too.
  await expect(
    page.getByRole('alert').filter({ hasText: 'این صف مال واحد شما نیست.' }),
  ).toBeVisible();
  expect(await page.getByRole('table').count()).toBe(0);
});

test('the panel’s budget: the CEO’s dashboard on a slowed machine', async ({ browser }) => {
  const f = fixture();
  const page = await staffPage(browser, f.ceo, STACK.adminUrl, '/login', '/dashboard');
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Network.enable');
  await cdp.send('Network.setCacheDisabled', { cacheDisabled: true });
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });
  await page.addInitScript(() => {
    const w = window as unknown as { __perf: { lcp: number; cls: number } };
    w.__perf = { lcp: 0, cls: 0 };
    new PerformanceObserver((list) => {
      for (const e of list.getEntries()) w.__perf.lcp = e.startTime;
    }).observe({ type: 'largest-contentful-paint', buffered: true });
    new PerformanceObserver((list) => {
      for (const e of list.getEntries() as (PerformanceEntry & {
        value: number;
        hadRecentInput: boolean;
      })[]) {
        if (!e.hadRecentInput) w.__perf.cls += e.value;
      }
    }).observe({ type: 'layout-shift', buffered: true });
  });
  await page.reload({ waitUntil: 'load' });
  await page.waitForLoadState('networkidle');
  await page.waitForTimeout(500);
  const m = await page.evaluate(
    () => (window as unknown as { __perf: { lcp: number; cls: number } }).__perf,
  );
  await cdp.detach();
  test.info().annotations.push({
    type: 'measured',
    description: `LCP ${String(Math.round(m.lcp))} ms, CLS ${m.cls.toFixed(3)}`,
  });
  expect(m.lcp, 'LCP measured').toBeGreaterThan(0);
  expect(m.lcp, 'LCP').toBeLessThanOrEqual(2500);
  expect(m.cls, 'CLS').toBeLessThanOrEqual(0.1);
});

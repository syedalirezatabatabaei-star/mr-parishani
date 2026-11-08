import { expect, test, type Browser, type Page } from '@playwright/test';
import { STACK, type SeededStaff } from '../src/stack-config.ts';
import { fixture, newMobile, patientLogin, staffLogin } from './support.ts';

/**
 * The phone's bottom bar (owner 1405/08/11): every label whole on one or two lines (no
 * overflow, no ellipsis) at 360, 390 and 428 pixels, for the strategy manager, the CEO,
 * accounting, a center manager and a patient; and the page's last content above the bar once
 * scrolled to the end.
 */
const WIDTHS = [360, 390, 428];

async function checkBar(page: Page) {
  const bar = page.getByRole('navigation', { name: 'میانبرها' });
  await expect(bar).toBeVisible();
  const labels = await bar.locator('[data-short-label]').evaluateAll((spans) =>
    spans.map((s) => {
      const el = s as HTMLElement;
      const style = getComputedStyle(el);
      const link = el.closest('a') as HTMLElement;
      return {
        text: el.textContent,
        overflows: el.scrollWidth > el.clientWidth + 1 || link.scrollWidth > link.clientWidth + 1,
        ellipsis: style.textOverflow === 'ellipsis',
        lines: Math.round(el.getBoundingClientRect().height / parseFloat(style.lineHeight)),
      };
    }),
  );
  expect(labels.length).toBeGreaterThanOrEqual(2);
  for (const l of labels) {
    expect(l.overflows, `${l.text} overflows`).toBe(false);
    expect(l.ellipsis, `${l.text} cut`).toBe(false);
    expect(l.lines, `${l.text} lines`).toBeLessThanOrEqual(2);
  }
  // At the end of the page, its last content is above the bar, not behind it.
  await page.evaluate(() => {
    window.scrollTo(0, document.documentElement.scrollHeight);
  });
  await page.waitForTimeout(200);
  const gap = await page.evaluate(() => {
    const main = document.getElementById('main');
    const nav = document.querySelector('nav[aria-label="میانبرها"]');
    const last = main?.lastElementChild;
    if (!last || !nav) return -1;
    return nav.getBoundingClientRect().top - last.getBoundingClientRect().bottom;
  });
  expect(gap).toBeGreaterThanOrEqual(0);
}

async function staffAt(
  browser: Browser,
  width: number,
  who: SeededStaff,
  base: string,
  login: string,
) {
  const page = await (
    await browser.newContext({ baseURL: base, viewport: { width, height: 800 }, isMobile: true })
  ).newPage();
  await page.goto(login);
  await staffLogin(page, who);
  await expect(page.getByRole('region', { name: 'خدمات' })).toBeVisible();
  return page;
}

for (const width of WIDTHS) {
  test(`the bottom bar at ${String(width)} pixels: whole labels, nothing hidden`, async ({
    browser,
  }) => {
    test.setTimeout(180_000);
    const f = fixture();
    for (const who of [f.strategyA, f.ceo, f.finance]) {
      const page = await staffAt(browser, width, who, STACK.adminUrl, '/login');
      await checkBar(page);
      await page.context().close();
    }
    const center = await staffAt(browser, width, f.manager, STACK.webUrl, '/panel/login');
    await checkBar(center);
    await center.context().close();

    const patient = await (
      await browser.newContext({
        baseURL: STACK.webUrl,
        viewport: { width, height: 800 },
        isMobile: true,
      })
    ).newPage();
    await patient.goto('/login');
    await patientLogin(patient, newMobile());
    await expect(patient).toHaveURL(`${STACK.webUrl}/me`);
    await checkBar(patient);
    await patient.context().close();
  });
}

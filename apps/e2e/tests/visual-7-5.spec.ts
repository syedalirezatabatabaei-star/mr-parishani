import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { CONTROL_URL, STACK, STACK_DIR } from '../src/stack-config.ts';
import { fixture, staffPage } from './support.ts';

/**
 * Task 7-5: screenshots of the dashboards for the owner's visual approval (CLAUDE.md §4), never
 * part of the acceptance run: only with VISUAL=1. Saved under .stack/visual-7-5/.
 */
const OUT = resolve(STACK_DIR, 'visual-7-5');
const shot = async (page: Page, name: string) => {
  await page.waitForLoadState('networkidle');
  await page.screenshot({ path: resolve(OUT, `${name}.png`), fullPage: true });
};

test.skip(process.env['VISUAL'] !== '1', 'screenshots only for the owner’s review (VISUAL=1)');

test('screenshots of the dashboards', async ({ browser }) => {
  test.setTimeout(300_000);
  mkdirSync(OUT, { recursive: true });
  const f = fixture();
  expect((await fetch(`${CONTROL_URL}/report-refresh`, { method: 'POST' })).status).toBe(200);

  const ceo = await staffPage(browser, f.ceo, STACK.adminUrl, '/login', '/dashboard');
  await shot(ceo, '01-ceo');
  await ceo.getByText('جدول داده').click();
  await shot(ceo, '02-ceo-table');
  await ceo.goto('/');
  await shot(ceo, '03-admin-home-sections');

  const unit = await staffPage(browser, f.support, STACK.adminUrl, '/login', '/dashboard/units');
  await shot(unit, '04-units');
  await unit.goto('/dashboard/units/support');
  await shot(unit, '05-unit-support');

  const doctor = await staffPage(
    browser,
    f.doctor,
    STACK.webUrl,
    '/panel/login',
    '/panel/dashboard',
  );
  await shot(doctor, '06-doctor-panel');
  const manager = await staffPage(
    browser,
    f.manager,
    STACK.webUrl,
    '/panel/login',
    '/panel/dashboard',
  );
  await shot(manager, '07-center-panel');
});

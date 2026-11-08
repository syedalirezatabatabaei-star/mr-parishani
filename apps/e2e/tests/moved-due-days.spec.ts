import { expect, test } from '@playwright/test';
import { formatJalaliDate } from '@sepehr/contracts';
import { STACK } from '../src/stack-config.ts';
import { checkPage } from './credit-steps.ts';
import { fixture, patientLogin } from './support.ts';

/**
 * Owner 1405/07/24: in «اقساط من», a due day moved off a holiday at funding says so, with its
 * nominal day: «جابه‌جا شد از [روز اصلی] به‌دلیل تعطیلی». Read only. The seeded loan's 2nd
 * and 3rd nominal due days are holidays and its case had the shift on.
 */
test('a due day moved off a holiday says where it came from', async ({ browser }) => {
  test.setTimeout(180_000);
  const f = fixture();
  const patient = await (await browser.newContext({ baseURL: STACK.webUrl })).newPage();
  await patient.goto('/login?next=%2Fme%2Frepayment');
  await patientLogin(patient, f.movedPatientMobile);
  await expect(patient).toHaveURL(/\/me\/repayment$/);

  const rows = patient.getByRole('table', { name: 'اقساط' }).getByRole('row');
  for (const [n, nominal] of f.movedNominalDays.entries()) {
    // Row 0 is the header; installment k is row k.
    const row = rows.nth(n + 2);
    await expect(row).toContainText(`جابه‌جا شد از ${formatJalaliDate(nominal)} به‌دلیل تعطیلی`);
  }
  // Only moved days carry the note: the two holidays, and any nominal day on a Friday.
  expect(await patient.getByText(/جابه‌جا شد از/).count()).toBeGreaterThanOrEqual(2);
  await checkPage(patient);
});

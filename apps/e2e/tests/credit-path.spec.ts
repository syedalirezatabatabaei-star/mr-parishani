import { test } from '@playwright/test';
import { throughDecision } from './credit-steps.ts';

/**
 * Doc 11's acceptance path for 3-8, whole: «صدور پیش‌فاکتور ← تأیید بیمار ← انتخاب طرح ←
 * مدارک ← امتیاز ← ضامن ← تصمیم». The doctor issues a proforma for a patient received at
 * the center; the patient confirms it, compares the plans and chooses one, submits,
 * consents and uploads documents; case completion accepts them; the credit specialist
 * scores the borrower; a guarantor consents and is documented and scored; the specialist
 * proposes the approval and the credit manager gives the second check. Every page on the
 * way is Jalali only and has no serious accessibility violation. The steps are in
 * credit-steps.ts (task 4-4), shared with the completion path.
 */
test('proforma → confirmation → plan → documents → score → guarantor → decision', async ({
  browser,
}) => {
  test.setTimeout(600_000);
  await throughDecision(browser);
});

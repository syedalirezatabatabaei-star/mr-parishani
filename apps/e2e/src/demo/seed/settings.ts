/**
 * The demo's settings, every one proposed by one person and approved by another through the
 * API (docs/ops/launch-day-settings.md), with the reason «نمونه دمو». The numbers are the
 * employer's (docs/pending-client-decisions.md) where it gave them, else samples marked so.
 */
import { person, as, type Body, type Person, type SeedState } from './context.ts';

export const DEMO = 'نمونه دمو';

/** The demo's credit plans: one per field, the wage-only plan of the annex, and a club plan. */
export function demoPlans(fieldCodes: readonly string[]) {
  const common = {
    active: true,
    cityCode: null,
    doctorIds: null,
    minAmountRial: '10000000',
    maxAmountRial: '1500000000',
    percentRoundingRial: '10' as const,
    // ADR-048: 3% of the whole bill at completion; 2% waived with 5 checked cheques.
    originationFee: { basis: 'percent' as const, bps: 300, base: 'proforma' as const },
    originationChequeWaiver: { minCheques: 5, bps: 200 },
    originationOfficerDiscountBps: 100,
  };
  const titles: Record<string, string> = {
    dental: 'دندان‌پزشکی',
    beauty: 'زیبایی',
    skin_hair: 'پوست و مو',
    slimming: 'لاغری',
    eye: 'چشم',
    hearing: 'سمعک',
    infertility: 'ناباروری',
  };
  return {
    plans: [
      ...fieldCodes.map((code) => ({
        ...common,
        code: `${code}_standard`,
        title: `طرح اعتبار ${titles[code] ?? code} (${DEMO})`,
        treatmentFieldCodes: [code],
        downPayment: { basis: 'percent' as const, bps: 1500 },
        installmentCounts: [6, 9, 12],
        planFee: { basis: 'percent' as const, bps: 1800, timing: 'spread' as const },
      })),
      {
        ...common,
        code: 'p07_220012',
        title: `زیبایی، فقط دستمزد (طرح ۰۷-۲۲۰۰۱۲، ${DEMO})`,
        treatmentFieldCodes: ['beauty', 'skin_hair'].filter((c) => fieldCodes.includes(c)),
        downPayment: { basis: 'percent' as const, bps: 1800 },
        installmentCounts: [12],
        planFee: { basis: 'percent' as const, bps: 0, timing: 'spread' as const },
        financeableBasis: 'wage' as const,
      },
      {
        ...common,
        code: 'club_six_month',
        title: `طرح شش‌ماهه اعضای باشگاه (${DEMO})`,
        treatmentFieldCodes: [...fieldCodes],
        downPayment: { basis: 'percent' as const, bps: 1000 },
        installmentCounts: [6],
        planFee: { basis: 'percent' as const, bps: 0, timing: 'spread' as const },
        // The annex: no cheque waiver on the six-month plans.
        originationChequeWaiver: undefined,
        requiresClubMembership: true,
      },
    ].map((p) => JSON.parse(JSON.stringify(p)) as Body),
  };
}

export async function current(who: Person, key: string): Promise<unknown> {
  const got = await as(who, 'GET', `/config/resolve?key=${encodeURIComponent(key)}`);
  return got['value'];
}

/** One key, proposed by one and approved by another (a no-op when it already holds the value). */
export async function setKey(
  proposer: Person,
  approver: Person,
  key: string,
  value: unknown,
  note = DEMO,
) {
  if (JSON.stringify(await current(proposer, key)) === JSON.stringify(value)) return;
  // A proposal left waiting by an earlier, stopped try is decided, not proposed again.
  const versions = (await as(
    proposer,
    'GET',
    `/config/keys/${encodeURIComponent(key)}/versions`,
  )) as unknown;
  const list = (
    Array.isArray(versions) ? versions : (((versions as Body)['items'] as Body[] | undefined) ?? [])
  ) as Body[];
  const waiting = list.find(
    (v) => v['status'] === 'proposed' && JSON.stringify(v['value']) === JSON.stringify(value),
  );
  const id = waiting
    ? String(waiting['id'])
    : String(
        (
          await as(proposer, 'POST', '/config/proposals', {
            key,
            scope: { level: 'global' },
            value,
            reason: note,
          })
        )['id'],
      );
  await as(approver, 'POST', `/config/proposals/${id}/approve`);
}

/**
 * Tickets (owner 1405/08/09): an answer within a day (two for a complaint) and a topic for
 * each unit the starting list leaves without one, so every unit's dashboard has work. Sample
 * numbers of this demo only. Set again on the real clock after the timeline: a migration's own
 * topics take effect when it ran (0064's complaints, today), after the seed's shifted past.
 */
export async function seedTicketTopics(state: SeedState) {
  const strat1 = person(state, 'strat1');
  const topics = (await current(strat1, 'ticket.topics')) as Body[];
  const unitTopics = [
    { code: 'center_onboarding', title: 'پیوستن مرکز و شعبه', unit: 'network_specialist' },
    { code: 'documents', title: 'مدارک پرونده', unit: 'case_completion' },
    { code: 'credit_question', title: 'پرسش اعتباری', unit: 'credit_specialist' },
    { code: 'advice', title: 'مشاوره انتخاب طرح', unit: 'advisor' },
  ].filter((t) => !topics.some((x) => x['code'] === t.code));
  // 0064's complaint topics, as that migration wrote them, for the shifted past before it ran.
  const complaints = [
    { code: 'complaint_financial', title: 'شکایت مالی', unit: 'accounting', financial: true },
    { code: 'complaint_doctor', title: 'شکایت از پزشک', unit: 'support', financial: false },
    { code: 'complaint_general', title: 'شکایت', unit: 'support', financial: false },
  ].filter((t) => !topics.some((x) => x['code'] === t.code));
  await setKey(
    strat1,
    person(state, 'strat2'),
    'ticket.topics',
    [
      ...topics.map((t) => ({ ...t, responseHours: t['kind'] === 'complaint' ? 48 : 24 })),
      ...unitTopics.map((t) => ({
        ...t,
        responseHours: 24,
        active: true,
        kind: 'ticket',
        financial: false,
      })),
      ...complaints.map((t) => ({ ...t, responseHours: 48, active: true, kind: 'complaint' })),
    ],
    `${DEMO}: مهلت پاسخ تیکت و موضوع هر واحد`,
  );
}

export async function seedSettings(state: SeedState) {
  const strat1 = person(state, 'strat1');
  const strat2 = person(state, 'strat2');
  const admin1 = person(state, 'admin1');
  const tech = person(state, 'tech');
  const business = (key: string, value: unknown, note = DEMO) =>
    setKey(strat1, strat2, key, value, note);
  const technical = (key: string, value: unknown, note = DEMO) =>
    setKey(admin1, tech, key, value, note);

  // Technical: the search on; the patients' login codes from one office address (the seed and
  // the show both come from 127.0.0.1) raised for this demo database only.
  await technical('catalog.search_enabled', true);
  const otp = (await current(admin1, 'identity.otp')) as Body;
  await technical(
    'identity.otp',
    {
      ...otp,
      sendsPerIpPerHour: 5000,
      resendCooldownSeconds: 5,
      sendsPerMobilePerHour: 40,
      sendsPerDevicePerHour: 5000,
    },
    `${DEMO}: همه درخواست‌ها از یک نشانی`,
  );
  const publicLimit = (await current(admin1, 'identity.public_rate_limit')) as Body;
  state.data['publicRateLimit'] = publicLimit;

  // Business, the employer's numbers (pending-client-decisions.md, the Mehr 1405 annex).
  await business('credit.formation_deposit_rial', '990000');
  await business('credit.borrower_exposure_cap', {
    basis: 'obligation',
    capRial: '1500000000',
    includeApprovedUnfunded: true,
  });
  await business('repayment.cancellation_penalty_bps', 1800);
  await business('repayment.cancellation_penalty_due_days', 30);
  await business(
    'notification.sms_credit_alert_rial',
    '20000000',
    `${DEMO}: آستانه هشدار اعتبار پیامک`,
  );
  // The cheque rule (ج۵): one borrower cheque per case, and promissory notes accepted.
  await business('instrument.borrower_cheque_min_count', 1);
  await business('instrument.promissory_enabled', true);
  // Durations: three days' grace on an installment, the defaults elsewhere.
  await business('repayment.grace_days', 3, `${DEMO}: مهلت سه‌روزه قسط`);
  await seedTicketTopics(state);
  await business('ticket.sla_warning_minutes', 360, `${DEMO}: هشدار شش ساعت پیش از مهلت`);
  await business(
    'settlement.provider_contract',
    { months: 12, startsOn: new Date().toISOString().slice(0, 10) },
    `${DEMO}: مدت قرارداد مراکز`,
  );

  // Texts and rules, labelled as samples, not the legal text.
  const template = (await current(strat1, 'contract.loan_template')) as Body;
  await business('contract.loan_template', {
    ...template,
    body: String(template['body']).replace(
      'پیش‌نویس — در انتظار تأیید حقوقی',
      `${DEMO} — متن آزمایشی، نه متن حقوقی`,
    ),
  });
  const consent = (await current(strat1, 'credit.consent_text')) as Body;
  await business('credit.consent_text', {
    ...consent,
    text: String(consent['text']).replace(
      'پیش‌نویس — در انتظار تأیید حقوقی',
      `${DEMO} — متن آزمایشی`,
    ),
  });
  // The scoring rules v1: today's rules, approved as a version of their own.
  const rules = await current(strat1, 'credit.scoring_ruleset');
  const proposed = await as(strat1, 'POST', '/config/proposals', {
    key: 'credit.scoring_ruleset',
    scope: { level: 'global' },
    value: rules,
    reason: `${DEMO}: قواعد امتیاز نسخه ۱`,
  });
  await as(strat2, 'POST', `/config/proposals/${String(proposed['id'])}/approve`);
}

/**
 * Task 9-4 (doc 19): realistic, made-up data for the penetration tester's staging (the e2e
 * stack, the local staging of task 9-2), on top of the seed. Everything goes through the
 * API as people would; nothing here writes the database but the seed's own mobile proof.
 *
 *   pnpm --filter @sepehr/e2e stack:staging        (builds must exist: pnpm turbo build)
 *
 * Adds: four more active centers in Isfahan with two doctors each (prices, hours, published
 * profiles), a second treatment field, a staff account with no role, twelve patients with
 * a requested visit (half with a ticket), four credit applications waiting in the credit
 * queue, an auditor, two committee members and the seeded doctor's secretary. Then writes
 * .stack/staging-accounts.md: every account by role, for the tester (untracked; it holds
 * TOTP secrets of this throwaway database only).
 */
import { randomBytes, randomInt } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { account, call, proveMobile, type Staff } from './seed.ts';
import { codeFor } from './seed-funded.ts';
import {
  STACK,
  STACK_DIR,
  STAFF_PASSWORD,
  type Fixture,
  type SeededStaff,
} from './stack-config.ts';
import { mobile, nationalId, personName, pick, sheba } from './synthetic.ts';
import { freshCode } from './totp.ts';

type Body = Record<string, unknown>;

const reason = { reason: 'داده ساختگی staging (تسک ۹-۴)' };

const CENTERS = [
  { name: 'کلینیک دندانپزشکی مهرگان', fields: ['dental'] },
  { name: 'مرکز چشم‌پزشکی نگاه', fields: ['ophthalmology'] },
  { name: 'درمانگاه زاینده‌رود', fields: ['dental', 'ophthalmology'] },
  { name: 'کلینیک لبخند سپاهان', fields: ['dental'] },
] as const;

const TITLES: Record<string, readonly string[]> = {
  dental: ['متخصص ارتودنسی', 'جراح دندانپزشک', 'متخصص ایمپلنت', 'دندانپزشک عمومی'],
  ophthalmology: ['متخصص چشم‌پزشکی', 'فوق‌تخصص قرنیه', 'جراح آب مروارید'],
};

const TICKETS = [
  ['پرسش درباره نوبت', 'آیا می‌توانم نوبتم را یک هفته عقب بیندازم؟'],
  ['پیش‌فاکتور', 'پیش‌فاکتور من هنوز صادر نشده است.'],
  ['ورود به حساب', 'کد ورود دیر به دستم می‌رسد.'],
  ['اطلاعات طرح', 'شرایط طرح اقساطی دندان را توضیح دهید.'],
] as const;

const lastSteps = new Map<string, number>();

/** A seeded staff member signed in again: password, then a TOTP code of a step not used. */
async function signIn(staff: SeededStaff): Promise<string> {
  const login = await call('POST', '/auth/staff/login', undefined, {
    username: staff.username,
    password: STAFF_PASSWORD,
    client: 'mobile',
  });
  const { code, step } = freshCode(
    staff.totpSecret,
    lastSteps.get(staff.username) ?? staff.lastStep,
  );
  lastSteps.set(staff.username, step);
  const done = await call('POST', '/auth/totp/verify', String(login['accessToken']), { code });
  return String(done['accessToken']);
}

/** A patient signed in by the login code the development SMS printed. */
async function patient(number: string): Promise<{ token: string; code: string }> {
  await call('POST', '/auth/otp/request', undefined, { mobile: `0${number}` });
  const code = await codeFor(number);
  const done = await call('POST', '/auth/otp/verify', undefined, {
    mobile: `0${number}`,
    code,
    client: 'mobile',
  });
  return { token: String(done['accessToken']), code };
}

const day = (offset: number) =>
  new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);

/** A requested visit on a free slot of the next two weeks (another slot if one was taken). */
async function book(token: string, workplaceId: string): Promise<string> {
  const slots = (await call(
    'GET',
    `/booking/workplaces/${workplaceId}/free-slots?from=${day(0)}&to=${day(13)}`,
    token,
  )) as unknown as { startsAt: string }[];
  for (let attempt = 0; attempt < 5 && slots.length > 0; attempt++) {
    const [slot] = slots.splice(randomInt(slots.length), 1);
    try {
      const held = await call('POST', '/booking/appointments/hold', token, {
        workplaceId,
        serviceCode: 'visit',
        startsAt: slot?.startsAt,
      });
      await call('POST', `/booking/appointments/${String(held['id'])}/request`, token);
      return String(held['id']);
    } catch (error) {
      if (!String(error).includes('→ 409')) throw error;
    }
  }
  throw new Error('no free slot');
}

export interface StagingData {
  readonly staff: { role: string; scope: string; who: SeededStaff }[];
  readonly patients: { mobile: string; has: string }[];
}

export async function stagingData(options: {
  env: NodeJS.ProcessEnv;
  ownerUrl: string;
  fixture: Fixture;
}): Promise<StagingData> {
  const { env, fixture } = options;
  const admin = await signIn(fixture.admin);
  const grant = (who: Staff, roleCode: string, scope: Body) =>
    call('POST', '/access/assignments', admin, {
      accountId: who.accountId,
      roleCode,
      scope,
      ...reason,
    });
  const [specialist, approver, noRole, auditor, committeeStrategy, committeeCollection] =
    await Promise.all([
      account(env, 'staff', 'stg_specialist'),
      account(env, 'staff', 'stg_network'),
      account(env, 'staff', 'stg_norole'),
      account(env, 'staff', 'stg_auditor'),
      account(env, 'staff', 'stg_committee_strategy'),
      account(env, 'staff', 'stg_committee_collection'),
    ]);
  await grant(specialist, 'network_specialist', { kind: 'city', code: 'isfahan' });
  await grant(approver, 'network_manager', { kind: 'global' });
  // The read-only auditor, and two committee members: a member votes for the unit of their
  // other role (credit.committee_units: strategy, collection, finance; at least two units).
  await grant(auditor, 'auditor', { kind: 'global' });
  await grant(committeeStrategy, 'credit_committee', { kind: 'global' });
  await grant(committeeStrategy, 'strategy_manager', { kind: 'global' });
  await grant(committeeCollection, 'credit_committee', { kind: 'global' });
  await grant(committeeCollection, 'collection', { kind: 'global' });
  await call('POST', '/catalog/fields', approver.token, {
    code: 'ophthalmology',
    name: 'چشم‌پزشکی',
    ...reason,
  });

  const managers: Staff[] = [];
  const workplaces: string[] = [];
  for (const [index, spec] of CENTERS.entries()) {
    const center = await call('POST', '/catalog/centers', specialist.token, {
      // Owner 1405/07/27: the registration form requires the contract term.
      contractTerm: { startsOn: '2026-10-01', months: 12 },
      personType: 'natural',
      identifier: nationalId(),
      name: spec.name,
      cityCode: 'isfahan',
      sheba: sheba(),
      accountHolderName: personName(),
      treatmentFieldCodes: spec.fields,
    });
    const centerId = String(center['id']);
    const documents = async (status: string) => {
      const detail = await call('GET', `/catalog/centers/${centerId}`, specialist.token);
      for (const doc of detail['documents'] as { code: string }[]) {
        await call('PUT', `/catalog/centers/${centerId}/documents/${doc.code}`, specialist.token, {
          status,
        });
      }
    };
    await documents('received');
    await call('POST', `/catalog/centers/${centerId}/submit`, specialist.token, reason);
    await documents('verified');
    const activation = await call(
      'POST',
      `/catalog/centers/${centerId}/activation-requests`,
      specialist.token,
      reason,
    );
    await call('POST', `/catalog/requests/${String(activation['id'])}/approve`, approver.token, {});
    const detail = await call('GET', `/catalog/centers/${centerId}`, specialist.token);
    const branch = (detail['branches'] as { id: string }[])[0]?.id;
    const manager = await account(env, 'center', `stg_manager${String(index + 1)}`);
    await proveMobile(options.ownerUrl, manager.accountId);
    await grant(manager, 'center_manager', { kind: 'center', nodeId: String(center['nodeId']) });
    managers.push(manager);

    for (const field of [spec.fields[0], spec.fields.at(-1) ?? spec.fields[0]]) {
      const doctor = await call('POST', '/catalog/doctors', specialist.token, {
        // Owner 1405/07/27: the registration form requires the contract term.
        contractTerm: { startsOn: '2026-10-01', months: 12 },
        name: `دکتر ${personName()}`,
        medicalCouncilNumber: String(randomInt(10_000_000, 99_999_999)),
        treatmentFieldCodes: [field],
        workplace: { kind: 'branch', branchId: branch },
        ...reason,
      });
      const doctorId = String(doctor['id']);
      const doctorDetail = await call('GET', `/catalog/doctors/${doctorId}`, specialist.token);
      const workplaceId = (doctorDetail['workplaces'] as { id: string }[])[0]?.id ?? '';
      const min = randomInt(30, 70) * 100_000;
      await call('POST', '/catalog/tariffs', manager.token, {
        owner: { kind: 'workplace', workplaceId },
        serviceCode: 'visit',
        pricing: { kind: 'range', minRial: String(min), maxRial: String(min + 3_000_000) },
        ...reason,
      });
      const afternoon = randomInt(2) === 1;
      await call('PUT', `/booking/workplaces/${workplaceId}/schedule`, manager.token, {
        ranges: ['saturday', 'sunday', 'monday', 'tuesday', 'wednesday'].map((weekday) => ({
          weekday,
          start: afternoon ? '15:00' : '09:00',
          end: afternoon ? '19:00' : '13:00',
          slotMinutes: 30,
          serviceCodes: ['visit'],
        })),
        ...reason,
      });
      await call('POST', `/catalog/doctors/${doctorId}/profile`, specialist.token, {
        slug: `dr-staging-${randomBytes(4).toString('hex')}`,
        ...reason,
      });
      await call('PUT', `/catalog/doctors/${doctorId}/profile/draft`, manager.token, {
        specialtyTitle: pick(TITLES[field] ?? ['پزشک']),
        biography: 'پزشک با سابقه در درمان بیماران سرپایی، با نوبت‌دهی منظم.',
        history: ['دکترای حرفه‌ای، دانشگاه علوم پزشکی اصفهان'],
        ...reason,
      });
      const submitted = await call(
        'POST',
        `/catalog/doctors/${doctorId}/profile/submit`,
        manager.token,
        reason,
      );
      await call(
        'POST',
        `/catalog/profile-versions/${String(submitted['id'])}/approve`,
        specialist.token,
        reason,
      );
      workplaces.push(workplaceId);
    }
  }

  // Twelve patients with a requested visit at the new doctors; every other one a ticket.
  const patients: { mobile: string; has: string }[] = [];
  for (let i = 0; i < 12; i++) {
    const number = mobile();
    const { token } = await patient(number);
    await book(token, pick(workplaces));
    let has = 'نوبت درخواست‌شده';
    if (i % 2 === 0) {
      const [subject, body] = pick(TICKETS);
      await call('POST', '/me/tickets', token, { topicCode: 'general', subject, body, links: [] });
      has += ' و تیکت';
    }
    patients.push({ mobile: number, has });
  }

  // Four credit applications at the seeded doctor, submitted with consent: the credit queue.
  const doctor = await signIn(fixture.doctor);
  const center = await signIn(fixture.manager);
  for (let i = 0; i < 4; i++) {
    const number = mobile();
    const signedIn = await patient(number);
    const appointmentId = await book(signedIn.token, fixture.workplaceId);
    // A proforma is issued only once the visit is examined (owner 1405/07/23), as seed-funded.
    const visit = `/booking/appointments/${appointmentId}`;
    const { status } = await call('GET', visit, center);
    if (status === 'requested')
      await call('POST', `${visit}/respond`, center, { decision: 'confirm' });
    const mine = await call('GET', `/booking/me/appointments/${appointmentId}`, signedIn.token);
    await call('POST', `${visit}/check-in`, center, { code: mine['checkInCode'] });
    await call('POST', `${visit}/examined`, center);
    const proforma = await call('POST', '/proformas', doctor, {
      appointmentId,
      lines: [{ serviceCode: 'visit', quantity: 1, unitRial: String(randomInt(50, 80) * 100_000) }],
    });
    const proformaId = String(proforma['id']);
    await call('POST', `/proformas/${proformaId}/issue`, doctor);
    await call('POST', `/me/proformas/${proformaId}/confirm`, signedIn.token);
    const app = await call('POST', '/me/credit-applications', signedIn.token, {
      proformaId,
      planCode: 'dental_isfahan',
      installmentCount: pick([6, 12]),
    });
    const applicationId = String(app['id']);
    await call('POST', `/me/credit-applications/${applicationId}/submit`, signedIn.token);
    await call('POST', `/me/credit-applications/${applicationId}/consent/request`, signedIn.token, {
      role: 'borrower',
    });
    await call('POST', `/me/credit-applications/${applicationId}/consent`, signedIn.token, {
      role: 'borrower',
      code: await codeFor(number, signedIn.code),
    });
    patients.push({ mobile: number, has: 'پرونده اعتباری ارسال‌شده (در صف کارشناسی)' });
  }

  // The seeded doctor's secretary at their workplace, given the secretary role by the doctor
  // (doc 04 §2: never more than the doctor has).
  const secretary = await account(env, 'center', 'stg_secretary');
  await proveMobile(options.ownerUrl, secretary.accountId);
  const madeSecretary = await call('POST', '/catalog/secretaries', doctor, {
    workplaceId: fixture.workplaceId,
    accountId: secretary.accountId,
    name: `منشی ${personName()}`,
    ...reason,
  });
  await call('POST', `/access/org-nodes/${String(madeSecretary['nodeId'])}/assignments`, doctor, {
    roleCode: 'secretary',
    ...reason,
  });

  // The worker builds the search entries from the outbox; wait until the new ones are in.
  for (let i = 0; i < 120; i++) {
    const found = await fetch(`${STACK.apiUrl}/api/v1/search/doctors?fieldCode=ophthalmology`);
    if (found.ok && ((await found.json()) as { total: number }).total > 0) break;
    await new Promise((r) => setTimeout(r, 1000));
  }

  const plain = (s: Staff): SeededStaff => ({
    username: s.username,
    accountId: s.accountId,
    totpSecret: s.totpSecret,
    lastStep: s.lastStep,
  });
  return {
    staff: [
      { role: 'network_specialist', scope: 'شهر اصفهان', who: plain(specialist) },
      { role: 'network_manager', scope: 'سراسری', who: plain(approver) },
      { role: '(بی نقش)', scope: '—', who: plain(noRole) },
      { role: 'auditor (فقط‌خواندنی)', scope: 'سراسری', who: plain(auditor) },
      {
        role: 'credit_committee + strategy_manager (واحد استراتژی)',
        scope: 'سراسری',
        who: plain(committeeStrategy),
      },
      {
        role: 'credit_committee + collection (واحد وصول)',
        scope: 'سراسری',
        who: plain(committeeCollection),
      },
      {
        role: 'secretary (واگذاری پزشک)',
        scope: `منشی ${fixture.doctorName}`,
        who: plain(secretary),
      },
      ...managers.map((m, i) => ({
        role: 'center_manager',
        scope: CENTERS[i]?.name ?? '',
        who: plain(m),
      })),
    ],
    patients,
  };
}

/** The tester's sheet: every account of this throwaway stack, by role. */
export function writeAccounts(fixture: Fixture, data: StagingData, loginCode: string) {
  const seeded: [string, string, SeededStaff][] = [
    ['system_admin', 'سراسری', fixture.admin],
    ['network_specialist', 'شهر اصفهان', fixture.specialist],
    ['network_manager', 'سراسری', fixture.networkManager],
    ['network_manager', 'سراسری', fixture.approver],
    ['center_manager', fixture.centerName, fixture.manager],
    ['doctor (حساب مرکز پیوندشده به پزشک)', fixture.doctorName, fixture.doctor],
    ['case_completion', 'سراسری', fixture.completion],
    ['case_completion + accounting', 'سراسری', fixture.completionFinance],
    ['credit_specialist', 'سراسری', fixture.creditSpecialist],
    ['credit_manager', 'سراسری', fixture.creditManager],
    ['accounting', 'سراسری', fixture.finance],
    ['strategy_manager', 'سراسری', fixture.strategyA],
    ['strategy_manager', 'سراسری', fixture.strategyB],
    ['collection', 'سراسری', fixture.collectionAgent],
    ['collection_manager', 'سراسری', fixture.collectionManager],
    ['support', 'سراسری', fixture.support],
    ['ceo', 'سراسری', fixture.ceo],
    // The advisor's own scope and the two-person mobile approval (owner 1405/07/24, م۹ and م۷).
    ['advisor', 'فقط پرونده‌های خودش (own)', fixture.advisor],
    ...fixture.mobileApprovers.map((who): [string, string, SeededStaff] => [
      'mobile_approver (lead.approve_person_mobile)',
      'سراسری',
      who,
    ]),
    ...fixture.mobileChangers.map((who): [string, string, SeededStaff] => [
      'patient_mobile_changer (identity.change_patient_mobile)',
      'سراسری',
      who,
    ]),
  ];
  const staff = [...seeded.map(([role, scope, who]) => ({ role, scope, who })), ...data.staff];
  const patients = [
    { mobile: fixture.repaymentPatientMobile, has: 'وام تأمین‌شده با اقساط (مسیر فیش)' },
    { mobile: fixture.collectionPatientMobile, has: 'وام تأمین‌شده با ضامن (مسیر وصول)' },
    { mobile: fixture.collectionGuarantorMobile, has: 'ضامن وام بالا' },
    { mobile: fixture.settlementPatientMobile, has: 'کیف اعتبار تأمین‌شده' },
    { mobile: fixture.complaintPatientMobile, has: 'کیف اعتبار تأمین‌شده' },
    ...data.patients,
  ];
  const lines = [
    '# حساب‌های آزمون staging (تسک ۹-۴)',
    '',
    '> داده ساختگی این stack دورریختنی. با Ctrl+C همه‌چیز پاک می‌شود. **هرگز در مخزن نیاید.**',
    '',
    `- **وب بیمار:** ${STACK.webUrl}`,
    `- **پنل داخلی:** ${STACK.adminUrl}`,
    `- **API:** ${STACK.apiUrl}/api/v1 (سند OpenAPI: \`packages/api-client/openapi.json\` در مخزن)`,
    `- **رمز همه کارکنان:** \`${STAFF_PASSWORD}\``,
    '- **عامل دوم:** راز TOTP زیر را در یک برنامه authenticator وارد کنید (۳۰ ثانیه، ۶ رقم، SHA-1).',
    `- **کد ورود همه بیماران (ثابت، فقط این staging):** \`${loginCode}\`. هیچ پیامک واقعی فرستاده نمی‌شود.`,
    '',
    '## کارکنان و مراکز',
    '',
    '| نقش | دامنه | نام کاربری | راز TOTP |',
    '|---|---|---|---|',
    ...staff.map(
      (s) => `| ${s.role} | ${s.scope} | \`${s.who.username}\` | \`${s.who.totpSecret}\` |`,
    ),
    '',
    '## بیماران',
    '',
    '| موبایل | چه دارد |',
    '|---|---|',
    ...patients.map((p) => `| \`0${p.mobile}\` | ${p.has} |`),
    '',
  ];
  writeFileSync(resolve(STACK_DIR, 'staging-accounts.md'), lines.join('\n'));
}

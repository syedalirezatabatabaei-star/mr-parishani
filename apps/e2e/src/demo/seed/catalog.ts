/**
 * The demo's network: the treatment fields, their wage and material services, the credit
 * plans, the 1405 holidays, the work queues, and every center and doctor of
 * docs/demo/doctors.xlsx (names, fields and addresses only; every phone, ID and Sheba made up).
 */
import { randomInt } from 'node:crypto';
import { resolve } from 'node:path';
import { nationalId, sheba } from '../../synthetic.ts';
import { ROOT } from '../runtime.ts';
import { createAccounts, grant } from './base.ts';
import {
  person,
  as,
  readXlsx,
  saveState,
  type Body,
  type Person,
  type SeedState,
} from './context.ts';
import { DEMO, demoPlans, setKey } from './settings.ts';

const reason = { reason: DEMO };

export const FIELDS: Record<string, { code: string; name: string }> = {
  'دندان پزشکی': { code: 'dental', name: 'دندان‌پزشکی' },
  زیبایی: { code: 'beauty', name: 'زیبایی' },
  'پوست و مو': { code: 'skin_hair', name: 'پوست و مو' },
  لاغری: { code: 'slimming', name: 'لاغری' },
  چشم: { code: 'eye', name: 'چشم‌پزشکی' },
  سمعک: { code: 'hearing', name: 'سمعک و شنوایی' },
  ناباروری: { code: 'infertility', name: 'ناباروری' },
};

/** Each field's services: wage and material, with a tariff range in rials. */
export const SERVICES: Record<
  string,
  { code: string; name: string; kind: 'wage' | 'material'; min: number; max: number }[]
> = {
  dental: [
    { code: 'dental_scaling', name: 'جرم‌گیری و بروساژ', kind: 'wage', min: 15e6, max: 30e6 },
    {
      code: 'dental_root_canal',
      name: 'درمان ریشه (عصب‌کشی)',
      kind: 'wage',
      min: 60e6,
      max: 120e6,
    },
    {
      code: 'dental_crown_wage',
      name: 'روکش زیرکونیا (دستمزد)',
      kind: 'wage',
      min: 40e6,
      max: 80e6,
    },
    {
      code: 'dental_crown_material',
      name: 'روکش زیرکونیا (مواد و لابراتوار)',
      kind: 'material',
      min: 80e6,
      max: 150e6,
    },
    {
      code: 'dental_implant_wage',
      name: 'کاشت ایمپلنت (دستمزد)',
      kind: 'wage',
      min: 150e6,
      max: 250e6,
    },
    {
      code: 'dental_implant_material',
      name: 'فیکسچر و اباتمنت ایمپلنت (مواد)',
      kind: 'material',
      min: 200e6,
      max: 400e6,
    },
    {
      code: 'dental_laminate_wage',
      name: 'لمینت سرامیکی (دستمزد)',
      kind: 'wage',
      min: 60e6,
      max: 100e6,
    },
    {
      code: 'dental_laminate_material',
      name: 'لمینت سرامیکی (مواد)',
      kind: 'material',
      min: 80e6,
      max: 140e6,
    },
    { code: 'dental_ortho', name: 'ارتودنسی ثابت', kind: 'wage', min: 300e6, max: 600e6 },
  ],
  beauty: [
    {
      code: 'beauty_botox_wage',
      name: 'تزریق بوتاکس (دستمزد)',
      kind: 'wage',
      min: 30e6,
      max: 60e6,
    },
    {
      code: 'beauty_botox_material',
      name: 'بوتاکس (دارو)',
      kind: 'material',
      min: 40e6,
      max: 80e6,
    },
    { code: 'beauty_filler_wage', name: 'تزریق ژل (دستمزد)', kind: 'wage', min: 30e6, max: 50e6 },
    { code: 'beauty_filler_material', name: 'ژل (مواد)', kind: 'material', min: 60e6, max: 120e6 },
    { code: 'beauty_rhinoplasty', name: 'جراحی بینی', kind: 'wage', min: 800e6, max: 1400e6 },
    { code: 'beauty_blepharoplasty', name: 'جراحی پلک', kind: 'wage', min: 300e6, max: 600e6 },
  ],
  skin_hair: [
    { code: 'hair_transplant', name: 'کاشت مو', kind: 'wage', min: 400e6, max: 900e6 },
    { code: 'skin_laser', name: 'لیزر موهای زائد (دوره)', kind: 'wage', min: 20e6, max: 60e6 },
    { code: 'skin_prp_wage', name: 'پی‌آر‌پی (دستمزد)', kind: 'wage', min: 15e6, max: 30e6 },
    {
      code: 'skin_prp_material',
      name: 'کیت پی‌آر‌پی (مواد)',
      kind: 'material',
      min: 10e6,
      max: 20e6,
    },
    { code: 'skin_meso_wage', name: 'مزوتراپی (دستمزد)', kind: 'wage', min: 20e6, max: 40e6 },
    {
      code: 'skin_meso_material',
      name: 'کوکتل مزوتراپی (مواد)',
      kind: 'material',
      min: 15e6,
      max: 30e6,
    },
  ],
  slimming: [
    { code: 'slim_lipomatic', name: 'لیپوماتیک', kind: 'wage', min: 150e6, max: 300e6 },
    { code: 'slim_cavitation', name: 'کویتیشن (دوره)', kind: 'wage', min: 20e6, max: 50e6 },
    { code: 'slim_liposuction', name: 'لیپوساکشن', kind: 'wage', min: 600e6, max: 1200e6 },
  ],
  eye: [
    { code: 'eye_lasik', name: 'لیزیک دو چشم', kind: 'wage', min: 300e6, max: 500e6 },
    {
      code: 'eye_cataract_wage',
      name: 'جراحی آب مروارید (دستمزد)',
      kind: 'wage',
      min: 200e6,
      max: 350e6,
    },
    {
      code: 'eye_iol_material',
      name: 'لنز داخل چشمی (مواد)',
      kind: 'material',
      min: 150e6,
      max: 400e6,
    },
  ],
  hearing: [
    {
      code: 'hearing_aid_device',
      name: 'سمعک دیجیتال (دستگاه)',
      kind: 'material',
      min: 300e6,
      max: 900e6,
    },
    { code: 'hearing_fitting', name: 'تنظیم و آموزش سمعک', kind: 'wage', min: 10e6, max: 30e6 },
  ],
  infertility: [
    { code: 'ivf_wage', name: 'آی‌وی‌اف (دستمزد)', kind: 'wage', min: 400e6, max: 700e6 },
    {
      code: 'ivf_drugs',
      name: 'داروهای آی‌وی‌اف (مواد)',
      kind: 'material',
      min: 200e6,
      max: 400e6,
    },
    { code: 'iui_wage', name: 'آی‌یو‌آی', kind: 'wage', min: 60e6, max: 120e6 },
  ],
};

const DOCTOR_FIRST_M = [
  'علی',
  'محمد',
  'حسین',
  'رضا',
  'امیر',
  'مهدی',
  'پیمان',
  'سینا',
  'آرش',
  'بهزاد',
];
const DOCTOR_FIRST_F = ['مریم', 'نرگس', 'سمیرا', 'الناز', 'پریسا', 'مهسا', 'شیدا', 'ترانه'];
const DOCTOR_LAST = [
  'نیک‌پور',
  'دانشور',
  'مهرآیین',
  'روشن‌دل',
  'آذرپاد',
  'بهاروند',
  'کیان‌مهر',
  'ستوده',
  'پارسا',
  'نوبهار',
  'آریان‌فر',
];

/** A valid made-up legal-entity national ID (شناسه ملی، the 0 checksum of legal-id.ts). */
function legalId(): string {
  for (;;) {
    const body = Array.from({ length: 10 }, () => String(randomInt(10))).join('');
    if (body.slice(3, 9) === '000000') continue;
    const d = Array.from(body, Number);
    const e = (d[9] ?? 0) + 2;
    const w = [29, 27, 23, 19, 17, 29, 27, 23, 19, 17];
    const sum = d.reduce((s, x, i) => s + (x + e) * (w[i] ?? 0), 0);
    return body + String(sum % 11 === 10 ? 0 : sum % 11);
  }
}

export interface DemoWorkplace {
  centerId: string;
  centerNodeId: string;
  centerName: string;
  doctorId: string;
  doctorName: string;
  workplaceId: string;
  fieldCodes: string[];
  managerKey: string;
  doctorKey: string;
  city: string;
}

interface Row {
  title: string;
  isClinic: boolean;
  doctorName: string;
  fields: string[];
  cityLabel: string;
  street: string;
  handler: string;
}

/** The workbook's rows, one per place (one doctor with two rows takes both fields). */
export function workbookRows(): { rows: Row[]; skipped: string[] } {
  const raw = readXlsx(resolve(ROOT, 'docs/demo/doctors.xlsx')).slice(1);
  const skipped: string[] = [];
  const byTitle = new Map<string, Row>();
  for (const r of raw) {
    const title = (r[0] ?? '').trim();
    const field = FIELDS[(r[3] ?? '').trim()];
    if (!title) continue;
    if (!field) {
      skipped.push(`${title} (بی رشته درمان)`);
      continue;
    }
    const existing = byTitle.get(title);
    if (existing) {
      if (!existing.fields.includes(field.code)) existing.fields.push(field.code);
      continue;
    }
    const doctor = /دکتر\s+(.+)$/.exec(title.replace(/^(جناب آقای|سرکار خانم)\s+/, ''));
    const isClinic = !/^(جناب آقای|سرکار خانم)/.test(title);
    byTitle.set(title, {
      title,
      isClinic,
      doctorName: isClinic ? '' : `دکتر ${doctor?.[1]?.trim() ?? title}`,
      fields: [field.code],
      cityLabel: (r[4] ?? '').trim(),
      street: (r[5] ?? '').trim(),
      handler: (r[1] ?? '').trim(),
    });
  }
  return { rows: [...byTitle.values()], skipped };
}

let mobileSerial = 1000;
/** A made-up mobile on the 0900000xxxx pattern, its last four digits unique in the demo. */
export function demoMobile(start?: number): string {
  if (start !== undefined) mobileSerial = Math.max(mobileSerial, start);
  const n = mobileSerial++;
  return `900000${String(n).padStart(4, '0')}`;
}

/** A center account proves its mobile with a code, as its owner would (task 4-6). */
async function proveMobile(who: Person) {
  const { codeFor } = await import('../../seed-funded.ts');
  const mobile = demoMobile();
  await as(who, 'POST', '/auth/mobile/request', { mobile: `0${mobile}` });
  await as(who, 'POST', '/auth/mobile/verify', {
    mobile: `0${mobile}`,
    code: await codeFor(mobile),
  });
}

async function activeCenter(
  state: SeedState,
  row: { name: string; isClinic: boolean; fields: string[]; address: string; legalName: string },
  finish: 'active' | 'submitted' | 'activation_requested',
) {
  const specialist = person(state, 'netspec1');
  const approver = person(state, 'netman1');
  const center = await as(specialist, 'POST', '/catalog/centers', {
    contractTerm: { startsOn: new Date().toISOString().slice(0, 10), months: 12 },
    personType: row.isClinic ? 'legal' : 'natural',
    identifier: row.isClinic ? legalId() : nationalId(),
    name: row.name,
    cityCode: 'isfahan',
    sheba: sheba(),
    accountHolderName: row.legalName,
    treatmentFieldCodes: row.fields,
    address: row.address,
    phone: `031${String(randomInt(30_000_000, 39_999_999))}`,
  });
  const centerId = String(center['id']);
  const documents = async (status: string) => {
    const detail = await as(specialist, 'GET', `/catalog/centers/${centerId}`);
    for (const doc of detail['documents'] as { code: string }[]) {
      await as(specialist, 'PUT', `/catalog/centers/${centerId}/documents/${doc.code}`, { status });
    }
  };
  await documents('received');
  await as(specialist, 'POST', `/catalog/centers/${centerId}/submit`, reason);
  if (finish === 'submitted') return { center, centerId, branchId: '' };
  await documents('verified');
  const activation = await as(
    specialist,
    'POST',
    `/catalog/centers/${centerId}/activation-requests`,
    reason,
  );
  if (finish === 'activation_requested') return { center, centerId, branchId: '' };
  await as(approver, 'POST', `/catalog/requests/${String(activation['id'])}/approve`, {});
  const detail = await as(specialist, 'GET', `/catalog/centers/${centerId}`);
  const branchId = (detail['branches'] as { id: string }[])[0]?.id ?? '';
  return { center, centerId, branchId };
}

const WEEKDAYS = ['saturday', 'sunday', 'monday', 'tuesday', 'wednesday'] as const;

function slug(i: number) {
  return `demo-doctor-${String(i + 1).padStart(2, '0')}`;
}

export async function seedCatalog(state: SeedState) {
  const p = state.people;
  const netman = person(state, 'netman1');
  const specialist = person(state, 'netspec1');
  const admin = person(state, 'admin1');
  const { rows, skipped } = workbookRows();
  state.data['skippedRows'] = skipped;

  // Fields and services.
  const usedFields = [...new Set(rows.flatMap((r) => r.fields))];
  const existingFields = new Set(
    ((await as(netman, 'GET', '/catalog/fields')) as unknown as { code: string }[]).map(
      (f) => f.code,
    ),
  );
  for (const [i, f] of Object.values(FIELDS).entries()) {
    if (!usedFields.includes(f.code) || existingFields.has(f.code)) continue;
    await as(netman, 'POST', '/catalog/fields', {
      code: f.code,
      name: f.name,
      sortOrder: i + 1,
      ...reason,
    });
  }
  for (const code of usedFields) {
    for (const s of SERVICES[code] ?? []) {
      await as(netman, 'POST', '/catalog/services', {
        fieldCode: code,
        code: s.code,
        name: s.name,
        costKind: s.kind,
        ...reason,
      }).catch((e: unknown) => {
        if (!(e instanceof Error) || !/409/.test(e.message)) throw e;
      });
    }
  }
  await setKey(
    person(state, 'strat1'),
    person(state, 'strat2'),
    'credit.plans',
    demoPlans(usedFields),
    `${DEMO}: طرح‌های اعتبار`,
  );

  // The work queues: completion, credit, collection, the tickets and advice, each between two.
  const shares = async (queueCode: string, keys: string[]) =>
    as(person(state, 'strat1'), 'PUT', '/lead/assignment/shares', {
      queueCode,
      shares: keys.map((k, i) => ({
        accountId: person(state, k).accountId,
        percent:
          i === 0
            ? 100 - Math.floor(100 / keys.length) * (keys.length - 1)
            : Math.floor(100 / keys.length),
      })),
      ...reason,
    });
  await shares('completion', ['comp1', 'comp2']);
  await shares('credit', ['credspec1', 'credspec2']);
  await shares('collection', ['coll1', 'coll2']);
  await shares('ticket_support', ['support1', 'support2']);
  // Every unit's ticket queue (owner 1405/08/09), so its tickets are given to someone.
  await shares('ticket_accounting', ['acc1', 'acc2']);
  await shares('ticket_collection', ['coll1', 'coll2']);
  await shares('ticket_network_specialist', ['netspec1', 'netspec2']);
  await shares('ticket_case_completion', ['comp1', 'comp2']);
  await shares('ticket_credit_specialist', ['credspec1', 'credspec2']);
  await shares('ticket_advisor', ['advisor1', 'advisor2']);
  await shares('advisory', ['advisor1', 'advisor2']);

  // The places of the workbook, every one active, with its doctor, prices and hours.
  // Resumable: each place is kept as soon as it is made.
  const places = ((state.data['places'] as DemoWorkplace[] | undefined) ??= []);
  const centerPlans: { key: string; username: string; name: string; kind: 'center' }[] = [];
  rows.forEach((row, i) => {
    centerPlans.push({
      key: `center${String(i + 1)}`,
      username: `center.${String(i + 1).padStart(2, '0')}`,
      name: `مدیر ${row.isClinic ? row.title : `مطب ${row.doctorName}`}`,
      kind: 'center',
    });
    centerPlans.push({
      key: `doctor${String(i + 1)}`,
      username: `doctor.${String(i + 1).padStart(2, '0')}`,
      name: row.isClinic ? '' : row.doctorName,
      kind: 'center',
    });
  });
  // A clinic's doctor is made up (the workbook names the clinic only).
  rows.forEach((row, i) => {
    if (!row.isClinic) return;
    const female = i % 3 === 0;
    const first = female
      ? DOCTOR_FIRST_F[i % DOCTOR_FIRST_F.length]
      : DOCTOR_FIRST_M[i % DOCTOR_FIRST_M.length];
    row.doctorName = `دکتر ${first ?? ''} ${DOCTOR_LAST[i % DOCTOR_LAST.length] ?? ''}`;
    const plan = centerPlans.find((c) => c.key === `doctor${String(i + 1)}`);
    if (plan) plan.name = row.doctorName;
  });
  await createAccounts(
    centerPlans.filter((c) => !p[c.key]),
    {
      admin,
      onMade: (who) => {
        p[who.key] = who;
        saveState(state);
      },
    },
  );
  for (const c of centerPlans) {
    const who = person(state, c.key);
    if (state.data[`mobile:${c.key}`]) continue;
    await proveMobile(who);
    state.data[`mobile:${c.key}`] = true;
    saveState(state);
  }
  for (const [i, row] of rows.entries()) {
    if (i < places.length) continue;
    const n = String(i + 1);
    const manager = person(state, `center${n}`);
    const doctorAccount = person(state, `doctor${n}`);
    const name = row.isClinic ? row.title : `مطب ${row.doctorName}`;
    const address = `${row.cityLabel === 'کاشان' ? 'کاشان، ' : 'اصفهان، '}${row.street}`;
    const made = await activeCenter(
      state,
      {
        name,
        isClinic: row.isClinic,
        fields: row.fields,
        address,
        legalName: row.isClinic ? `شرکت ${row.title}` : row.doctorName,
      },
      'active',
    );
    const nodeId = String(made.center['nodeId']);
    await grant(admin, manager, 'center_manager', { kind: 'center', nodeId });
    const doctor = await as(specialist, 'POST', '/catalog/doctors', {
      contractTerm: { startsOn: new Date().toISOString().slice(0, 10), months: 12 },
      name: row.doctorName,
      medicalCouncilNumber: String(randomInt(10_000, 999_999)),
      nationalId: nationalId(),
      treatmentFieldCodes: row.fields,
      workplace: { kind: 'branch', branchId: made.branchId },
      ...reason,
    });
    const doctorId = String(doctor['id']);
    const detail = await as(specialist, 'GET', `/catalog/doctors/${doctorId}`);
    const workplaceId = (detail['workplaces'] as { id: string }[])[0]?.id ?? '';
    await as(specialist, 'POST', `/catalog/doctors/${doctorId}/account`, {
      accountId: doctorAccount.accountId,
      ...reason,
    });
    // Prices: the visit, and every service of the place's fields.
    await as(manager, 'POST', '/catalog/tariffs', {
      owner: { kind: 'workplace', workplaceId },
      serviceCode: 'visit',
      pricing: { kind: 'range', minRial: '3000000', maxRial: '6000000' },
      ...reason,
    });
    for (const code of row.fields) {
      for (const s of SERVICES[code] ?? []) {
        await as(manager, 'POST', '/catalog/tariffs', {
          owner: { kind: 'workplace', workplaceId },
          serviceCode: s.code,
          pricing: { kind: 'range', minRial: String(s.min), maxRial: String(s.max) },
          ...reason,
        });
      }
    }
    await as(manager, 'PUT', `/booking/workplaces/${workplaceId}/schedule`, {
      ranges: WEEKDAYS.flatMap((weekday) => [
        { weekday, start: '09:00', end: '13:00', slotMinutes: 30, serviceCodes: ['visit'] },
        { weekday, start: '16:00', end: '20:00', slotMinutes: 30, serviceCodes: ['visit'] },
      ]),
      ...reason,
    });
    // The public profile, drafted by the center and approved by the network (all but two,
    // left waiting for review: scenario 1 in progress).
    await as(specialist, 'POST', `/catalog/doctors/${doctorId}/profile`, {
      slug: slug(i),
      ...reason,
    });
    await as(manager, 'PUT', `/catalog/doctors/${doctorId}/profile/draft`, {
      specialtyTitle: `متخصص ${row.fields.map((f) => Object.values(FIELDS).find((x) => x.code === f)?.name ?? f).join(' و ')}`,
      biography: `${DEMO}: معرفی ساختگی پزشک برای نمایش سامانه.`,
      history: ['دکترای حرفه‌ای، دانشگاه علوم پزشکی اصفهان'],
      ...reason,
    });
    const submitted = await as(
      manager,
      'POST',
      `/catalog/doctors/${doctorId}/profile/submit`,
      reason,
    );
    if (i < rows.length - 2) {
      await as(
        specialist,
        'POST',
        `/catalog/profile-versions/${String(submitted['id'])}/approve`,
        reason,
      );
    }
    places.push({
      centerId: made.centerId,
      centerNodeId: nodeId,
      centerName: name,
      doctorId,
      doctorName: row.doctorName,
      workplaceId,
      fieldCodes: row.fields,
      managerKey: `center${n}`,
      doctorKey: `doctor${n}`,
      city: row.cityLabel || 'اصفهان',
    });
    saveState(state);
  }

  // Scenario 1 in progress: one center waiting for its documents to be checked, one for the
  // second signature of its activation.
  if (state.data['pendingCenters']) return;
  await activeCenter(
    state,
    {
      name: `مرکز نمونه در انتظار بررسی مدارک (${DEMO})`,
      isClinic: true,
      fields: ['dental'],
      address: 'اصفهان، خیابان نمونه ۱',
      legalName: 'شرکت نمونه یک',
    },
    'submitted',
  );
  await activeCenter(
    state,
    {
      name: `مرکز نمونه در انتظار تأیید فعال‌سازی (${DEMO})`,
      isClinic: true,
      fields: ['beauty'],
      address: 'اصفهان، خیابان نمونه ۲',
      legalName: 'شرکت نمونه دو',
    },
    'activation_requested',
  );

  state.data['pendingCenters'] = true;
  saveState(state);

  // The 1405 holidays: the CEO proposes the year's official days, the deputy approves.
  const suggestions = await as(
    person(state, 'ceo'),
    'GET',
    '/calendar/holidays/suggestions?year=1405',
  );
  const days = (suggestions['days'] as { jalali: Body; title: string; existing?: boolean }[])
    .filter((d) => !d.existing)
    .map((d) => ({ on: d.jalali, title: d.title }));
  if (days.length > 0) {
    const batch = await as(person(state, 'ceo'), 'POST', '/calendar/holidays/batches', {
      year: 1405,
      days: days.slice(0, 60),
      reason: `${DEMO}: تعطیلات رسمی و قمری ۱۴۰۵`,
    });
    await as(
      person(state, 'deputy'),
      'POST',
      `/calendar/holidays/batches/${String(batch['id'])}/approve`,
    );
  }
}

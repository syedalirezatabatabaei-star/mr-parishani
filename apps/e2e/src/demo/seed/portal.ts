/**
 * The portal's sample content (owner 1405/08/11): three Persian banners, the six text pages and
 * one announcement, each proposed by a system admin and approved by support, through the API
 * only (migration 0110). The pages are samples: the final legal text is the lawyer's.
 */
import { setClock } from '../runtime.ts';
import { as, person, saveState, type SeedState } from './context.ts';

type Block =
  | { kind: 'heading' | 'paragraph'; text: string }
  | { kind: 'list'; items: string[] }
  | { kind: 'link'; text: string; href: string };

const LAWYER = 'این متن نمونه است؛ متن حقوقی نهایی را حقوقدان سپهر سلامتی می‌دهد.';

const PAGES: Record<string, { title: string; blocks: Block[] }> = {
  about: {
    title: 'درباره سپهر سلامتی',
    blocks: [
      {
        kind: 'paragraph',
        text: 'سپهر سلامتی بیمار را به پزشکان و مراکز درمانی همکار می‌رساند: پزشک را پیدا کنید، نوبت بگیرید، پیش‌فاکتور بگیرید و هزینه درمان را با اعتبار درمان و اقساط بپردازید.',
      },
      { kind: 'heading', text: 'وام‌دهنده' },
      {
        kind: 'paragraph',
        text: 'اعتبار درمان را شرکت آرامش ثروت می‌دهد و طرف همه قراردادهای اعتبار همین شرکت است.',
      },
      { kind: 'heading', text: 'چه می‌کنیم' },
      {
        kind: 'list',
        items: [
          'جست‌وجوی پزشک و مرکز و نوبت آنلاین',
          'پیش‌فاکتور شفاف پیش از درمان',
          'اعتبار درمان با بررسی کارشناسی و اقساط روشن',
          'تسویه منظم با پزشکان و مراکز همکار',
        ],
      },
      { kind: 'link', text: 'درخواست همکاری مراکز درمانی', href: '/join' },
    ],
  },
  terms: {
    title: 'قوانین و شرایط',
    blocks: [
      { kind: 'paragraph', text: LAWYER },
      { kind: 'heading', text: 'استفاده از سامانه' },
      {
        kind: 'list',
        items: [
          'حساب هر بیمار با شماره موبایل خود او ساخته می‌شود.',
          'اطلاعات پرونده اعتباری باید درست و کامل باشد.',
          'شرایط هر اعتبار در قرارداد همان پرونده آمده و پس از امضا تغییر نمی‌کند.',
        ],
      },
      { kind: 'heading', text: 'نوبت و لغو' },
      {
        kind: 'paragraph',
        text: 'لغو نوبت تا مهلتی که در صفحه نوبت آمده ممکن است؛ پس از آن قواعد مرکز درمانی اجرا می‌شود.',
      },
    ],
  },
  privacy: {
    title: 'حریم خصوصی',
    blocks: [
      { kind: 'paragraph', text: LAWYER },
      { kind: 'heading', text: 'چه نگه می‌داریم' },
      {
        kind: 'list',
        items: [
          'شماره موبایل برای ورود و پیامک‌های لازم.',
          'کد ملی و مدارک فقط برای پرونده اعتباری، رمزگذاری‌شده.',
          'هیچ داده‌ای به سرویس خارج از ایران فرستاده نمی‌شود.',
        ],
      },
      { kind: 'heading', text: 'پیامک تبلیغاتی' },
      {
        kind: 'paragraph',
        text: 'پیامک تبلیغاتی فقط با رضایت شما فرستاده می‌شود و هر زمان می‌توانید آن را لغو کنید.',
      },
    ],
  },
  contact: {
    title: 'تماس با ما',
    blocks: [
      {
        kind: 'paragraph',
        text: 'پرسش، درخواست یا شکایت خود را از «پشتیبانی» در حساب کاربری ثبت کنید تا پیگیری آن ثبت بماند.',
      },
      { kind: 'link', text: 'پشتیبانی (برای کاربران واردشده)', href: '/me/tickets' },
      { kind: 'heading', text: 'تلفن' },
      { kind: 'link', text: 'تلفن پشتیبانی (نمونه)', href: 'tel:02100000000' },
    ],
  },
  help: {
    title: 'راهنما',
    blocks: [
      { kind: 'heading', text: 'گرفتن نوبت' },
      {
        kind: 'list',
        items: [
          'از «پیدا کردن پزشک» پزشک یا مرکز را بیابید.',
          'روز و ساعت آزاد را انتخاب کنید و با کد پیامکی وارد شوید.',
          'نوبت پس از تأیید مرکز در «نوبت‌های من» دیده می‌شود.',
        ],
      },
      { kind: 'heading', text: 'اعتبار درمان' },
      {
        kind: 'list',
        items: [
          'پیش‌فاکتور پزشک را در «پیش‌فاکتورها» تأیید کنید.',
          'در «اعتبار من» طرح را انتخاب کنید و مدارک را بفرستید.',
          'پس از تأیید و تکمیل پرونده، کیف اعتبار شما شارژ می‌شود.',
        ],
      },
    ],
  },
  faq: {
    title: 'پرسش‌های متداول',
    blocks: [
      { kind: 'heading', text: 'برای ثبت‌نام رمز لازم است؟' },
      {
        kind: 'paragraph',
        text: 'خیر؛ با شماره موبایل و کد پیامکی وارد می‌شوید و اگر حساب ندارید همان‌جا ساخته می‌شود.',
      },
      { kind: 'heading', text: 'اقساط چگونه پرداخت می‌شود؟' },
      {
        kind: 'paragraph',
        text: 'سررسید و مبلغ هر قسط در «اقساط من» آمده است؛ فیش پرداخت را همان‌جا ثبت کنید.',
      },
      { kind: 'heading', text: 'مرکز درمانی هستم؛ چگونه همکار شوم؟' },
      { kind: 'link', text: 'فرم درخواست همکاری', href: '/join' },
    ],
  },
};

const BANNERS = [
  {
    title: 'درمان امروز، پرداخت با اقساط',
    body: 'پیش‌فاکتور پزشک را تأیید کنید و برای آن اعتبار درمان بگیرید.',
    tone: 'accent',
    linkHref: '/me/credit',
    linkLabel: 'اعتبار من',
    sortOrder: 0,
    audiences: ['patient'],
    displaySeconds: 7,
  },
  {
    title: 'باشگاه مشتریان سپهر',
    body: 'اعضای باشگاه از طرح‌های ویژه اعتبار درمان بهره می‌برند؛ پاسخ پرسش‌ها را ببینید.',
    tone: 'highlight',
    linkHref: '/pages/faq',
    linkLabel: 'پرسش‌های متداول',
    sortOrder: 1,
    audiences: ['patient', 'center', 'doctor'],
    displaySeconds: 6,
  },
  {
    title: 'پیشخوان تازه سپهر',
    body: 'همه بخش‌هایی که به آن‌ها دسترسی دارید اینجاست؛ از ☰ یا «همه خدمات» گروه‌به‌گروه ببینید.',
    tone: 'indigo',
    linkHref: null,
    linkLabel: null,
    sortOrder: 2,
    audiences: ['staff', 'center', 'doctor'],
    displaySeconds: 6,
  },
];

export async function seedPortal(state: SeedState) {
  // On the real clock, as the extras: the content starts now.
  await setClock('real');
  const proposer = person(state, 'admin1');
  const approver = person(state, 'support1');
  const now = new Date().toISOString();
  const approve = async (path: string) => {
    await as(approver, 'POST', path, { approve: true });
  };
  for (const banner of BANNERS) {
    const v = (await as(proposer, 'POST', '/config/content/banners', {
      proposal: JSON.stringify({
        ...banner,
        startsAt: now,
        endsAt: null,
        active: true,
        reason: 'بنر نمونه دمو',
      }),
    })) as { id: string };
    await approve(`/config/content/banners/${v.id}/decision`);
  }
  for (const [slug, page] of Object.entries(PAGES)) {
    const v = (await as(proposer, 'POST', `/config/content/pages/${slug}`, {
      ...page,
      reason: 'متن نمونه دمو',
    })) as { id: string };
    await approve(`/config/content/pages/versions/${v.id}/decision`);
  }
  const a = (await as(proposer, 'POST', '/config/content/announcements', {
    title: 'به‌روزرسانی پیشخوان',
    body: 'پیشخوان تازه با منوی ☰، اعلان‌ها و بنرهای قابل تنظیم راه‌اندازی شد.',
    audience: 'all',
    roleCode: null,
    urgent: false,
    startsAt: now,
    endsAt: null,
    active: true,
    reason: 'اطلاعیه نمونه دمو',
  })) as { id: string };
  await approve(`/config/content/announcements/${a.id}/decision`);
  saveState(state);
}

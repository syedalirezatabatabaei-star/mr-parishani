import { COLORS, contrastRatio, type ColorSet, type Tone } from '@sepehr/ui';
import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import type { ReactNode } from 'react';
import { CalendarDemo } from './calendar-demo';

/**
 * The style guide (task 2-10): the visual direction for the owner to approve before any
 * component is built (doc 09, 2-10 acceptance). Development only; never indexed.
 */
export const metadata: Metadata = {
  title: 'سیستم طراحی سپهر — صفحه نمونه',
  robots: { index: false, follow: false },
};

const fa = new Intl.NumberFormat('fa-IR');
/** Rials are stored; tomans only in the UI (rules 1 and 2). */
const toman = (rial: bigint) => `${fa.format(rial / 10n)} تومان`;

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="space-y-3">
      <h3 className="text-[length:var(--text-md)] font-bold text-ink">{title}</h3>
      {children}
    </section>
  );
}

function Swatch({ name, color, on }: { name: string; color: string; on: string }) {
  const ratio = contrastRatio(color, on);
  return (
    <div className="overflow-hidden rounded-md border border-border bg-surface">
      <div className="h-12" style={{ background: color }} />
      <div className="space-y-0.5 p-2 text-[length:var(--text-xs)]">
        <div className="font-medium text-ink">{name}</div>
        <div className="figures text-ink-subtle" dir="ltr">
          {color} · {ratio.toFixed(1)}:1
        </div>
      </div>
    </div>
  );
}

const button =
  'inline-flex min-h-10 items-center justify-center gap-2 rounded-md px-4 text-[length:var(--text-sm)] font-medium transition-colors duration-[var(--duration-base)] ease-[var(--ease)] disabled:cursor-not-allowed disabled:opacity-50';

function Buttons() {
  return (
    <div className="flex flex-wrap gap-2">
      <button className={`${button} bg-accent text-on-accent hover:bg-accent-hover`}>
        ثبت نوبت
      </button>
      <button className={`${button} bg-accent-soft text-on-accent-soft hover:bg-accent-soft/70`}>
        پیش‌نمایش
      </button>
      <button
        className={`${button} border border-border-strong bg-surface text-ink hover:bg-sunken`}
      >
        انصراف
      </button>
      <button className={`${button} text-accent hover:bg-accent-soft`}>بیشتر</button>
      <button className={`${button} bg-danger text-on-accent`}>لغو نوبت</button>
      <button className={`${button} bg-accent text-on-accent`} disabled>
        غیرفعال
      </button>
    </div>
  );
}

function Field() {
  return (
    <div className="grid gap-4 sm:grid-cols-2">
      <label className="block space-y-1">
        <span className="text-[length:var(--text-sm)] font-medium text-ink">شماره موبایل</span>
        <input
          className="figures block min-h-10 w-full rounded-md border border-border-strong bg-surface px-3 text-ink placeholder:text-ink-subtle"
          placeholder="۰۹۱۲۱۲۳۴۵۶۷"
          inputMode="numeric"
        />
        <span className="block text-[length:var(--text-xs)] text-ink-subtle">
          ارقام فارسی، عربی یا انگلیسی
        </span>
      </label>
      <label className="block space-y-1">
        <span className="text-[length:var(--text-sm)] font-medium text-ink">کد ملی</span>
        <input
          className="figures block min-h-10 w-full rounded-md border-2 border-danger bg-surface px-3 text-ink"
          defaultValue="۱۲۳۴۵۶۷۸۹۰"
          aria-invalid="true"
          aria-describedby="national-id-error"
        />
        <span id="national-id-error" className="block text-[length:var(--text-xs)] text-danger">
          کد ملی معتبر نیست.
        </span>
      </label>
      <label className="flex items-center gap-2 text-[length:var(--text-sm)] text-ink">
        <input type="checkbox" defaultChecked className="size-5 accent-[var(--color-accent)]" />
        پذیرش اعتبار سپهر
      </label>
      <label className="block space-y-1">
        <span className="text-[length:var(--text-sm)] font-medium text-ink">تاریخ (شمسی)</span>
        <input
          className="figures block min-h-10 w-full rounded-md border border-border-strong bg-surface px-3 text-ink"
          defaultValue="۱۴۰۵/۰۷/۰۸"
          dir="ltr"
        />
      </label>
    </div>
  );
}

function Badges() {
  const badge =
    'inline-flex items-center rounded-full px-2.5 py-0.5 text-[length:var(--text-xs)] font-medium';
  return (
    <div className="flex flex-wrap gap-2">
      <span className={`${badge} bg-success-soft text-success`}>تأییدشده</span>
      <span className={`${badge} bg-warning-soft text-warning`}>در انتظار تأیید</span>
      <span className={`${badge} bg-danger-soft text-danger`}>لغوشده</span>
      <span className={`${badge} bg-info-soft text-info`}>یادآوری ارسال شد</span>
      <span className={`${badge} bg-holiday-soft text-holiday`}>تعطیل رسمی</span>
      <span className={`${badge} bg-highlight-soft text-on-highlight-soft`}>اعتبار سپهر</span>
    </div>
  );
}

function Callout() {
  return (
    <div className="flex gap-3 rounded-md border-s-4 border-warning bg-warning-soft p-3 text-[length:var(--text-sm)]">
      <span aria-hidden="true" className="font-bold text-warning">
        !
      </span>
      <p className="text-ink">
        ۳ نوبت هنوز منتظر تأیید دستی است. با رفتن به تأیید خودکار، این‌ها خودبه‌خود تأیید نمی‌شوند.
      </p>
    </div>
  );
}

function DoctorCard() {
  return (
    <article className="max-w-md space-y-4 rounded-lg bg-surface p-5 shadow-md transition-shadow duration-[var(--duration-slow)] ease-[var(--ease-out)] hover:shadow-lg">
      <div className="flex items-start gap-4">
        <div
          aria-hidden="true"
          className="grid size-16 shrink-0 place-items-center rounded-lg bg-accent-soft text-[length:var(--text-xl)] font-bold text-on-accent-soft"
          style={{ fontFamily: 'var(--font-heading)' }}
        >
          ن
        </div>
        <div className="space-y-1">
          <h4
            className="text-[length:var(--text-lg)] font-bold text-ink"
            style={{ fontFamily: 'var(--font-heading)' }}
          >
            دکتر نگار زرین‌مکان
          </h4>
          <p className="text-[length:var(--text-sm)] text-ink-muted">
            متخصص ارتودنسی · کلینیک مهر، سعادت‌آباد
          </p>
          <span className="inline-flex rounded-full bg-highlight-soft px-2.5 py-0.5 text-[length:var(--text-xs)] font-medium text-on-highlight-soft">
            اعتبار سپهر
          </span>
        </div>
      </div>
      <div className="flex items-center justify-between rounded-md bg-sunken px-3 py-2 text-[length:var(--text-sm)]">
        <span className="text-ink-muted">ویزیت</span>
        <span className="figures font-medium text-ink">
          {toman(5_000_000n)} تا {toman(8_000_000n)}
        </span>
      </div>
      <div className="space-y-2">
        <p className="text-[length:var(--text-sm)] text-ink-muted">نزدیک‌ترین زمان‌های خالی</p>
        <div className="flex flex-wrap gap-2">
          {['شنبه ۱۲ مهر، ۹:۰۰', 'شنبه ۱۲ مهر، ۹:۳۰', 'یکشنبه ۱۳ مهر، ۱۰:۰۰'].map((t) => (
            <button
              key={t}
              className="figures min-h-10 rounded-md border border-accent px-3 text-[length:var(--text-sm)] text-accent transition-colors duration-[var(--duration-fast)] hover:bg-accent hover:text-on-accent"
            >
              {t}
            </button>
          ))}
        </div>
      </div>
    </article>
  );
}

function Kpis() {
  const items: [string, string, string][] = [
    ['نوبت‌های امروز', fa.format(42), 'text-ink'],
    ['منتظر تأیید', fa.format(3), 'text-warning'],
    ['عدم حضور این ماه', fa.format(5), 'text-danger'],
    ['تسویه باز', toman(1_254_800_000n), 'text-ink'],
  ];
  return (
    <div className="grid grid-cols-2 gap-2">
      {items.map(([label, value, tone]) => (
        <div key={label} className="rounded-md border border-border bg-surface p-3">
          <div className="text-[length:var(--text-xs)] text-ink-subtle">{label}</div>
          <div
            className={`figures whitespace-nowrap text-[length:var(--text-lg)] font-bold ${tone}`}
          >
            {value}
          </div>
        </div>
      ))}
    </div>
  );
}

function LedgerTable() {
  const rows: [string, string, bigint, 'success' | 'warning' | 'danger'][] = [
    ['۱۴۰۵/۰۷/۰۱', 'شارژ کیف اعتبار', 1_500_000_000n, 'success'],
    ['۱۴۰۵/۰۷/۰۳', 'ثبت خدمت، کلینیک مهر', 87_500_000n, 'success'],
    ['۱۴۰۵/۰۷/۰۵', 'قسط اول', 125_000_000n, 'warning'],
    ['۱۴۰۵/۰۷/۰۶', 'برگشت خدمت', 12_000_000n, 'danger'],
  ];
  const label = { success: 'تسویه', warning: 'سررسید', danger: 'معکوس' };
  // Whole class names, so Tailwind finds them in the source.
  const tone = {
    success: 'bg-success-soft text-success',
    warning: 'bg-warning-soft text-warning',
    danger: 'bg-danger-soft text-danger',
  };
  return (
    <div className="overflow-x-auto rounded-md border border-border bg-surface">
      <table className="w-full text-[length:var(--text-sm)]">
        <thead className="bg-sunken text-start text-ink-muted">
          <tr>
            <th className="px-3 py-2 text-start font-medium">تاریخ</th>
            <th className="px-3 py-2 text-start font-medium">شرح</th>
            <th className="px-3 py-2 text-end font-medium">مبلغ</th>
            <th className="px-3 py-2 text-start font-medium">وضعیت</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(([date, text, rial, status]) => (
            <tr key={text} className="border-t border-border">
              <td className="figures px-3 py-2 text-ink-muted">{date}</td>
              <td className="px-3 py-2 text-ink">{text}</td>
              <td className="figures px-3 py-2 text-end font-medium text-ink">{toman(rial)}</td>
              <td className="px-3 py-2">
                <span
                  className={`rounded-full px-2 py-0.5 text-[length:var(--text-xs)] ${tone[status]}`}
                >
                  {label[status]}
                </span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Palette({ colors }: { colors: ColorSet }) {
  const names: (keyof ColorSet)[] = [
    'canvas',
    'surface',
    'ink',
    'inkMuted',
    'accent',
    'highlight',
    'success',
    'warning',
    'danger',
    'info',
    'holiday',
    'focus',
  ];
  return (
    <div className="grid grid-cols-3 gap-2 sm:grid-cols-4">
      {names.map((n) => (
        <Swatch
          key={n}
          name={n}
          color={colors[n]}
          on={n === 'surface' || n === 'canvas' ? colors.ink : colors.surface}
        />
      ))}
    </div>
  );
}

function Language({ tone, title, note }: { tone: Tone; title: string; note: string }) {
  return (
    <div data-tone={tone} className="space-y-8 rounded-lg bg-canvas p-6 text-ink">
      <header className="space-y-2">
        <h2
          className="text-[length:var(--text-2xl)] font-extrabold"
          style={{ fontFamily: 'var(--font-heading)' }}
        >
          {title}
        </h2>
        <p className="text-ink-muted">{note}</p>
      </header>
      <Section title="تایپوگرافی">
        <div className="space-y-2 rounded-md bg-surface p-4 shadow-sm">
          <p
            className="text-[length:var(--text-3xl)] font-extrabold leading-[var(--leading-tight)]"
            style={{ fontFamily: 'var(--font-heading)' }}
          >
            درمان امروز، پرداخت آسان
          </p>
          <p
            className="text-[length:var(--text-xl)] font-bold"
            style={{ fontFamily: 'var(--font-heading)' }}
          >
            نوبت بگیرید، با اعتبار سپهر
          </p>
          <p className="max-w-prose leading-[var(--leading-relaxed)] text-ink">
            سپهر سلامتی شما را به پزشک مناسب می‌رساند و هزینه درمان را با اقساط منظم ممکن می‌کند.
            همه مبالغ به ریال نگه‌داری و به تومان نمایش داده می‌شوند؛ ارقام در جدول‌ها هم‌عرض‌اند تا
            ستون‌ها مرتب بمانند.
          </p>
          <p className="text-[length:var(--text-sm)] text-ink-subtle">
            توضیح کوچک · ۱۴۰۵/۰۷/۰۸ · ۰۹:۳۰
          </p>
          <p className="figures text-ink-muted" dir="ltr">
            ۰۱۲۳۴۵۶۷۸۹ · 0123456789 · ١١١١١١ ۸۸۸۸۸۸
          </p>
        </div>
      </Section>
      <Section title="رنگ‌ها (با نسبت کنتراست)">
        <Palette colors={COLORS[tone]} />
      </Section>
      <Section title="دکمه‌ها">
        <Buttons />
      </Section>
      <Section title="فرم">
        <Field />
      </Section>
      <Section title="وضعیت‌ها و هشدار">
        <Badges />
        <Callout />
      </Section>
      {tone === 'patient' ? (
        <Section title="کارت پزشک">
          <DoctorCard />
        </Section>
      ) : (
        <>
          <Section title="شاخص‌ها (فشرده)">
            <Kpis />
          </Section>
          <Section title="جدول مالی (ارقام هم‌عرض)">
            <LedgerTable />
          </Section>
        </>
      )}
    </div>
  );
}

export default function StyleGuide() {
  if (process.env.NODE_ENV === 'production') notFound();
  return (
    <main className="mx-auto max-w-7xl space-y-8 p-6">
      <header className="space-y-2">
        <h1 className="text-[length:var(--text-2xl)] font-bold">صفحه نمونه سیستم طراحی</h1>
        <p className="max-w-3xl text-ink-muted">
          دو زبان بصری سند ۰۸ بخش ۱۳ کنار هم: پنل (آرام و فشرده) و بیمار (گرم و بیانگر). فونت‌ها
          خودمیزبان‌اند (Vazirmatn برای متن، Estedad برای تیتر بیمار)، رنگ‌ها از پالت کاشی ایرانی و
          همه جفت‌های متن و زمینه آزمون کنتراست WCAG 2.2 AA دارند. با کلید Tab حلقه فوکوس را ببینید؛
          با «کاهش حرکت» سیستم، هیچ جابه‌جایی انیمیشنی نیست.
        </p>
      </header>
      <div className="grid gap-6 xl:grid-cols-2">
        <Language
          tone="panel"
          title="پنل مرکز و داخلی"
          note="آرام، فشرده، یک رنگ تأکید (لاجوردی)."
        />
        <Language
          tone="patient"
          title="صفحات بیمار"
          note="گرم و بیانگر: زمینه کرم، فیروزه‌ای و زعفرانی؛ تیتر با Estedad."
        />
      </div>
      <section className="space-y-3">
        <h2 className="text-[length:var(--text-xl)] font-bold">تقویم شمسی و انتخابگر تاریخ</h2>
        <p className="max-w-3xl text-ink-muted">
          یک کامپوننت در کل سامانه، فقط با تاریخ شمسی (ADR-011)؛ تعطیلات، یک روز یا بازه با میان‌بر،
          ورود دستی با هر سه نوع رقم، ظرفیت روز و انتخاب ساعت، و نماهای ماه/هفته/روز برای مرکز.
          کلیدهای جهت، PageUp/PageDown، Home/End.
        </p>
        <CalendarDemo />
      </section>
    </main>
  );
}

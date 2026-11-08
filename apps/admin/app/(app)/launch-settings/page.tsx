import type { SearchParams } from '@sepehr/ui';
import type { Metadata } from 'next';
import { LAUNCH_KEYS } from '../../../lib/launch-keys';
import { ConfigKeysPage } from './config-keys-page';

export const metadata: Metadata = { title: 'تنظیمات راه‌اندازی | پنل داخلی سپهر' };

/** What a value changes for cases already under way, said before anyone proposes it. */
const EFFECT: Readonly<Record<string, string>> = {
  'credit.borrower_exposure_cap':
    'در تصمیم اعتباری و در شارژ سنجیده می‌شود: پرونده تأییدشده و شارژنشده‌ای که با سقف تازه بیش از حد شود، در شارژ رد می‌شود.',
  'instrument.borrower_cheque_min_count':
    'هنگام ثبت تکمیل سنجیده می‌شود: هر پرونده‌ای که هنوز تکمیل نشده، با قاعده تازه سنجیده می‌شود.',
  'instrument.guarantee_cheque_min_bps':
    'هنگام ثبت تکمیل سنجیده می‌شود: هر پرونده‌ای که هنوز تکمیل نشده، با قاعده تازه سنجیده می‌شود.',
  'credit.formation_deposit_rial':
    'روی هر ثبت قفل می‌شود: ثبت‌های قبلی بی‌تغییرند. در پایلوت فقط مشخصات ثبت می‌شود، بی ردیف دفتر کل.',
  'catalog.visit_tariff_internal_only':
    'مسیر یک‌نفره پنل مرکز برای تعرفه ویزیت بسته می‌شود؛ تعرفه‌های موجود بی‌تغییرند.',
  'catalog.search_enabled': 'فقط صفحه جست‌وجوی عمومی بیمار.',
};

/**
 * The launch-day settings (owner 1405/08/01–02, plan item الف): the borrower cap, the cheque
 * rule, the formation deposit, the visit-price flag and the public search, typed in plain
 * fields.
 */
export default function LaunchSettingsPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  return (
    <ConfigKeysPage
      searchParams={searchParams}
      keys={LAUNCH_KEYS}
      title="تنظیمات راه‌اندازی"
      path="/launch-settings"
      effect={EFFECT}
    />
  );
}

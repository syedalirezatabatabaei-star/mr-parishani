import type { SearchParams } from '@sepehr/ui';
import type { Metadata } from 'next';
import { OTHER_BUSINESS_KEYS } from '../../../lib/launch-keys';
import { ConfigKeysPage } from '../launch-settings/config-keys-page';

export const metadata: Metadata = { title: 'تنظیمات اقساط، چک و تسویه | پنل داخلی سپهر' };

/** What a value changes for cases already under way, said before anyone proposes it. */
const EFFECT: Readonly<Record<string, string>> = {
  'repayment.cancellation_penalty_bps':
    'روی قرارداد هر پرونده هنگام صدور قفل می‌شود: قراردادهای صادرشده با نرخ خودشان می‌مانند. نرخ یک پرونده خاص با درخواست حسابداری و تأیید مدیرعامل تغییر می‌کند.',
  'repayment.cancellation_penalty_due_days':
    'برای انصراف‌هایی که از این پس ثبت می‌شوند؛ سررسید خسارت‌های ثبت‌شده بی‌تغییر است.',
  'instrument.execution_min_days_past_due':
    'هنگام پیشنهاد اجرای چک سنجیده می‌شود؛ پیشنهادهای ثبت‌شده بی‌تغییرند.',
  'instrument.promissory_enabled':
    'خاموش: قلم و ابزار تازه از نوع سفته ثبت نمی‌شود؛ سفته‌های ثبت‌شده و ارجاع حقوقی آن‌ها بی‌تغییرند.',
  'settlement.payout_day':
    'این مقدار ثبت و نسخه‌بندی می‌شود، ولی هنوز هیچ محاسبه یا زمان‌بندی تسویه آن را نمی‌خواند.',
  'repayment.grace_days':
    'روی هر برنامه اقساط هنگام ساخت قفل می‌شود: برنامه‌های ساخته‌شده با مهلت خودشان می‌مانند.',
};

/**
 * Business keys that had no page until the owner's order of 1405/08/10: typed, proposed by
 * one strategy manager and approved by another, as the launch settings.
 */
export default function BusinessSettingsPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  return (
    <ConfigKeysPage
      searchParams={searchParams}
      keys={OTHER_BUSINESS_KEYS}
      title="تنظیمات اقساط، چک و تسویه"
      path="/business-settings"
      effect={EFFECT}
    />
  );
}

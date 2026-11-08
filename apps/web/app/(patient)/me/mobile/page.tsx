import { Notice, PageHeader } from '@sepehr/ui';
import type { Metadata } from 'next';
import { ChangeMobile } from './change-mobile';

export const metadata: Metadata = {
  title: 'تغییر شماره موبایل | سپهر سلامتی',
  robots: { index: false, follow: false },
};

/**
 * ف۱۲ ب۱ (owner 1405/07/26, option «ب»): a signed-in patient replaces their login mobile with
 * one proved by a code sent to it; the previous one is told. A lost phone is support's, by two
 * people (ب۲). Off until launch (`identity.patient_mobile_change`): the API says so.
 */
export default function ChangeMobilePage() {
  return (
    <>
      <PageHeader
        title="تغییر شماره موبایل"
        description="شماره تازه با کدی که به همان شماره پیامک می‌شود تأیید می‌شود. نوبت‌ها، پرونده‌ها و اقساط شما همراه حساب می‌مانند."
      />
      <div className="max-w-md space-y-4">
        <Notice tone="info">
          پس از تغییر، به شماره قبلی پیامکی می‌رود که شماره عوض شد، و ورود شما در دستگاه‌های دیگر
          بسته می‌شود. رضایت دریافت پیامک تبلیغاتی به شماره تازه منتقل نمی‌شود.
        </Notice>
        <ChangeMobile />
        <p className="text-[length:var(--text-sm)] text-ink-muted">
          گوشی یا سیم‌کارت قبلی را ندارید؟ با پشتیبانی تماس بگیرید؛ تغییر شماره با مدرک و تأیید دو
          کارشناس انجام می‌شود.
        </p>
      </div>
    </>
  );
}

'use client';

import { Notice, VerifyMobile } from '@sepehr/ui';
import { useRouter } from 'next/navigation';

/**
 * Owner, question 3 of task 9-3: an internal staff member without a proved mobile sees only
 * this until they prove one; nothing is locked, and the panel opens as soon as it is done.
 */
export function RequiredMobile() {
  const router = useRouter();
  return (
    <section className="max-w-xl space-y-4">
      <h1 className="text-[length:var(--text-xl)] font-bold">تأیید موبایل حساب</h1>
      <Notice tone="warning">
        برای ادامه کار در پنل داخلی، موبایل خود را ثبت و با کد پیامک‌شده تأیید کنید. پیام‌های امنیتی
        حساب، مانند تغییر گذرواژه، به همین شماره فرستاده می‌شوند.
      </Notice>
      <VerifyMobile
        verified={false}
        onVerified={() => {
          router.refresh();
        }}
      />
    </section>
  );
}

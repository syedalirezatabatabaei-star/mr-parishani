import { AccountSecurity, PageHeader } from '@sepehr/ui';
import type { Metadata } from 'next';

export const metadata: Metadata = { title: 'حساب من | پنل داخلی سپهر' };

/** The staff member's own password and open sessions (task 9-3, R2). */
export default function AccountPage() {
  return (
    <>
      <PageHeader title="حساب من" description="تغییر گذرواژه و نشست‌های باز شما." />
      <AccountSecurity />
    </>
  );
}

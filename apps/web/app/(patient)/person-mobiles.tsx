import { unwrap } from '@sepehr/api-client';
import { faDigits, Notice, showInstantDay } from '@sepehr/ui';
import { serverApi } from '../../lib/server-api';
import { PendingMobileDecision } from './pending-mobile-decision';

/**
 * Task 9-3 (go-live blocker م۵): a mobile added to a patient's Person by national ID waits for
 * the patient's own approval here (method الف: this login is the code to their proved mobile).
 * A login whose own mobile is pending is told why it sees nothing. Only the last four digits
 * of a pending mobile are shown. Nothing for staff, or when the API cannot answer.
 */
export async function PersonMobilesBanner() {
  let mine;
  try {
    mine = await unwrap((await serverApi()).GET('/api/v1/person-mobiles/mine'));
  } catch {
    return null;
  }
  if (mine.ownMobilePending) {
    return (
      <Notice tone="info" title="این شماره در انتظار تأیید است">
        این شماره به پرونده کسی افزوده شده که پیش‌تر شماره دیگری داشته است. تا صاحب آن شماره در حساب
        خود یا پشتیبانی آن را تأیید نکند، هیچ نوبت، پرونده یا قسطی اینجا نمایش داده نمی‌شود.
      </Notice>
    );
  }
  if (mine.awaitingDecision.length === 0) return null;
  return (
    <Notice tone="warning" title="درخواست افزودن شماره تازه به حساب شما">
      <ul className="space-y-3">
        {mine.awaitingDecision.map((m) => (
          <li key={m.id} className="space-y-2">
            <p>
              شماره‌ای که به {faDigits(m.mobileLast4)} ختم می‌شود می‌خواهد به نوبت‌ها، پیش‌فاکتورها،
              پرونده‌های اعتباری و اقساط شما دسترسی داشته باشد.
              {m.expiresAt
                ? ` اگر تا ${showInstantDay(m.expiresAt)} تصمیم نگیرید، خودکار رد می‌شود.`
                : ''}
            </p>
            <PendingMobileDecision id={m.id} />
          </li>
        ))}
      </ul>
    </Notice>
  );
}

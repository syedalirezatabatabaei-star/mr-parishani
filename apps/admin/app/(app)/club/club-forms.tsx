'use client';

import { unwrap } from '@sepehr/api-client';
import type { JalaliDate } from '@sepehr/contracts';
import {
  apiDay,
  buttonClass,
  DateField,
  defined,
  errorMessage,
  formText,
  Notice,
  TextField,
  useApi,
} from '@sepehr/ui';
import { useRouter } from 'next/navigation';
import { useState, type SubmitEvent } from 'react';

function useSubmit() {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const run = async (action: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await action();
      router.refresh();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };
  return { error, setError, busy, run };
}

/** The person by their mobile, in any form (normalized by the API). */
export function FindMember({ mobile }: { mobile: string }) {
  const router = useRouter();
  return (
    <form
      className="flex flex-wrap items-end gap-3"
      aria-label="جست‌وجوی عضو"
      noValidate
      onSubmit={(e) => {
        e.preventDefault();
        const typed = formText(e.currentTarget, 'mobile').trim();
        router.push(typed ? `/club?mobile=${encodeURIComponent(typed)}` : '/club');
      }}
    >
      <TextField
        id="club-mobile"
        name="mobile"
        label="شماره موبایل"
        dir="ltr"
        figures
        inputMode="tel"
        defaultValue={mobile}
        required
      />
      <button type="submit" className={buttonClass('secondary')}>
        جست‌وجو
      </button>
    </form>
  );
}

export function RecordMembership({ mobile, today }: { mobile: string; today: JalaliDate }) {
  const api = useApi();
  const { error, setError, busy, run } = useSubmit();
  const [startsOn, setStartsOn] = useState<JalaliDate | null>(today);
  const [endsOn, setEndsOn] = useState<JalaliDate | null>(null);
  const submit = (e: SubmitEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (!startsOn) {
      setError('روز شروع عضویت را انتخاب کنید.');
      return;
    }
    const form = e.currentTarget;
    void run(() =>
      unwrap(
        api.POST('/api/v1/lead/club-memberships', {
          body: {
            mobile,
            startsOn: apiDay(startsOn),
            reason: formText(form, 'reason'),
            ...defined({ endsOn: endsOn ? apiDay(endsOn) : undefined }),
          },
        }),
      ),
    );
  };
  return (
    <form onSubmit={submit} className="space-y-3" aria-label="ثبت عضویت باشگاه" noValidate>
      <div className="grid gap-3 sm:grid-cols-3">
        <DateField
          mode="single"
          label="روز شروع"
          today={today}
          value={startsOn}
          onChange={(d) => {
            setStartsOn(d);
            setError(null);
          }}
        />
        <DateField
          mode="single"
          label="روز پایان (اختیاری)"
          today={today}
          value={endsOn}
          onChange={(d) => {
            setEndsOn(d);
            setError(null);
          }}
        />
        <TextField id="club-reason" name="reason" label="دلیل" required />
      </div>
      <button type="submit" disabled={busy} className={buttonClass('primary')}>
        ثبت عضویت
      </button>
      {error && <Notice tone="danger">{error}</Notice>}
    </form>
  );
}

/** Ends a membership from a day on, once, with a reason. */
export function RevokeMembership({ id, today }: { id: string; today: JalaliDate }) {
  const api = useApi();
  const { error, setError, busy, run } = useSubmit();
  const [revokedOn, setRevokedOn] = useState<JalaliDate | null>(today);
  const submit = (e: SubmitEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (!revokedOn) {
      setError('روز لغو را انتخاب کنید.');
      return;
    }
    const form = e.currentTarget;
    void run(() =>
      unwrap(
        api.POST('/api/v1/lead/club-memberships/{id}/revoke', {
          params: { path: { id } },
          body: { revokedOn: apiDay(revokedOn), reason: formText(form, 'reason') },
        }),
      ),
    );
  };
  return (
    <form onSubmit={submit} className="space-y-2" aria-label="لغو عضویت" noValidate>
      <DateField
        mode="single"
        label="لغو از روز"
        today={today}
        value={revokedOn}
        onChange={(d) => {
          setRevokedOn(d);
          setError(null);
        }}
      />
      <TextField id={`club-revoke-${id}-reason`} name="reason" label="دلیل لغو" required />
      <button type="submit" disabled={busy} className={buttonClass('secondary')}>
        لغو عضویت
      </button>
      {error && <Notice tone="danger">{error}</Notice>}
    </form>
  );
}

'use client';

import { unwrap } from '@sepehr/api-client';
import {
  ANNOUNCEMENT_AUDIENCES,
  BANNER_AUDIENCES,
  BANNER_TONES,
  fromJalali,
  type BannerView,
  type JalaliDate,
} from '@sepehr/contracts';
import {
  buttonClass,
  CheckboxField,
  DateField,
  errorMessage,
  FILE_KINDS,
  FileDropzone,
  formText,
  Notice,
  SelectField,
  TextAreaField,
  TextField,
  useApi,
} from '@sepehr/ui';
import { useRouter } from 'next/navigation';
import { useState, type SubmitEvent } from 'react';
import { ANNOUNCEMENT_AUDIENCE, BANNER_AUDIENCE, BANNER_TONE } from './labels';

export function useRun() {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const run = async (action: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await action();
      router.refresh();
      return true;
    } catch (err) {
      setError(errorMessage(err));
      return false;
    } finally {
      setBusy(false);
    }
  };
  return { error, setError, busy, run };
}

/** A Jalali day as the start of that day in Tehran; none: now. */
const startOf = (day: JalaliDate | null) =>
  day ? fromJalali(day).toISOString() : new Date().toISOString();

type Kind = 'banners' | 'pages' | 'announcements';

/**
 * The second person's decision on a version (owner 1405/08/10): approve, or reject with a
 * reason; never the proposer's own (the API and the database refuse it too).
 */
export function DecideVersion({ kind, id, mine }: { kind: Kind; id: string; mine: boolean }) {
  const api = useApi();
  const { error, setError, busy, run } = useRun();
  if (mine) return <span className="text-ink-muted">پیشنهاد شما؛ نفر دوم تصمیم می‌گیرد.</span>;
  const decide = (approve: boolean, form: HTMLFormElement | null) => {
    const reason = form ? formText(form, 'reason').trim() : '';
    if (!approve && reason.length < 3) {
      setError('دلیل رد را بنویسید.');
      return;
    }
    const body = { approve, ...(reason ? { reason } : {}) };
    const params = { path: { id } };
    void run(async () => {
      if (kind === 'banners') {
        await unwrap(api.POST('/api/v1/config/content/banners/{id}/decision', { params, body }));
      } else if (kind === 'pages') {
        await unwrap(
          api.POST('/api/v1/config/content/pages/versions/{id}/decision', { params, body }),
        );
      } else {
        await unwrap(
          api.POST('/api/v1/config/content/announcements/{id}/decision', { params, body }),
        );
      }
    });
  };
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
      }}
      aria-label="تصمیم نفر دوم"
      className="flex flex-wrap items-end gap-2"
    >
      <TextField id={`reason-${id}`} name="reason" label="دلیل (برای رد لازم)" />
      <button
        type="button"
        disabled={busy}
        className={buttonClass('primary')}
        onClick={(e) => {
          decide(true, e.currentTarget.form);
        }}
      >
        تأیید
      </button>
      <button
        type="button"
        disabled={busy}
        className={buttonClass('danger')}
        onClick={(e) => {
          decide(false, e.currentTarget.form);
        }}
      >
        رد
      </button>
      {error && <Notice tone="danger">{error}</Notice>}
    </form>
  );
}

/**
 * A banner, new or a new version of one (owner 1405/08/10): its text, tone or picture, link,
 * order, window, audiences, on or off and how long it stays.
 */
export function ProposeBanner({
  today,
  current,
}: {
  today: JalaliDate;
  current?: BannerView | undefined;
}) {
  const api = useApi();
  const { error, setError, busy, run } = useRun();
  const [from, setFrom] = useState<JalaliDate | null>(null);
  const [until, setUntil] = useState<JalaliDate | null>(null);
  const [done, setDone] = useState(false);
  const submit = (e: SubmitEvent<HTMLFormElement>) => {
    e.preventDefault();
    const form = e.currentTarget;
    const data = new FormData(form);
    const audiences = BANNER_AUDIENCES.filter((a) => data.get(`aud-${a}`) === 'true');
    if (audiences.length === 0) {
      setError('دست‌کم یک مخاطب را انتخاب کنید.');
      return;
    }
    const linkHref = formText(form, 'linkHref').trim();
    const linkLabel = formText(form, 'linkLabel').trim();
    const proposal = {
      ...(current ? { bannerKey: current.bannerKey } : {}),
      title: formText(form, 'title'),
      body: formText(form, 'body'),
      tone: formText(form, 'tone'),
      linkHref: linkHref || null,
      linkLabel: linkLabel || null,
      sortOrder: Number(formText(form, 'sortOrder') || '0'),
      startsAt: current && !from ? current.startsAt : startOf(from),
      endsAt: until ? fromJalali(until).toISOString() : null,
      audiences,
      active: data.get('active') === 'true',
      displaySeconds: Number(formText(form, 'seconds') || '6'),
      reason: formText(form, 'reason'),
    };
    const image = data.get('image');
    setDone(false);
    void run(() =>
      unwrap(
        api.POST('/api/v1/config/content/banners', {
          body: { proposal: JSON.stringify(proposal) },
          bodySerializer: () => {
            const body = new FormData();
            body.append('proposal', JSON.stringify(proposal));
            if (image instanceof File && image.size > 0) body.append('image', image, image.name);
            return body;
          },
        }),
      ),
    ).then((ok) => {
      if (ok) {
        if (!current) form.reset();
        setDone(true);
      }
    });
  };
  const key = current?.bannerKey ?? 'new';
  return (
    <form
      onSubmit={submit}
      noValidate
      aria-label={current ? `نسخه تازه بنر «${current.title}»` : 'بنر تازه'}
      className="space-y-3 rounded-lg border border-border bg-surface p-4"
    >
      <div className="grid gap-3 sm:grid-cols-2">
        <TextField
          id={`title-${key}`}
          name="title"
          label="عنوان"
          defaultValue={current?.title ?? ''}
          required
        />
        <SelectField
          id={`tone-${key}`}
          name="tone"
          label="رنگ پس‌زمینه"
          defaultValue={current?.tone ?? 'accent'}
          options={BANNER_TONES.map((t) => ({ value: t, label: BANNER_TONE[t] ?? t }))}
        />
        <TextAreaField
          id={`body-${key}`}
          name="body"
          label="متن کوتاه (حداکثر ۲۰۰ نویسه)"
          maxLength={200}
          rows={2}
          defaultValue={current?.body ?? ''}
          required
        />
        <div className="space-y-1">
          <FileDropzone
            id={`image-${key}`}
            name="image"
            label="تصویر (اختیاری)"
            kinds={[FILE_KINDS.jpg, FILE_KINDS.png]}
            maxBytes={2 * 1024 * 1024}
            busy={busy}
          />
          {current?.hasImage && (
            <p className="text-[length:var(--text-xs)] text-ink-muted">
              بی فایل تازه، تصویر فعلی می‌ماند.
            </p>
          )}
        </div>
        <TextField
          id={`link-${key}`}
          name="linkHref"
          label="لینک (مسیر داخل سایت، مثل /search)"
          dir="ltr"
          defaultValue={current?.linkHref ?? ''}
        />
        <TextField
          id={`label-${key}`}
          name="linkLabel"
          label="متن دکمه"
          defaultValue={current?.linkLabel ?? ''}
        />
        <TextField
          id={`order-${key}`}
          name="sortOrder"
          label="ترتیب (۰ اول)"
          inputMode="numeric"
          dir="ltr"
          defaultValue={String(current?.sortOrder ?? 0)}
        />
        <TextField
          id={`seconds-${key}`}
          name="seconds"
          label="مدت نمایش (۳ تا ۳۰ ثانیه)"
          inputMode="numeric"
          dir="ltr"
          defaultValue={String(current?.displaySeconds ?? 6)}
        />
        <DateField
          mode="single"
          label={current ? 'شروع (خالی: همان قبلی)' : 'شروع (خالی: از لحظه تأیید)'}
          today={today}
          value={from}
          onChange={setFrom}
        />
        <DateField
          mode="single"
          label="پایان (اختیاری)"
          today={today}
          value={until}
          onChange={setUntil}
        />
      </div>
      <fieldset className="space-y-1">
        <legend className="text-[length:var(--text-sm)] font-medium">مخاطب</legend>
        <div className="flex flex-wrap gap-4">
          {BANNER_AUDIENCES.map((a) => (
            <CheckboxField
              key={a}
              id={`aud-${a}-${key}`}
              name={`aud-${a}`}
              label={BANNER_AUDIENCE[a]}
              defaultChecked={current ? current.audiences.includes(a) : a === 'patient'}
            />
          ))}
        </div>
      </fieldset>
      <CheckboxField
        id={`active-${key}`}
        name="active"
        label="فعال"
        defaultChecked={current?.active ?? true}
      />
      <TextField id={`reason-new-${key}`} name="reason" label="دلیل تغییر" required />
      <p className="text-[length:var(--text-xs)] text-ink-subtle">
        حداکثر ۵ بنر فعال برای هر مخاطب. پس از ثبت، پشتیبانی یا مدیر سیستم دیگر باید تأیید کند.
      </p>
      {error && <Notice tone="danger">{error}</Notice>}
      {done && <Notice tone="success">پیشنهاد ثبت شد؛ منتظر تأیید نفر دوم.</Notice>}
      <button type="submit" disabled={busy} className={buttonClass('primary')}>
        {current ? 'پیشنهاد نسخه تازه' : 'پیشنهاد بنر'}
      </button>
    </form>
  );
}

/** An announcement, new or a new version: who it is for, urgent or not, its window. */
export function ProposeAnnouncement({ today }: { today: JalaliDate }) {
  const api = useApi();
  const { error, busy, run } = useRun();
  const [audience, setAudience] = useState('all');
  const [from, setFrom] = useState<JalaliDate | null>(null);
  const [until, setUntil] = useState<JalaliDate | null>(null);
  const [done, setDone] = useState(false);
  const submit = (e: SubmitEvent<HTMLFormElement>) => {
    e.preventDefault();
    const form = e.currentTarget;
    const data = new FormData(form);
    setDone(false);
    void run(() =>
      unwrap(
        api.POST('/api/v1/config/content/announcements', {
          body: {
            title: formText(form, 'title'),
            body: formText(form, 'body'),
            audience: ANNOUNCEMENT_AUDIENCES.find((a) => a === audience) ?? 'all',
            roleCode: audience === 'role' ? formText(form, 'role').trim() : null,
            urgent: data.get('urgent') === 'true',
            startsAt: startOf(from),
            endsAt: until ? fromJalali(until).toISOString() : null,
            active: true,
            reason: formText(form, 'reason'),
          },
        }),
      ),
    ).then((ok) => {
      if (ok) {
        form.reset();
        setDone(true);
      }
    });
  };
  return (
    <form
      onSubmit={submit}
      noValidate
      aria-label="اطلاعیه تازه"
      className="space-y-3 rounded-lg border border-border bg-surface p-4"
    >
      <div className="grid gap-3 sm:grid-cols-2">
        <TextField id="a-title" name="title" label="عنوان" required />
        <SelectField
          id="a-audience"
          name="audience"
          label="مخاطب"
          defaultValue="all"
          onChange={setAudience}
          options={ANNOUNCEMENT_AUDIENCES.map((a) => ({
            value: a,
            label: ANNOUNCEMENT_AUDIENCE[a],
          }))}
        />
        <TextAreaField id="a-body" name="body" label="متن" rows={3} maxLength={1000} required />
        {audience === 'role' && (
          <TextField
            id="a-role"
            name="role"
            label="کد نقش (مثل support یا credit_specialist)"
            dir="ltr"
            required
          />
        )}
        <DateField
          mode="single"
          label="شروع (خالی: از لحظه تأیید)"
          today={today}
          value={from}
          onChange={setFrom}
        />
        <DateField
          mode="single"
          label="پایان (اختیاری)"
          today={today}
          value={until}
          onChange={setUntil}
        />
      </div>
      <CheckboxField id="a-urgent" name="urgent" label="فوری (بالای فهرست اعلان‌ها)" />
      <TextField id="a-reason" name="reason" label="دلیل" required />
      {error && <Notice tone="danger">{error}</Notice>}
      {done && <Notice tone="success">پیشنهاد ثبت شد؛ منتظر تأیید نفر دوم.</Notice>}
      <button type="submit" disabled={busy} className={buttonClass('primary')}>
        پیشنهاد اطلاعیه
      </button>
    </form>
  );
}

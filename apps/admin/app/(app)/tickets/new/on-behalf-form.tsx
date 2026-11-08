'use client';

import { unwrap } from '@sepehr/api-client';
import type { TicketTopicOption } from '@sepehr/contracts';
import {
  buttonClass,
  errorMessage,
  formText,
  Notice,
  SelectField,
  TextAreaField,
  TextField,
  useApi,
} from '@sepehr/ui';
import { useRouter } from 'next/navigation';
import { useState, type SubmitEvent } from 'react';

/**
 * A caller's ticket written by staff (doc 17 §1: «از پنل داخلی برای ثبت از طرف تماس‌گیرنده»):
 * the caller's mobile names them; it becomes their own ticket, which they see in their panel.
 */
export function OnBehalfForm({ topics }: { topics: readonly TicketTopicOption[] }) {
  const api = useApi();
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = (e: SubmitEvent<HTMLFormElement>) => {
    e.preventDefault();
    const form = e.currentTarget;
    const body = {
      mobile: formText(form, 'mobile'),
      topicCode: formText(form, 'topic'),
      subject: formText(form, 'subject'),
      body: formText(form, 'body'),
      links: [],
    };
    setBusy(true);
    setError(null);
    void unwrap(api.POST('/api/v1/tickets', { body }))
      .then((made) => {
        router.push(`/tickets/${made.id}`);
      })
      .catch((err: unknown) => {
        setError(errorMessage(err));
        setBusy(false);
      });
  };
  return (
    <form
      onSubmit={submit}
      className="space-y-4 rounded-lg border border-border bg-surface p-4"
      aria-label="ثبت از طرف تماس‌گیرنده"
      noValidate
    >
      <TextField
        id="behalf-mobile"
        name="mobile"
        label="موبایل تماس‌گیرنده"
        type="tel"
        inputMode="tel"
        dir="ltr"
        figures
        required
      />
      <SelectField
        id="behalf-topic"
        name="topic"
        label="موضوع"
        options={topics.map((t) => ({
          value: t.code,
          label: t.kind === 'complaint' ? `شکایت: ${t.title}` : t.title,
        }))}
      />
      <TextField id="behalf-subject" name="subject" label="عنوان" required />
      <TextAreaField id="behalf-body" name="body" label="شرح گفته‌های تماس‌گیرنده" required />
      {error ? <Notice tone="danger">{error}</Notice> : null}
      <button type="submit" disabled={busy} className={buttonClass('primary')}>
        ثبت
      </button>
    </form>
  );
}

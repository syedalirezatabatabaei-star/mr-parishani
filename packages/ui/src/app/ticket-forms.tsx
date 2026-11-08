'use client';

import { unwrap, type ApiClient } from '@sepehr/api-client';
import type { TicketLinkType, TicketTopicOption } from '@sepehr/contracts';
import { useState, type SubmitEvent } from 'react';
import {
  buttonClass,
  CheckboxField,
  Notice,
  SelectField,
  TextAreaField,
  TextField,
} from '../kit/controls.js';
import { FILE_KINDS, FileDropzone } from '../kit/file-dropzone.js';
import { useApi } from './browser-api.js';
import { errorMessage } from './errors.js';
import { formText } from './form.js';

/**
 * A ticket's forms (task 7-7; doc 17 §1), the same for the patient (`me`), a center (`panel`)
 * and staff (`staff`): open, write, attach, close and reopen. Each side calls its own API,
 * which alone decides what the caller may link, see and do (rule 12). Like the staff login,
 * they reload the page when done: this package does not depend on Next's router.
 */

export type TicketSide = 'me' | 'panel' | 'staff';
type Requester = Exclude<TicketSide, 'staff'>;

export interface TicketLinkOption {
  readonly type: TicketLinkType;
  readonly id: string;
  readonly label: string;
}

const MAX_FILE_BYTES = 10 * 1024 * 1024;
const checked = (form: HTMLFormElement, name: string) => new FormData(form).get(name) === 'true';

function fileOf(form: HTMLFormElement): File | null {
  const file = new FormData(form).get('file');
  return file instanceof File && file.size > 0 ? file : null;
}

async function attach(
  api: ApiClient,
  side: TicketSide,
  id: string,
  file: File,
  fields: { containsTreatment: boolean; visibility: 'public' | 'internal' },
) {
  const body = {
    containsTreatment: fields.containsTreatment ? ('true' as const) : ('false' as const),
    visibility: fields.visibility,
  };
  const bodySerializer = () => {
    const data = new FormData();
    data.append('containsTreatment', body.containsTreatment);
    data.append('visibility', body.visibility);
    data.append('file', file, file.name);
    return data;
  };
  const params = { path: { id } };
  if (side === 'me') {
    return unwrap(
      api.POST('/api/v1/me/tickets/{id}/attachments', { params, body, bodySerializer }),
    );
  }
  if (side === 'panel') {
    return unwrap(
      api.POST('/api/v1/panel/tickets/{id}/attachments', { params, body, bodySerializer }),
    );
  }
  return unwrap(api.POST('/api/v1/tickets/{id}/attachments', { params, body, bodySerializer }));
}

/** A new ticket: a topic, a subject, the first message, links and a file (doc 17 §1). */
export function NewTicketForm({
  side,
  topics,
  links,
  financialItems = [],
  hrefBase,
}: {
  side: Requester;
  topics: readonly TicketTopicOption[];
  /** What the opener may link (their own appointments, proformas…): the API checks again. */
  links: readonly TicketLinkOption[];
  /** A center's own settlement items, which a financial complaint holds (7-2). */
  financialItems?: readonly TicketLinkOption[];
  /** Where a made ticket is shown: `${hrefBase}/${id}` (a string: a server page passes it). */
  hrefBase: string;
}) {
  const api = useApi();
  const [topic, setTopic] = useState(topics[0]?.code ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const financial = topics.find((t) => t.code === topic)?.financial === true;

  const submit = async (e: SubmitEvent<HTMLFormElement>) => {
    e.preventDefault();
    const form = e.currentTarget;
    const chosen = formText(form, financial ? 'item' : 'link');
    const pool = financial ? financialItems : links;
    const link = pool.find((l) => `${l.type}:${l.id}` === chosen);
    if (financial && !link) {
      setError('قلمی را که به آن اعتراض دارید انتخاب کنید.');
      return;
    }
    const file = fileOf(form);
    if (file && file.size > MAX_FILE_BYTES) {
      setError('پیوست باید کمتر از ۱۰ مگابایت باشد.');
      return;
    }
    const body = {
      topicCode: topic,
      subject: formText(form, 'subject'),
      body: formText(form, 'body'),
      links: link ? [{ type: link.type, id: link.id }] : [],
    };
    setBusy(true);
    setError(null);
    try {
      const made =
        side === 'me'
          ? await unwrap(api.POST('/api/v1/me/tickets', { body }))
          : await unwrap(api.POST('/api/v1/panel/tickets', { body }));
      if (file) {
        await attach(api, side, made.id, file, {
          containsTreatment: checked(form, 'containsTreatment'),
          visibility: 'public',
        });
      }
      window.location.assign(`${hrefBase}/${made.id}`);
    } catch (err) {
      setError(errorMessage(err));
      setBusy(false);
    }
  };

  if (topics.length === 0) {
    return <Notice tone="info">ثبت تیکت فعلاً ممکن نیست؛ موضوعی تعریف نشده است.</Notice>;
  }
  return (
    <form
      onSubmit={(e) => void submit(e)}
      className="space-y-4 rounded-lg border border-border bg-surface p-4"
      aria-label="تیکت تازه"
      noValidate
    >
      <SelectField
        id="ticket-topic"
        name="topic"
        label="موضوع"
        options={topics.map((t) => ({
          value: t.code,
          label: t.kind === 'complaint' ? `شکایت: ${t.title}` : t.title,
        }))}
        defaultValue={topic}
        onChange={setTopic}
      />
      {financial ? (
        <>
          <SelectField
            id="ticket-item"
            name="item"
            label="قلم مورد اعتراض"
            emptyLabel="انتخاب کنید"
            options={financialItems.map((l) => ({ value: `${l.type}:${l.id}`, label: l.label }))}
            hint="تا تعیین تکلیف حسابداری، این قلم در صورت‌وضعیت نمی‌آید."
          />
          {financialItems.length === 0 && (
            <Notice tone="info">قلم در انتظار سررسیدی برای اعتراض ندارید.</Notice>
          )}
        </>
      ) : (
        links.length > 0 && (
          <SelectField
            id="ticket-link"
            name="link"
            label="مربوط به"
            emptyLabel="هیچ‌کدام"
            options={links.map((l) => ({ value: `${l.type}:${l.id}`, label: l.label }))}
          />
        )
      )}
      <TextField id="ticket-subject" name="subject" label="عنوان" required />
      <TextAreaField id="ticket-body" name="body" label="شرح" required maxLength={4000} />
      <FileDropzone
        id="ticket-file"
        name="file"
        label="پیوست (اختیاری)"
        kinds={[FILE_KINDS.jpg, FILE_KINDS.png, FILE_KINDS.pdf]}
        maxBytes={10 * 1024 * 1024}
      />
      <CheckboxField
        id="ticket-treatment"
        name="containsTreatment"
        label="پیوست حاوی اطلاعات درمان است"
        hint="برای واحد معوقات نمایش داده نمی‌شود."
      />
      {error ? <Notice tone="danger">{error}</Notice> : null}
      <button type="submit" disabled={busy} className={buttonClass('primary')}>
        ثبت
      </button>
    </form>
  );
}

/** A message, with an optional file; staff choose public or internal (test 3). */
export function TicketReply({ side, id }: { side: TicketSide; id: string }) {
  const api = useApi();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: SubmitEvent<HTMLFormElement>) => {
    e.preventDefault();
    const form = e.currentTarget;
    const body = formText(form, 'body');
    const containsTreatment = checked(form, 'containsTreatment');
    const visibility = side === 'staff' && checked(form, 'internal') ? 'internal' : 'public';
    const file = fileOf(form);
    if (body.trim() === '' && !file) {
      setError('متن پیام را بنویسید یا پیوستی انتخاب کنید.');
      return;
    }
    if (file && file.size > MAX_FILE_BYTES) {
      setError('پیوست باید کمتر از ۱۰ مگابایت باشد.');
      return;
    }
    setBusy(true);
    setError(null);
    const params = { path: { id } };
    try {
      if (body.trim() !== '') {
        if (side === 'me') {
          await unwrap(
            api.POST('/api/v1/me/tickets/{id}/messages', {
              params,
              body: { body, containsTreatment },
            }),
          );
        } else if (side === 'panel') {
          await unwrap(
            api.POST('/api/v1/panel/tickets/{id}/messages', {
              params,
              body: { body, containsTreatment },
            }),
          );
        } else {
          await unwrap(
            api.POST('/api/v1/tickets/{id}/messages', {
              params,
              body: { body, visibility, containsTreatment },
            }),
          );
        }
      }
      if (file) await attach(api, side, id, file, { containsTreatment, visibility });
      form.reset();
      window.location.reload();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form
      onSubmit={(e) => void submit(e)}
      className="space-y-3 rounded-lg border border-border bg-surface p-4"
      aria-label="پاسخ"
      noValidate
    >
      <TextAreaField id="reply-body" name="body" label="پیام" maxLength={4000} />
      <FileDropzone
        id="reply-file"
        name="file"
        label="پیوست (اختیاری)"
        kinds={[FILE_KINDS.jpg, FILE_KINDS.png, FILE_KINDS.pdf]}
        maxBytes={10 * 1024 * 1024}
      />
      <CheckboxField
        id="reply-treatment"
        name="containsTreatment"
        label="حاوی اطلاعات درمان"
        hint="برای واحد معوقات نمایش داده نمی‌شود."
      />
      {side === 'staff' && (
        <CheckboxField
          id="reply-internal"
          name="internal"
          label="یادداشت داخلی"
          hint="فقط کارکنان می‌بینند؛ برای ثبت‌کننده فرستاده نمی‌شود."
        />
      )}
      {error ? <Notice tone="danger">{error}</Notice> : null}
      <button type="submit" disabled={busy} className={buttonClass('primary')}>
        ارسال
      </button>
    </form>
  );
}

/** The requester closes their resolved ticket, or reopens it with a reason. */
export function TicketRequesterActions({
  side,
  id,
  canClose,
  canReopen,
}: {
  side: Requester;
  id: string;
  canClose: boolean;
  canReopen: boolean;
}) {
  const api = useApi();
  const [reopening, setReopening] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const params = { path: { id } };

  const run = async (action: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await action();
      setReopening(false);
      window.location.reload();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };
  const close = () =>
    run(() =>
      side === 'me'
        ? unwrap(api.POST('/api/v1/me/tickets/{id}/close', { params }))
        : unwrap(api.POST('/api/v1/panel/tickets/{id}/close', { params })),
    );
  const reopen = (e: SubmitEvent<HTMLFormElement>) => {
    e.preventDefault();
    const body = { reason: formText(e.currentTarget, 'reason') };
    void run(() =>
      side === 'me'
        ? unwrap(api.POST('/api/v1/me/tickets/{id}/reopen', { params, body }))
        : unwrap(api.POST('/api/v1/panel/tickets/{id}/reopen', { params, body })),
    );
  };

  if (!canClose && !canReopen) return null;
  return (
    <div className="space-y-2">
      {reopening ? (
        <form onSubmit={reopen} className="space-y-2" aria-label="بازگشایی" noValidate>
          <TextField id="reopen-reason" name="reason" label="چرا مشکل حل نشده است؟" required />
          <div className="flex flex-wrap gap-2">
            <button type="submit" disabled={busy} className={buttonClass('primary')}>
              بازگشایی
            </button>
            <button
              type="button"
              className={buttonClass('quiet')}
              onClick={() => {
                setReopening(false);
              }}
            >
              انصراف
            </button>
          </div>
        </form>
      ) : (
        <div className="flex flex-wrap gap-2">
          {canClose && (
            <button
              type="button"
              disabled={busy}
              className={buttonClass('secondary')}
              onClick={() => void close()}
            >
              بستن تیکت
            </button>
          )}
          {canReopen && (
            <button
              type="button"
              disabled={busy}
              className={buttonClass('quiet')}
              onClick={() => {
                setReopening(true);
              }}
            >
              مشکل حل نشده است
            </button>
          )}
        </div>
      )}
      {error ? <Notice tone="danger">{error}</Notice> : null}
    </div>
  );
}

/** A file, opened by a short-lived signed link (rule 28). */
export function TicketAttachmentButton({
  side,
  id,
  attachmentId,
  label,
}: {
  side: TicketSide;
  id: string;
  attachmentId: string;
  label: string;
}) {
  const api = useApi();
  const [error, setError] = useState<string | null>(null);
  const open = async () => {
    setError(null);
    const params = { path: { id, attachmentId } };
    try {
      const link =
        side === 'me'
          ? await unwrap(
              api.GET('/api/v1/me/tickets/{id}/attachments/{attachmentId}/link', { params }),
            )
          : side === 'panel'
            ? await unwrap(
                api.GET('/api/v1/panel/tickets/{id}/attachments/{attachmentId}/link', { params }),
              )
            : await unwrap(
                api.GET('/api/v1/tickets/{id}/attachments/{attachmentId}/link', { params }),
              );
      window.open(link.url, '_blank', 'noopener');
    } catch (err) {
      setError(errorMessage(err));
    }
  };
  return (
    <span className="inline-flex flex-wrap items-center gap-2">
      <button type="button" className={buttonClass('quiet')} onClick={() => void open()}>
        {label}
      </button>
      {error ? <span className="text-[length:var(--text-xs)] text-danger">{error}</span> : null}
    </span>
  );
}

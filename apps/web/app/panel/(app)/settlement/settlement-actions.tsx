'use client';

import { unwrap } from '@sepehr/api-client';
import { buttonClass, errorMessage, formText, Notice, TextField, useApi } from '@sepehr/ui';
import { useRouter } from 'next/navigation';
import { useState, type SubmitEvent } from 'react';

/**
 * A doctor's objection to one of their items (task 5-6; doc 06 §6): with a reason, it is
 * held out of every payment until accounting decides (task 5-2). From task 7-7 (the owner's
 * ruling) it opens a financial complaint on the item, which holds it through the same 5-2
 * dispute and gives it a conversation; an item already held is refused by the API.
 */
export function DisputeButton({
  subjectType,
  subjectId,
  topicCode,
}: {
  subjectType: 'doctor_payable' | 'service_fee';
  subjectId: string;
  /** The financial complaint's topic (`ticket.topics`, configured). */
  topicCode: string;
}) {
  const api = useApi();
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [opened, setOpened] = useState<string | null>(null);

  if (opened) {
    return (
      <a href={`/panel/tickets/${opened}`} className="text-accent underline">
        شکایت ثبت شد؛ پیگیری
      </a>
    );
  }
  if (!open) {
    return (
      <button
        type="button"
        className={buttonClass('quiet')}
        onClick={() => {
          setOpen(true);
        }}
      >
        اعتراض
      </button>
    );
  }
  const submit = (e: SubmitEvent<HTMLFormElement>) => {
    e.preventDefault();
    const reason = formText(e.currentTarget, 'reason');
    setBusy(true);
    setError(null);
    void unwrap(
      api.POST('/api/v1/panel/tickets', {
        body: {
          topicCode,
          subject: 'اعتراض به قلم تسویه',
          body: reason,
          links: [{ type: subjectType, id: subjectId }],
        },
      }),
    )
      .then((made) => {
        setOpen(false);
        setOpened(made.id);
        router.refresh();
      })
      .catch((err: unknown) => {
        setError(errorMessage(err));
      })
      .finally(() => {
        setBusy(false);
      });
  };
  return (
    <form onSubmit={submit} className="space-y-2" aria-label="ثبت اعتراض" noValidate>
      <TextField id={`reason-${subjectId}`} name="reason" label="دلیل اعتراض" required />
      {error ? <Notice tone="danger">{error}</Notice> : null}
      <div className="flex gap-2">
        <button type="submit" className={buttonClass('primary')} disabled={busy}>
          ثبت اعتراض
        </button>
        <button
          type="button"
          className={buttonClass('quiet')}
          onClick={() => {
            setOpen(false);
          }}
        >
          انصراف
        </button>
      </div>
    </form>
  );
}

/** The paid statement's PDF, by a short-lived signed link (rule 28). */
export function PdfButton({ id }: { id: string }) {
  const api = useApi();
  const [error, setError] = useState<string | null>(null);
  const open = () => {
    setError(null);
    void unwrap(
      api.GET('/api/v1/settlement/panel/statements/{id}/pdf', { params: { path: { id } } }),
    )
      .then((link) => {
        window.location.assign(link.url);
      })
      .catch((err: unknown) => {
        setError(errorMessage(err));
      });
  };
  return (
    <>
      <button type="button" className={buttonClass('quiet')} onClick={open}>
        دریافت PDF
      </button>
      {error ? <Notice tone="danger">{error}</Notice> : null}
    </>
  );
}

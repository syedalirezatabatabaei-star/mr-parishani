'use client';

import { unwrap } from '@sepehr/api-client';
import { CAMPAIGN_FILTERS, type CampaignFilterCode, type CampaignStatus } from '@sepehr/contracts';
import {
  buttonClass,
  CAMPAIGN_FILTER,
  errorMessage,
  formText,
  Notice,
  SelectField,
  TextField,
  useApi,
} from '@sepehr/ui';
import { useRouter } from 'next/navigation';
import { useState } from 'react';

/** A draft campaign: its named filter and parameters, and a template of the same recipient. */
export function NewCampaign({
  templates,
}: {
  templates: { code: string; audience: string; fields: string[]; label: string }[];
}) {
  const api = useApi();
  const router = useRouter();
  const [filter, setFilter] = useState<CampaignFilterCode>('borrowers_overdue_at_least');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // Only templates the API would take: the filter's recipient, and no field it lacks (6-5).
  const chosen = CAMPAIGN_FILTERS[filter];
  const allowed: readonly string[] = chosen.fields;
  const fitting = templates.filter(
    (t) => t.audience === chosen.audience && t.fields.every((f) => allowed.includes(f)),
  );
  return (
    <form
      className="space-y-3 rounded-md border border-border p-3"
      aria-label="کمپین تازه"
      noValidate
      onSubmit={(e) => {
        e.preventDefault();
        const form = e.currentTarget;
        const params: Record<string, unknown> = {};
        if (filter === 'borrowers_overdue_at_least' || filter === 'guarantors_overdue_at_least') {
          params['days'] = Number(formText(form, 'days'));
        }
        if (filter === 'patients_of_center') {
          params['workplaceIds'] = formText(form, 'workplaceIds')
            .split(/[\s,،]+/)
            .filter(Boolean);
        }
        setBusy(true);
        setError(null);
        void unwrap(
          api.POST('/api/v1/notification/campaigns', {
            body: {
              name: formText(form, 'name').trim(),
              filterCode: filter,
              filterParams: params,
              templateCode: formText(form, 'templateCode'),
            },
          }),
        )
          .then((made) => {
            router.push(`/sms/campaigns/${made.id}`);
          })
          .catch((err: unknown) => {
            setError(errorMessage(err));
          })
          .finally(() => {
            setBusy(false);
          });
      }}
    >
      <h2 className="font-bold">کمپین تازه</h2>
      <div className="grid gap-3 sm:grid-cols-2">
        <TextField id="c-name" name="name" label="نام کمپین" required />
        <SelectField
          id="c-filter"
          name="filterCode"
          label="فیلتر"
          defaultValue={filter}
          onChange={(v) => {
            setFilter(v as CampaignFilterCode);
          }}
          options={(Object.keys(CAMPAIGN_FILTER) as CampaignFilterCode[]).map((k) => ({
            value: k,
            label: CAMPAIGN_FILTER[k],
          }))}
        />
        {(filter === 'borrowers_overdue_at_least' || filter === 'guarantors_overdue_at_least') && (
          <TextField
            id="c-days"
            name="days"
            label="دست‌کم چند روز معوق"
            inputMode="numeric"
            dir="ltr"
            figures
            required
          />
        )}
        {filter === 'patients_of_center' && (
          <TextField
            id="c-workplaces"
            name="workplaceIds"
            label="شناسه محل‌های کار (با ویرگول)"
            dir="ltr"
            required
          />
        )}
        {fitting.length > 0 ? (
          <SelectField
            id="c-template"
            name="templateCode"
            label="قالب (خدماتی؛ تبلیغاتی خاموش است)"
            options={fitting.map((t) => ({ value: t.code, label: t.label }))}
          />
        ) : (
          <TextField
            id="c-template"
            name="templateCode"
            label="کد قالب (خدماتی)"
            dir="ltr"
            required
          />
        )}
      </div>
      <button type="submit" disabled={busy} className={buttonClass('primary')}>
        ساخت پیش‌نویس و پیش‌نمایش
      </button>
      {error && <Notice tone="danger">{error}</Notice>}
    </form>
  );
}

/** The second person's approval; the API decides who may, by the campaign's threshold. */
export function ApproveCampaign({ id }: { id: string }) {
  const api = useApi();
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  return (
    <div className="space-y-2">
      <button
        type="button"
        disabled={busy}
        className={buttonClass('primary')}
        onClick={() => {
          setBusy(true);
          setError(null);
          void unwrap(
            api.POST('/api/v1/notification/campaigns/{id}/approve', { params: { path: { id } } }),
          )
            .then(() => {
              router.refresh();
            })
            .catch((err: unknown) => {
              setError(errorMessage(err));
            })
            .finally(() => {
              setBusy(false);
            });
        }}
      >
        تأیید و شروع ارسال
      </button>
      {error && <Notice tone="danger">{error}</Notice>}
    </div>
  );
}

const MOVES: Readonly<
  Partial<Record<CampaignStatus, { path: 'pause' | 'resume' | 'stop' | 'cancel'; label: string }[]>>
> = {
  draft: [{ path: 'cancel', label: 'لغو پیش‌نویس' }],
  sending: [
    { path: 'pause', label: 'توقف موقت' },
    { path: 'stop', label: 'توقف کامل' },
  ],
  paused: [
    { path: 'resume', label: 'ادامه ارسال' },
    { path: 'stop', label: 'توقف کامل' },
  ],
};

/** Pause, resume, stop (what is left is cancelled) or cancel a draft, with a reason. */
export function CampaignControls({ id, status }: { id: string; status: CampaignStatus }) {
  const api = useApi();
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const moves = MOVES[status] ?? [];
  if (moves.length === 0) return null;
  return (
    <form
      className="flex flex-wrap items-end gap-2"
      noValidate
      onSubmit={(e) => {
        e.preventDefault();
      }}
      aria-label="کنترل ارسال"
    >
      <TextField id={`reason-${id}`} name="reason" label="دلیل" required />
      {moves.map((m) => (
        <button
          key={m.path}
          type="button"
          className={buttonClass(
            m.path === 'stop' || m.path === 'cancel' ? 'secondary' : 'primary',
          )}
          onClick={(e) => {
            const reason = formText(e.currentTarget.form as HTMLFormElement, 'reason').trim();
            setError(null);
            const path =
              `/api/v1/notification/campaigns/{id}/${m.path}` as '/api/v1/notification/campaigns/{id}/pause';
            void unwrap(api.POST(path, { params: { path: { id } }, body: { reason } }))
              .then(() => {
                router.refresh();
              })
              .catch((err: unknown) => {
                setError(errorMessage(err));
              });
          }}
        >
          {m.label}
        </button>
      ))}
      {error && <Notice tone="danger">{error}</Notice>}
    </form>
  );
}

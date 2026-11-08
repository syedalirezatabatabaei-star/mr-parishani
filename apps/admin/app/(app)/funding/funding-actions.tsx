'use client';

import { ApiError, unwrap } from '@sepehr/api-client';
import {
  buttonClass,
  errorMessage,
  formText,
  Notice,
  OWN_FUNDING_REQUEST,
  TextField,
  useApi,
} from '@sepehr/ui';
import { useRouter } from 'next/navigation';
import { useState } from 'react';

/** Funding's own reading of the maker-checker refusal (owner, task 4-7). */
const fundingError = (err: unknown) =>
  err instanceof ApiError && err.code === 'same_person' ? OWN_FUNDING_REQUEST : errorMessage(err);

function useAction() {
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
      setError(fundingError(err));
    } finally {
      setBusy(false);
    }
  };
  return { error, busy, run };
}

/** Case completion asks for the purse to be funded (doc 12 §5; task 4-5's API). */
export function RequestFunding({ applicationId }: { applicationId: string }) {
  const api = useApi();
  const { error, busy, run } = useAction();
  return (
    <div className="space-y-2">
      <button
        type="button"
        disabled={busy}
        className={buttonClass('primary')}
        onClick={() =>
          void run(() =>
            unwrap(
              api.POST('/api/v1/funding/requests', {
                body: { creditApplicationId: applicationId },
              }),
            ),
          )
        }
      >
        درخواست شارژ کیف اعتبار
      </button>
      {error && <Notice tone="danger">{error}</Notice>}
    </div>
  );
}

/**
 * Finance approves a funding request, or rejects it with a reason. Never one's own request
 * (doc 12 §9 test 2): it is said here, and the API refuses it anyway.
 */
export function DecideFunding({ id, mine }: { id: string; mine: boolean }) {
  const api = useApi();
  const { error, busy, run } = useAction();
  const [rejecting, setRejecting] = useState(false);
  if (mine) return <Notice tone="warning">{OWN_FUNDING_REQUEST}</Notice>;
  if (rejecting) {
    return (
      <form
        className="flex flex-wrap items-end gap-2"
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          const reason = formText(e.currentTarget, 'reason');
          void run(() =>
            unwrap(
              api.POST('/api/v1/funding/requests/{id}/reject', {
                params: { path: { id } },
                body: { reason },
              }),
            ),
          );
        }}
      >
        <TextField id={`funding-reason-${id}`} name="reason" label="دلیل رد" required />
        <button type="submit" disabled={busy} className={buttonClass('danger')}>
          رد درخواست
        </button>
        <button
          type="button"
          className={buttonClass('quiet')}
          onClick={() => {
            setRejecting(false);
          }}
        >
          انصراف
        </button>
        {error && <Notice tone="danger">{error}</Notice>}
      </form>
    );
  }
  return (
    <span className="flex flex-wrap gap-2">
      <button
        type="button"
        disabled={busy}
        className={buttonClass('primary')}
        onClick={() =>
          void run(() =>
            unwrap(api.POST('/api/v1/funding/requests/{id}/approve', { params: { path: { id } } })),
          )
        }
      >
        تأیید شارژ
      </button>
      <button
        type="button"
        disabled={busy}
        className={buttonClass('secondary')}
        onClick={() => {
          setRejecting(true);
        }}
      >
        رد با دلیل
      </button>
      {error && <Notice tone="danger">{error}</Notice>}
    </span>
  );
}

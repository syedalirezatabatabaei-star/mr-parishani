'use client';

import { unwrap } from '@sepehr/api-client';
import { buttonClass, errorMessage, Notice, useApi } from '@sepehr/ui';
import { useRouter } from 'next/navigation';
import { useState } from 'react';

type Decision = 'approve' | 'reject';

/**
 * Approving or refusing one pending mobile (task 9-3, method الف). Approving asks once more,
 * since it hands the patient's records to that number; refusing needs no second step.
 */
export function PendingMobileDecision({ id }: { id: string }) {
  const api = useApi();
  const router = useRouter();
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const decide = async (decision: Decision) => {
    setBusy(true);
    setError(null);
    try {
      const path = { params: { path: { id } } };
      if (decision === 'approve') {
        await unwrap(api.POST('/api/v1/person-mobiles/{id}/approve', path));
      } else {
        await unwrap(api.POST('/api/v1/person-mobiles/{id}/reject', path));
      }
      router.refresh();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
      setConfirming(false);
    }
  };

  return (
    <div className="space-y-2">
      {confirming ? (
        <p>
          با تأیید، صاحب آن شماره همه نوبت‌ها، پرونده‌ها و اقساط شما را می‌بیند. فقط اگر این شماره
          را می‌شناسید و خودتان خواسته‌اید تأیید کنید.
        </p>
      ) : null}
      <div className="flex flex-wrap gap-2">
        {confirming ? (
          <>
            <button
              type="button"
              disabled={busy}
              className={buttonClass('primary')}
              onClick={() => void decide('approve')}
            >
              بله، تأیید می‌کنم
            </button>
            <button
              type="button"
              disabled={busy}
              className={buttonClass('quiet')}
              onClick={() => {
                setConfirming(false);
              }}
            >
              انصراف
            </button>
          </>
        ) : (
          <>
            <button
              type="button"
              disabled={busy}
              className={buttonClass('danger')}
              onClick={() => void decide('reject')}
            >
              رد می‌کنم
            </button>
            <button
              type="button"
              disabled={busy}
              className={buttonClass('secondary')}
              onClick={() => {
                setConfirming(true);
              }}
            >
              تأیید
            </button>
          </>
        )}
      </div>
      {error ? <Notice tone="danger">{error}</Notice> : null}
    </div>
  );
}

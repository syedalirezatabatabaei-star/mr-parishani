'use client';

import { unwrap } from '@sepehr/api-client';
import type { MyCreditTransferView } from '@sepehr/contracts';
import { buttonClass, errorMessage, Notice, rial, showInstant, useApi } from '@sepehr/ui';
import { useRouter } from 'next/navigation';
import { useState } from 'react';

/**
 * The borrower's AuthorizedRecipient (task 4-8; doc 12 §7): who receives the service codes
 * of their purse now, up to what amount; the debt stays theirs. They revoke it at once here
 * (owner س۷); the codes already sent to the recipient are cancelled with it.
 */
export function RecipientSection({
  applicationId,
  transfers,
}: {
  applicationId: string;
  transfers: readonly MyCreditTransferView[];
}) {
  const api = useApi();
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const active = transfers.find((t) => t.status === 'approved' || t.status === 'revoke_requested');
  if (!active) return null;
  const revoke = async () => {
    setBusy(true);
    setError(null);
    try {
      await unwrap(
        api.POST('/api/v1/me/credit-transfers/{applicationId}/{id}/revoke', {
          params: { path: { applicationId, id: active.id } },
          body: {},
        }),
      );
      router.refresh();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <section
      className="space-y-3 rounded-lg border border-border bg-surface p-4"
      aria-labelledby="recipient-title"
    >
      <h2 id="recipient-title" className="text-[length:var(--text-lg)] font-bold">
        گیرنده مجاز خدمت
      </h2>
      <p>
        کد خدمت‌های این کیف به <strong>{active.recipientName ?? 'گیرنده مجاز'}</strong> فرستاده
        می‌شود، تا سقف <span className="figures">{rial(active.amountRial)}</span>
        {active.decidedAt && (
          <>
            {' '}
            (از <span className="figures">{showInstant(active.decidedAt)}</span>)
          </>
        )}
        . بازپرداخت اقساط همچنان بر عهده شماست.
      </p>
      <button
        type="button"
        disabled={busy}
        className={buttonClass('danger')}
        onClick={() => void revoke()}
      >
        ابطال گیرنده مجاز
      </button>
      {error && <Notice tone="danger">{error}</Notice>}
    </section>
  );
}

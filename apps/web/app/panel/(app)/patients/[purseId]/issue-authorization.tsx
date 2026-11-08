'use client';

import { unwrap } from '@sepehr/api-client';
import type { DoctorPurseLinesView } from '@sepehr/contracts';
import { buttonClass, errorMessage, faDigits, Notice, rial, toman, useApi } from '@sepehr/ui';
import { useRouter } from 'next/navigation';
import { useState } from 'react';

/**
 * Choosing the proforma lines of one session; their sum, exact in rials with tomans below
 * (ADR-035), is what the patient's code will confirm. A line another live authorization
 * holds cannot be chosen (owner, پ۷).
 */
export function IssueAuthorization({
  purseId,
  lines,
}: {
  purseId: string;
  lines: DoctorPurseLinesView['lines'];
}) {
  const api = useApi();
  const router = useRouter();
  const [chosen, setChosen] = useState<ReadonlySet<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const sum = lines
    .filter((l) => chosen.has(l.id))
    .reduce((total, l) => total + BigInt(l.amountRial), 0n);

  const toggle = (id: string) => {
    setChosen((now) => {
      const next = new Set(now);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const issue = async () => {
    setBusy(true);
    setError(null);
    try {
      const made = await unwrap(
        api.POST('/api/v1/service/authorizations', {
          body: { purseId, proformaLineIds: [...chosen] },
        }),
      );
      router.push(`/panel/authorizations/${made.id}`);
    } catch (err) {
      setError(errorMessage(err));
      setBusy(false);
    }
  };

  return (
    <form
      className="space-y-4"
      aria-label="ردیف‌های این جلسه"
      onSubmit={(e) => {
        e.preventDefault();
        void issue();
      }}
    >
      <fieldset className="space-y-2 rounded-lg border border-border bg-surface p-4">
        <legend className="px-1 font-bold">ردیف‌های پیش‌فاکتور</legend>
        {lines.map((l) => (
          <label key={l.id} className="flex flex-wrap items-center gap-3">
            <input
              type="checkbox"
              checked={chosen.has(l.id)}
              disabled={l.authorized || l.cashOnly}
              onChange={() => {
                toggle(l.id);
              }}
            />
            <span>
              {l.serviceName} × {faDigits(l.quantity)}
            </span>
            <span className="figures">{rial(l.amountRial)}</span>
            {l.authorized && <span className="text-ink-muted">(در مجوز دیگری)</span>}
            {l.cashOnly && (
              <span className="text-ink-muted">(هزینه مواد؛ بیمار نقد به شما می‌پردازد)</span>
            )}
          </label>
        ))}
      </fieldset>
      <p aria-live="polite">
        جمع این جلسه: <span className="figures font-bold">{rial(sum)}</span>
        <br />
        <span className="figures text-ink-muted">{toman(sum)}</span>
      </p>
      <button type="submit" disabled={busy || chosen.size === 0} className={buttonClass('primary')}>
        صدور و ارسال کد به بیمار
      </button>
      {error && <Notice tone="danger">{error}</Notice>}
    </form>
  );
}

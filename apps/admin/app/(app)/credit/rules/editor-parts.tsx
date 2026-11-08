'use client';

import { buttonClass } from '@sepehr/ui';
import { useId, useState, type KeyboardEvent, type ReactNode } from 'react';

/**
 * Tabs (WAI-ARIA tabs pattern). Every panel stays rendered and only the chosen one shows, so
 * what was typed in another tab is kept.
 */
export function Tabs({
  label,
  tabs,
}: {
  label: string;
  tabs: readonly { id: string; label: string; body: ReactNode }[];
}) {
  const [chosen, setChosen] = useState(tabs[0]?.id ?? '');
  const base = useId();
  const move = (e: KeyboardEvent<HTMLButtonElement>, i: number) => {
    // Right to left: the arrow that points to the next tab is the left one.
    const step = e.key === 'ArrowLeft' ? 1 : e.key === 'ArrowRight' ? -1 : 0;
    if (step === 0) return;
    e.preventDefault();
    const next = tabs[(i + step + tabs.length) % tabs.length];
    if (next) {
      setChosen(next.id);
      document.getElementById(`${base}-tab-${next.id}`)?.focus();
    }
  };
  return (
    <div className="space-y-3">
      <div role="tablist" aria-label={label} className="flex flex-wrap gap-2">
        {tabs.map((t, i) => (
          <button
            key={t.id}
            id={`${base}-tab-${t.id}`}
            type="button"
            role="tab"
            aria-selected={t.id === chosen}
            aria-controls={`${base}-panel-${t.id}`}
            tabIndex={t.id === chosen ? 0 : -1}
            className={buttonClass(t.id === chosen ? 'primary' : 'quiet')}
            onClick={() => {
              setChosen(t.id);
            }}
            onKeyDown={(e) => {
              move(e, i);
            }}
          >
            {t.label}
          </button>
        ))}
      </div>
      {tabs.map((t) => (
        <div
          key={t.id}
          id={`${base}-panel-${t.id}`}
          role="tabpanel"
          aria-labelledby={`${base}-tab-${t.id}`}
          hidden={t.id !== chosen}
          className="overflow-x-auto"
        >
          {t.body}
        </div>
      ))}
    </div>
  );
}

/** The stored value as it is, read only, for support. */
export function RawJson({ value }: { value: unknown }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="space-y-2">
      <button
        type="button"
        className={buttonClass('quiet')}
        aria-expanded={open}
        onClick={() => {
          setOpen(!open);
        }}
      >
        {open ? 'بستن JSON خام' : 'نمایش JSON خام (فقط خواندنی)'}
      </button>
      {open && (
        <pre
          dir="ltr"
          aria-label="JSON خام مقدار جاری"
          className="max-h-96 overflow-auto rounded-lg border border-border bg-surface p-3 text-[length:var(--text-xs)]"
        >
          {JSON.stringify(value, null, 2)}
        </pre>
      )}
    </div>
  );
}

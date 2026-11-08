'use client';

import { formatToman, parseRial } from '@sepehr/contracts';
import { useId, useState, type ChangeEvent } from 'react';
import { inputClass } from './controls.js';

/** Latin digits grouped by three with a comma, as typed money reads best in an input. */
function grouped(typed: string): string {
  const rial = parseRial(typed);
  return rial === null ? typed : rial.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

export interface MoneyFieldProps {
  readonly id: string;
  readonly name: string;
  /** What the amount is; «(ریال)» is added. */
  readonly label: string;
  /** Rials, as the API sends them. */
  readonly defaultValue?: string;
  readonly hint?: string;
  readonly required?: boolean;
  readonly className?: string;
  /** For client components that follow the amount; forms read the field as it is. */
  readonly onChange?: (rial: bigint | null) => void;
}

/**
 * Every amount of money is typed in rials (owner, 1405/07/11; rule 1), grouped by three
 * as it is typed, with the same amount in tomans under it (rule 2) so it reads at a
 * glance. The form reads the field with `parseRial`, which takes any digits and separators.
 */
export function MoneyField(props: MoneyFieldProps) {
  // nosemgrep: react-props-in-state -- the initial value of an uncontrolled field, by design
  const [text, setText] = useState(props.defaultValue ? grouped(props.defaultValue) : '');
  const tomanId = useId();
  const rial = parseRial(text);
  const change = (e: ChangeEvent<HTMLInputElement>) => {
    const next = grouped(e.target.value);
    setText(next);
    props.onChange?.(parseRial(next));
  };
  const hintId = props.hint ? `${props.id}-hint` : null;
  return (
    <div className={`space-y-1 ${props.className ?? ''}`}>
      <label htmlFor={props.id} className="block text-[length:var(--text-sm)] font-medium text-ink">
        {props.label} (ریال)
      </label>
      <input
        id={props.id}
        name={props.name}
        type="text"
        inputMode="numeric"
        autoComplete="off"
        dir="ltr"
        required={props.required}
        value={text}
        onChange={change}
        aria-describedby={[tomanId, hintId].filter(Boolean).join(' ')}
        className={`${inputClass} figures`}
      />
      <span
        id={tomanId}
        aria-live="polite"
        className="block text-[length:var(--text-xs)] text-ink-muted figures"
      >
        {rial === null ? (text ? 'عدد صحیح ریال وارد کنید.' : ' ') : `= ${formatToman(rial)}`}
      </span>
      {props.hint && (
        <span
          id={hintId ?? undefined}
          className="block text-[length:var(--text-xs)] text-ink-subtle"
        >
          {props.hint}
        </span>
      )}
    </div>
  );
}

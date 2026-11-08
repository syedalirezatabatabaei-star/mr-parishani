'use client';

import {
  formatJalaliDate,
  parseJalaliDate,
  parseJalaliRange,
  type JalaliDate,
} from '@sepehr/contracts';
import { useEffect, useId, useRef, useState } from 'react';
import { Calendar } from './calendar.js';
import type { DateRange, HolidayMark } from './model.js';

interface CommonProps {
  readonly label: string;
  readonly holidays?: readonly HolidayMark[];
  readonly min?: JalaliDate;
  readonly max?: JalaliDate;
  readonly today: JalaliDate;
  /** Help under the field; the default names the accepted forms. */
  readonly hint?: string;
}

export type DateFieldProps =
  | (CommonProps & {
      readonly mode: 'single';
      readonly value: JalaliDate | null;
      readonly onChange: (value: JalaliDate) => void;
    })
  | (CommonProps & {
      readonly mode: 'range';
      readonly value: DateRange | null;
      readonly onChange: (value: DateRange) => void;
    });

/** One date kept left to right inside right-to-left text (LRI … PDI). */
const isolated = (d: JalaliDate) => `\u2066${formatJalaliDate(d)}\u2069`;
const rangeText = (r: DateRange) => `${isolated(r.from)} تا ${isolated(r.to)}`;

const show = (props: DateFieldProps) => {
  if (!props.value) return '';
  if (props.mode === 'single') return formatJalaliDate(props.value);
  return rangeText(props.value);
};

const within = (d: JalaliDate, min?: JalaliDate, max?: JalaliDate) => {
  const key = (x: JalaliDate) => x.year * 10_000 + x.month * 100 + x.day;
  return (!min || key(d) >= key(min)) && (!max || key(d) <= key(max));
};

/**
 * A date typed by hand, in Persian, Arabic or English digits (doc 08 §13), with the
 * calendar a button away. A range is typed as «۱۴۰۵/۰۷/۰۱ تا ۱۴۰۵/۰۷/۱۰». What is not a real
 * date, or is outside [min, max], is said under the field and never passed on.
 */
export function DateField(props: DateFieldProps) {
  // nosemgrep: react-props-in-state -- the initial value of an uncontrolled field, by design
  const [text, setText] = useState(show(props));
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const inputId = useId();
  const hintId = useId();
  const errorId = useId();
  const popupId = useId();
  const rootRef = useRef<HTMLDivElement>(null);
  const toggleRef = useRef<HTMLButtonElement>(null);

  const close = (refocus: boolean) => {
    setOpen(false);
    if (refocus) toggleRef.current?.focus();
  };

  // A click or focus outside the field closes the calendar, as a popup should.
  useEffect(() => {
    if (!open) return;
    const outside = (e: Event) => {
      if (e.target instanceof Node && !rootRef.current?.contains(e.target)) setOpen(false);
    };
    document.addEventListener('pointerdown', outside);
    document.addEventListener('focusin', outside);
    return () => {
      document.removeEventListener('pointerdown', outside);
      document.removeEventListener('focusin', outside);
    };
  }, [open]);

  const commit = () => {
    if (text.trim() === '') {
      setError(null);
      return;
    }
    if (props.mode === 'single') {
      const date = parseJalaliDate(text);
      if (!date) {
        setError('تاریخ معتبر نیست؛ مثل ۱۴۰۵/۰۷/۰۸ بنویسید.');
        return;
      }
      if (!within(date, props.min, props.max)) {
        setError('این تاریخ در بازه مجاز نیست.');
        return;
      }
      setError(null);
      setText(formatJalaliDate(date));
      props.onChange(date);
      return;
    }
    const range = parseJalaliRange(text);
    if (!range) {
      setError('بازه معتبر نیست؛ مثل ۱۴۰۵/۰۷/۰۱ تا ۱۴۰۵/۰۷/۱۰ بنویسید.');
      return;
    }
    if (!within(range.from, props.min, props.max) || !within(range.to, props.min, props.max)) {
      setError('این بازه در محدوده مجاز نیست.');
      return;
    }
    setError(null);
    setText(rangeText(range));
    props.onChange(range);
  };

  const describedBy = [props.hint !== '' ? hintId : null, error ? errorId : null]
    .filter(Boolean)
    .join(' ');

  return (
    <div
      ref={rootRef}
      className="relative space-y-1"
      onKeyDown={(e) => {
        // Escape closes an open calendar from anywhere in the field (the calendar keeps its
        // own Escape while its month or year list is open).
        if (e.key === 'Escape' && open) {
          e.preventDefault();
          close(true);
        }
      }}
    >
      <label htmlFor={inputId} className="block text-[length:var(--text-sm)] font-medium text-ink">
        {props.label}
      </label>
      <div className="flex gap-2">
        <input
          id={inputId}
          value={text}
          onChange={(e) => {
            setText(e.target.value);
          }}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              commit();
            }
          }}
          inputMode="numeric"
          dir={props.mode === 'range' ? 'rtl' : 'ltr'}
          aria-invalid={error ? true : undefined}
          aria-describedby={describedBy || undefined}
          className={`figures block min-h-10 w-full rounded-md border bg-surface px-3 ${props.mode === 'range' ? 'text-start' : 'text-end'} text-ink ${error ? 'border-2 border-danger' : 'border-border-strong'}`}
        />
        <button
          ref={toggleRef}
          type="button"
          aria-expanded={open}
          aria-controls={popupId}
          onClick={() => {
            setOpen((o) => !o);
          }}
          className="min-h-10 shrink-0 rounded-md border border-border-strong bg-surface px-3 text-[length:var(--text-sm)] text-ink hover:bg-sunken"
        >
          تقویم
        </button>
      </div>
      {props.hint !== '' && (
        <p id={hintId} className="text-[length:var(--text-xs)] text-ink-subtle">
          {props.hint ??
            (props.mode === 'single'
              ? 'با ارقام فارسی، عربی یا انگلیسی: ۱۴۰۵/۰۷/۰۸'
              : 'با ارقام فارسی، عربی یا انگلیسی: ۱۴۰۵/۰۷/۰۱ تا ۱۴۰۵/۰۷/۱۰')}
        </p>
      )}
      {error && (
        <p id={errorId} role="alert" className="text-[length:var(--text-xs)] text-danger">
          {error}
        </p>
      )}
      {open && (
        // A fixed width so the calendar does not shrink to its content inside an absolute box,
        // anchored to the field's start edge (the right in RTL) and never wider than the screen.
        <div
          id={popupId}
          className="absolute start-0 top-full z-20 mt-1 w-[min(22rem,calc(100vw-2rem))]"
        >
          {props.mode === 'single' ? (
            <Calendar
              mode="single"
              label={props.label}
              value={props.value}
              today={props.today}
              holidays={props.holidays ?? []}
              {...(props.min ? { min: props.min } : {})}
              {...(props.max ? { max: props.max } : {})}
              onChange={(d) => {
                setText(formatJalaliDate(d));
                setError(null);
                close(true);
                props.onChange(d);
              }}
            />
          ) : (
            <Calendar
              mode="range"
              shortcuts
              label={props.label}
              value={props.value}
              today={props.today}
              holidays={props.holidays ?? []}
              {...(props.min ? { min: props.min } : {})}
              {...(props.max ? { max: props.max } : {})}
              onChange={(r) => {
                setText(rangeText(r));
                setError(null);
                close(true);
                props.onChange(r);
              }}
            />
          )}
        </div>
      )}
    </div>
  );
}

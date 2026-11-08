'use client';

import {
  addJalaliDays,
  addJalaliMonths,
  compareJalali,
  JALALI_MAX_YEAR,
  JALALI_MIN_YEAR,
  JALALI_MONTH_NAMES,
  jalaliMonthLength,
  normalizeDigits,
  type JalaliDate,
} from '@sepehr/contracts';
import { useId, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import {
  CAPACITY_NAMES,
  dayDescription,
  dayKey,
  fa,
  inRange,
  jalaliLabel,
  monthGrid,
  monthLabel,
  pickRange,
  sameDay,
  SHORTCUT_NAMES,
  shortcutRange,
  WEEKDAY_NAMES,
  WEEKDAY_SHORT,
  weekOf,
  type Capacity,
  type DateRange,
  type DayCell,
  type DaySlot,
  type HolidayMark,
  type PendingRange,
  type Shortcut,
} from './model.js';

export type CalendarView = 'month' | 'week' | 'day';

interface CommonProps {
  /** The accessible name of the calendar, e.g. «تاریخ نوبت». */
  readonly label: string;
  /** Holidays from the `holidays` table (the holidays API), shown in their own color. */
  readonly holidays?: readonly HolidayMark[];
  /** For booking: how full each day is, by its Gregorian day (YYYY-MM-DD). */
  readonly capacity?: Readonly<Record<string, Capacity>>;
  /** For booking: the times of each day, by its Gregorian day; picked with onPickTime. */
  readonly slots?: Readonly<Record<string, readonly DaySlot[]>>;
  readonly onPickTime?: (slot: DaySlot, day: JalaliDate) => void;
  /** Days outside [min, max] cannot be chosen. */
  readonly min?: JalaliDate;
  readonly max?: JalaliDate;
  /** The views offered (centers: all three; patients: month). */
  readonly views?: readonly CalendarView[];
  readonly defaultView?: CalendarView;
  /** Today in Tehran; given by the caller (tests, or a server-rendered page). */
  readonly today: JalaliDate;
}

export type CalendarProps =
  | (CommonProps & {
      readonly mode: 'single';
      readonly value: JalaliDate | null;
      readonly onChange: (value: JalaliDate) => void;
    })
  | (CommonProps & {
      readonly mode: 'range';
      readonly value: DateRange | null;
      readonly onChange: (value: DateRange) => void;
      /** Today, this week, this month, last month (doc 08 §13). */
      readonly shortcuts?: boolean;
    });

const VIEW_NAMES: Readonly<Record<CalendarView, string>> = {
  month: 'ماه',
  week: 'هفته',
  day: 'روز',
};

const CAPACITY_DOT: Readonly<Record<Capacity, string>> = {
  free: 'bg-success',
  limited: 'bg-warning',
  full: 'bg-danger',
};

/** The first year of the twelve-year page that holds `year`. */
const pageStart = (year: number) => year - ((((year - 1300) % 12) + 12) % 12);

const clamp = (d: JalaliDate, min?: JalaliDate, max?: JalaliDate) =>
  min && compareJalali(d, min) < 0 ? min : max && compareJalali(d, max) > 0 ? max : d;

/**
 * The one calendar and date picker of the system (task 2-10, doc 08 §13). Jalali only, as
 * every date shown in the system (ADR-011; owner decision 1405/07/08); holidays in their own color; one day or a
 * range, with shortcuts; the capacity of each day and its times for booking; month, week and
 * day views for centers. Every conversion goes through the Jalali wrapper of contracts.
 *
 * A grid in the ARIA sense: one day is tabbable at a time; arrows move by day and week
 * (right is earlier in a right-to-left page), PageUp and PageDown by month, Home and End to
 * the week's ends, Enter or Space choose.
 *
 * The header is that of an enterprise picker (owner, 1405/07/09): the month title opens the
 * twelve months, their title the years (a page of twelve, or filtered by the digits typed);
 * Escape goes back a level. Right-to-left as the owner reads it: the right arrow button (>)
 * goes back, the left one (<) forward, and so do the keyboard's arrow keys.
 */
export function Calendar(props: CalendarProps) {
  const { label, holidays = [], capacity = {}, slots = {}, min, max, today } = props;
  const views = props.views ?? ['month'];
  // nosemgrep: react-props-in-state -- the initial value of an uncontrolled field, by design
  const [view, setView] = useState<CalendarView>(props.defaultView ?? views[0] ?? 'month');
  const selectedDay = props.mode === 'single' ? props.value : (props.value?.from ?? null);
  const [focused, setFocused] = useState<JalaliDate>(clamp(selectedDay ?? today, min, max));
  // nosemgrep: react-props-in-state -- the initial value of an uncontrolled field, by design
  const [pending, setPending] = useState<PendingRange | null>(
    props.mode === 'range' && props.value ? props.value : null,
  );
  const grid = useRef<HTMLDivElement>(null);
  const root = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const yearFilterId = useId();
  /** What the header opened: the days, or the month list, or the years (enterprise picker). */
  const [level, setLevel] = useState<'days' | 'months' | 'years'>('days');
  const [yearPage, setYearPage] = useState(0);
  const [yearFilter, setYearFilter] = useState('');
  const minYear = min?.year ?? JALALI_MIN_YEAR;
  const maxYear = max?.year ?? JALALI_MAX_YEAR;

  /** Whether a whole month lies outside [min, max]. */
  const monthOff = (year: number, month: number) =>
    (min !== undefined &&
      compareJalali({ year, month, day: jalaliMonthLength(year, month) }, min) < 0) ||
    (max !== undefined && compareJalali({ year, month, day: 1 }, max) > 0);

  /** Changes level and puts the focus where the keyboard expects it on the new one. */
  const goLevel = (next: 'days' | 'months' | 'years') => {
    setLevel(next);
    requestAnimationFrame(() => {
      const target =
        next === 'years'
          ? root.current?.querySelector<HTMLElement>(`[id="${CSS.escape(yearFilterId)}"]`)
          : next === 'months'
            ? root.current?.querySelector<HTMLElement>('[data-month][aria-pressed="true"]')
            : grid.current?.querySelector<HTMLElement>('[data-focused="true"]');
      target?.focus();
    });
  };
  const openMonths = () => {
    goLevel('months');
  };
  const openYears = () => {
    setYearPage(pageStart(focused.year));
    setYearFilter('');
    goLevel('years');
  };
  const pickMonth = (month: number) => {
    if (monthOff(focused.year, month)) return;
    setFocused(clamp({ year: focused.year, month, day: 1 }, min, max));
    goLevel('days');
  };
  const pickYear = (year: number) => {
    if (year < minYear || year > maxYear) return;
    setFocused(clamp({ year, month: focused.month, day: 1 }, min, max));
    goLevel('months');
  };
  /** The years the filter matches («۱۳۷» → ۱۳۷۰…۱۳۷۹), or the current page of twelve. */
  const shownYears = (() => {
    const typed = normalizeDigits(yearFilter).replace(/\D/g, '');
    if (typed === '') {
      return Array.from({ length: 12 }, (_, i) => yearPage + i);
    }
    const all: number[] = [];
    for (let y = minYear; y <= maxYear && all.length < 24; y++) {
      if (String(y).startsWith(typed)) all.push(y);
    }
    return all;
  })();

  const holidayOf = useMemo(() => new Map(holidays.map((h) => [h.on, h.title])), [holidays]);
  const disabled = (d: JalaliDate) =>
    (min !== undefined && compareJalali(d, min) < 0) ||
    (max !== undefined && compareJalali(d, max) > 0) ||
    capacity[dayKey(d)] === 'full';

  const choose = (d: JalaliDate) => {
    if (disabled(d)) return;
    setFocused(d);
    if (props.mode === 'single') {
      props.onChange(d);
      return;
    }
    const next = pickRange(pending, d);
    setPending(next);
    if (next.to) props.onChange({ from: next.from, to: next.to });
  };

  const moveFocus = (d: JalaliDate) => {
    setFocused(clamp(d, min, max));
    // The new day's button takes the focus once it is drawn.
    requestAnimationFrame(() => {
      grid.current?.querySelector<HTMLButtonElement>('[data-focused="true"]')?.focus();
    });
  };

  const onKey = (e: KeyboardEvent) => {
    const step: Record<string, () => JalaliDate> = {
      ArrowRight: () => addJalaliDays(focused, -1),
      ArrowLeft: () => addJalaliDays(focused, 1),
      ArrowUp: () => addJalaliDays(focused, -7),
      ArrowDown: () => addJalaliDays(focused, 7),
      PageUp: () => addJalaliMonths(focused, -1),
      PageDown: () => addJalaliMonths(focused, 1),
      Home: () => weekOf(focused)[0]?.date ?? focused,
      End: () => weekOf(focused)[6]?.date ?? focused,
    };
    // An own key only: `constructor` or `toString` are not keys of the calendar (task 9-3).
    const go = Object.hasOwn(step, e.key) ? step[e.key] : undefined;
    if (go) {
      e.preventDefault();
      moveFocus(go());
    } else if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      choose(focused);
    }
  };

  const shift = (months: number, days: number) => {
    setFocused(
      clamp(
        months ? addJalaliMonths({ ...focused, day: 1 }, months) : addJalaliDays(focused, days),
        min,
        max,
      ),
    );
  };

  const range: PendingRange | null =
    props.mode === 'range' ? (pending ?? (props.value ? props.value : null)) : null;

  const dayButton = (c: DayCell, compact: boolean) => {
    const holiday = holidayOf.get(c.key);
    const cap = capacity[c.key];
    const selected =
      props.mode === 'single' ? sameDay(c.date, props.value) : inRange(c.date, range);
    const isFocused = sameDay(c.date, focused);
    const off = disabled(c.date);
    const weekend = c.weekday === 'friday';
    return (
      <button
        type="button"
        tabIndex={isFocused ? 0 : -1}
        data-focused={isFocused}
        data-day={c.key}
        data-holiday={holiday ? 'true' : undefined}
        aria-label={dayDescription(c, holiday, cap)}
        aria-pressed={selected}
        aria-disabled={off || undefined}
        aria-current={sameDay(c.date, today) ? 'date' : undefined}
        onClick={() => {
          choose(c.date);
        }}
        className={[
          'relative flex w-full flex-col items-center justify-center rounded-md transition-colors duration-[var(--duration-fast)]',
          compact ? 'min-h-11 py-1' : 'min-h-16 py-2',
          !c.inMonth && !compact ? 'opacity-45' : '',
          selected
            ? 'bg-accent text-on-accent'
            : holiday
              ? 'bg-holiday-soft text-holiday'
              : weekend
                ? 'text-holiday'
                : 'text-ink hover:bg-accent-soft',
          off ? 'cursor-not-allowed line-through opacity-50' : 'cursor-pointer',
          sameDay(c.date, today) && !selected ? 'ring-2 ring-inset ring-accent' : '',
        ].join(' ')}
      >
        <span className="figures text-[length:var(--text-md)] font-medium leading-none">
          {fa(c.date.day)}
        </span>
        {cap && (
          <span
            aria-hidden="true"
            className={`absolute bottom-1 size-1.5 rounded-full ${CAPACITY_DOT[cap]}`}
          />
        )}
      </button>
    );
  };

  const timesOf = (d: JalaliDate) => slots[dayKey(d)] ?? [];
  const timeButtons = (d: JalaliDate) => {
    const list = timesOf(d);
    if (list.length === 0) {
      return <p className="text-[length:var(--text-sm)] text-ink-subtle">زمان خالی ندارد.</p>;
    }
    return (
      <div role="group" aria-label={`زمان‌های ${jalaliLabel(d)}`} className="flex flex-wrap gap-2">
        {list.map((s) => (
          <button
            key={s.startsAt}
            type="button"
            disabled={!s.available}
            onClick={() => props.onPickTime?.(s, d)}
            className="figures min-h-10 rounded-md border border-accent px-3 text-[length:var(--text-sm)] text-accent transition-colors duration-[var(--duration-fast)] hover:bg-accent hover:text-on-accent disabled:cursor-not-allowed disabled:border-border disabled:text-ink-subtle disabled:hover:bg-transparent"
          >
            {fa(s.time)}
          </button>
        ))}
      </div>
    );
  };

  const unit =
    level === 'years'
      ? { prev: '۱۲ سال قبل', next: '۱۲ سال بعد' }
      : level === 'months'
        ? { prev: 'سال قبل', next: 'سال بعد' }
        : view === 'month'
          ? { prev: 'ماه قبل', next: 'ماه بعد' }
          : view === 'week'
            ? { prev: 'هفته قبل', next: 'هفته بعد' }
            : { prev: 'روز قبل', next: 'روز بعد' };

  const step = (dir: 1 | -1) => {
    if (level === 'years') {
      setYearFilter('');
      setYearPage((p) => Math.min(Math.max(p + 12 * dir, pageStart(minYear)), pageStart(maxYear)));
    } else if (level === 'months') {
      const year = Math.min(Math.max(focused.year + dir, minYear), maxYear);
      setFocused(clamp({ year, month: focused.month, day: 1 }, min, max));
    } else {
      shift(view === 'month' ? dir : 0, view === 'week' ? 7 * dir : dir);
    }
  };

  const headerTitle =
    level === 'years'
      ? shownYears.length > 0 && yearFilter.trim() !== ''
        ? `${fa(shownYears[0] ?? 0)}–${fa(shownYears.at(-1) ?? 0)}`
        : `${fa(yearPage)}–${fa(yearPage + 11)}`
      : level === 'months'
        ? fa(focused.year)
        : view === 'day'
          ? `${WEEKDAY_NAMES[weekOf(focused).find((c) => sameDay(c.date, focused))?.weekday ?? 'saturday']} ${jalaliLabel(focused)}`
          : monthLabel(focused.year, focused.month);

  // Right-to-left, as the owner reads it (1405/07/09): the right button goes back and points
  // right (>), the left one goes forward and points left (<); the keyboard's arrows move the
  // same way (see onKey). Drawn as SVG: a text chevron would be mirrored by the bidi algorithm.
  const arrow = (dir: 1 | -1) => (
    <button
      type="button"
      className="min-h-10 min-w-10 rounded-md text-[length:var(--text-lg)] text-ink hover:bg-sunken"
      aria-label={dir === 1 ? unit.next : unit.prev}
      onClick={() => {
        step(dir);
      }}
    >
      <svg
        aria-hidden="true"
        data-points={dir === 1 ? 'left' : 'right'}
        viewBox="0 0 24 24"
        className="mx-auto size-5"
        fill="none"
        stroke="currentColor"
        strokeWidth="2.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path d={dir === 1 ? 'M15 5l-7 7 7 7' : 'M9 5l7 7-7 7'} />
      </svg>
    </button>
  );

  const header = (
    <div className="flex items-center justify-between gap-2">
      {arrow(-1)}
      <h2 id={titleId} className="text-center" aria-live="polite">
        {level === 'years' ? (
          <span className="figures text-[length:var(--text-md)] font-bold text-ink">
            {headerTitle}
          </span>
        ) : (
          <button
            type="button"
            aria-expanded={false}
            aria-label={
              level === 'months' ? `انتخاب سال، ${headerTitle}` : `انتخاب ماه و سال، ${headerTitle}`
            }
            onClick={level === 'months' ? openYears : openMonths}
            className="figures inline-flex min-h-10 items-center gap-1 rounded-md px-3 text-[length:var(--text-md)] font-bold text-ink hover:bg-sunken"
          >
            {headerTitle}
            {/* The chevron is drawn by CSS so the heading reads only the month. */}
            <span
              aria-hidden="true"
              className="text-[length:var(--text-xs)] text-ink-subtle after:content-['▾']"
            />
          </button>
        )}
      </h2>
      {arrow(1)}
    </div>
  );

  const monthsPanel = (
    <div role="group" aria-label={`ماه‌های ${fa(focused.year)}`} className="grid grid-cols-3 gap-2">
      {JALALI_MONTH_NAMES.map((name, i) => {
        const month = i + 1;
        const current = focused.month === month;
        const off = monthOff(focused.year, month);
        return (
          <button
            key={name}
            type="button"
            data-month={month}
            aria-pressed={current}
            aria-disabled={off || undefined}
            aria-current={today.year === focused.year && today.month === month ? 'date' : undefined}
            onClick={() => {
              pickMonth(month);
            }}
            className={`min-h-12 rounded-md text-[length:var(--text-sm)] ${current ? 'bg-accent font-medium text-on-accent' : 'text-ink hover:bg-accent-soft'} ${off ? 'cursor-not-allowed opacity-40' : ''}`}
          >
            {name}
          </button>
        );
      })}
    </div>
  );

  const yearsPanel = (
    <div className="space-y-2">
      <label htmlFor={yearFilterId} className="sr-only">
        جست‌وجوی سال
      </label>
      <input
        id={yearFilterId}
        value={yearFilter}
        onChange={(e) => {
          setYearFilter(e.target.value);
        }}
        onKeyDown={(e) => {
          if (e.key !== 'Enter') return;
          e.preventDefault();
          const typed = Number(normalizeDigits(yearFilter).replace(/\D/g, ''));
          if (String(typed).length === 4) pickYear(typed);
        }}
        inputMode="numeric"
        placeholder="جست‌وجوی سال، مثلاً ۱۳۷۰"
        className="figures block min-h-10 w-full rounded-md border border-border-strong bg-surface px-3 text-ink placeholder:text-ink-subtle"
      />
      {shownYears.length === 0 ? (
        <p className="text-[length:var(--text-sm)] text-ink-subtle">
          سالی با این ارقام در بازه مجاز نیست.
        </p>
      ) : (
        <div role="group" aria-label="سال‌ها" className="grid grid-cols-4 gap-2">
          {shownYears.map((year) => {
            const off = year < minYear || year > maxYear;
            const current = focused.year === year;
            return (
              <button
                key={year}
                type="button"
                aria-pressed={current}
                aria-disabled={off || undefined}
                aria-current={today.year === year ? 'date' : undefined}
                onClick={() => {
                  pickYear(year);
                }}
                className={`figures min-h-11 rounded-md text-[length:var(--text-sm)] ${current ? 'bg-accent font-medium text-on-accent' : 'text-ink hover:bg-accent-soft'} ${off ? 'cursor-not-allowed opacity-40' : ''}`}
              >
                {fa(year)}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );

  return (
    <div
      ref={root}
      className="w-full max-w-md space-y-3 rounded-lg border border-border bg-surface p-3 text-ink shadow-sm"
      role="group"
      aria-label={label}
      onKeyDown={(e) => {
        // Escape closes the month or year list first.
        if (e.key === 'Escape' && level !== 'days') {
          e.stopPropagation();
          goLevel(level === 'years' ? 'months' : 'days');
        }
      }}
    >
      {views.length > 1 && (
        <div role="tablist" aria-label="نما" className="flex gap-1 rounded-md bg-sunken p-1">
          {views.map((v) => (
            <button
              key={v}
              type="button"
              role="tab"
              aria-selected={view === v}
              onClick={() => {
                setView(v);
              }}
              className={`min-h-9 flex-1 rounded-sm text-[length:var(--text-sm)] ${view === v ? 'bg-surface font-medium text-ink shadow-sm' : 'text-ink-muted'}`}
            >
              {VIEW_NAMES[v]}
            </button>
          ))}
        </div>
      )}
      {header}
      {level === 'days' && props.mode === 'range' && props.shortcuts && (
        <div className="flex flex-wrap gap-1" role="group" aria-label="میان‌بر">
          {(Object.keys(SHORTCUT_NAMES) as Shortcut[]).map((s) => (
            <button
              key={s}
              type="button"
              className="min-h-9 rounded-full bg-accent-soft px-3 text-[length:var(--text-xs)] font-medium text-on-accent-soft hover:bg-accent hover:text-on-accent"
              onClick={() => {
                const r = shortcutRange(s, today);
                setPending(r);
                setFocused(r.from);
                props.onChange(r);
              }}
            >
              {SHORTCUT_NAMES[s]}
            </button>
          ))}
        </div>
      )}

      {/* The month and year lists lie over the days, which keep their place (hidden and inert),
          so the picker keeps one size on every level. */}
      <div className="grid *:[grid-area:1/1]">
        <div
          className={level === 'days' ? 'space-y-3' : 'invisible space-y-3'}
          aria-hidden={level !== 'days' || undefined}
          inert={level !== 'days'}
        >
          {view === 'month' && (
            <div
              ref={grid}
              role="grid"
              aria-labelledby={titleId}
              onKeyDown={onKey}
              className="space-y-1"
            >
              <div role="row" className="grid grid-cols-7 gap-1">
                {WEEKDAY_SHORT.map((w, i) => (
                  <div
                    key={w}
                    role="columnheader"
                    aria-label={Object.values(WEEKDAY_NAMES)[i]}
                    className={`py-1 text-center text-[length:var(--text-xs)] font-medium ${i === 6 ? 'text-holiday' : 'text-ink-muted'}`}
                  >
                    {w}
                  </div>
                ))}
              </div>
              {monthGrid(focused.year, focused.month).map((week) => (
                <div role="row" key={week[0]?.key} className="grid grid-cols-7 gap-1">
                  {week.map((c) => (
                    <div role="gridcell" key={c.key}>
                      {dayButton(c, false)}
                    </div>
                  ))}
                </div>
              ))}
            </div>
          )}

          {view === 'week' && (
            <div ref={grid} role="grid" aria-labelledby={titleId} onKeyDown={onKey}>
              <div role="row" className="grid grid-cols-7 gap-1">
                {weekOf(focused).map((c) => (
                  <div role="gridcell" key={c.key} className="space-y-1">
                    <div
                      aria-hidden="true"
                      className="text-center text-[length:var(--text-xs)] text-ink-muted"
                    >
                      {WEEKDAY_SHORT[weekOf(focused).indexOf(c)]}
                    </div>
                    {dayButton(c, true)}
                    <ul
                      aria-label={`زمان‌های ${jalaliLabel(c.date)}`}
                      className="space-y-0.5 text-center"
                    >
                      {timesOf(c.date).map((s) => (
                        <li
                          key={s.startsAt}
                          className={`figures text-[length:var(--text-xs)] ${s.available ? 'text-ink' : 'text-ink-subtle line-through'}`}
                        >
                          {fa(s.time)}
                        </li>
                      ))}
                    </ul>
                  </div>
                ))}
              </div>
            </div>
          )}

          {view === 'day' && <div className="space-y-2">{timeButtons(focused)}</div>}
        </div>
        {level === 'months' && monthsPanel}
        {level === 'years' && yearsPanel}
      </div>

      {level === 'days' && view !== 'day' && props.onPickTime && selectedDay && (
        <div className="space-y-2 border-t border-border pt-3">
          <p className="text-[length:var(--text-sm)] font-medium text-ink">
            زمان‌های {jalaliLabel(selectedDay)}
          </p>
          {timeButtons(selectedDay)}
        </div>
      )}

      <div className="flex justify-start">
        <button
          type="button"
          onClick={() => {
            setFocused(clamp(today, min, max));
            goLevel('days');
          }}
          className="min-h-9 rounded-md px-2 text-[length:var(--text-xs)] font-medium text-accent hover:bg-accent-soft"
        >
          برو به امروز
        </button>
      </div>

      {level === 'days' && Object.keys(capacity).length > 0 && (
        <ul
          className="flex flex-wrap gap-3 text-[length:var(--text-xs)] text-ink-muted"
          aria-label="راهنمای ظرفیت"
        >
          {(Object.keys(CAPACITY_NAMES) as Capacity[]).map((c) => (
            <li key={c} className="flex items-center gap-1">
              <span aria-hidden="true" className={`size-2 rounded-full ${CAPACITY_DOT[c]}`} />
              {CAPACITY_NAMES[c]}
            </li>
          ))}
          <li className="flex items-center gap-1">
            <span aria-hidden="true" className="size-2 rounded-full bg-holiday" />
            تعطیل
          </li>
        </ul>
      )}
    </div>
  );
}

/** The days of a Jalali month, for callers that fetch capacity or holidays by range. */
export const monthBounds = (year: number, month: number): DateRange => ({
  from: { year, month, day: 1 },
  to: { year, month, day: jalaliMonthLength(year, month) },
});

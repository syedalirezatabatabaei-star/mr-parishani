// @vitest-environment jsdom
import { gregorianDayOf, jalaliDaysBetween, weekdayOf, type JalaliDate } from '@sepehr/contracts';
import { cleanup, render, screen, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import axe from 'axe-core';
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Calendar } from './calendar.js';
import { DateField } from './date-field.js';
import type { DateRange } from './model.js';

/**
 * Task 2-10 acceptance (doc 09): component tests for entering Persian and English digits,
 * choosing a range and showing holidays; and an automated accessibility check with no
 * serious finding. Plus what doc 08 §13 asks of the one calendar.
 */

afterEach(cleanup);

const TODAY: JalaliDate = { year: 1405, month: 7, day: 8 };
const d = (day: number): JalaliDate => ({ year: 1405, month: 7, day });
const key = (day: number) => gregorianDayOf(d(day));
/** The button of a day of the shown month, by its Jalali day number (Persian digits). */
const dayButton = (day: number) => {
  const button = document.querySelector<HTMLButtonElement>(`[data-day="${key(day)}"]`);
  if (!button) throw new Error(`no button for day ${String(day)}`);
  return button;
};

/** Serious or critical axe findings, by rule id (jsdom cannot compute colors: see tokens). */
async function seriousViolations(
  node: Element,
  mustPass = ['aria-allowed-attr', 'button-name', 'label', 'aria-required-children'],
) {
  const result = await axe.run(node);
  // Not an empty check: rules on roles, names and ARIA attributes did run and pass.
  expect(result.passes.map((p) => p.id)).toEqual(expect.arrayContaining(mustPass));
  return result.violations
    .filter((v) => v.impact === 'serious' || v.impact === 'critical')
    .map((v) => `${v.id}: ${v.nodes.map((n) => n.html).join(' | ')}`);
}

describe('DateField: typing a date (doc 08 §13)', () => {
  it.each([
    ['Persian digits', '۱۴۰۵/۰۷/۱۲'],
    ['English digits', '1405-7-12'],
    ['Arabic digits', '١٤٠٥/٠٧/١٢'],
  ])('%s give the same day', async (_name, typed) => {
    const onChange = vi.fn();
    render(
      <DateField mode="single" label="تاریخ" value={null} today={TODAY} onChange={onChange} />,
    );
    const input = screen.getByLabelText('تاریخ');
    await userEvent.type(input, `${typed}{Enter}`);
    expect(onChange).toHaveBeenCalledExactlyOnceWith(d(12));
    // Shown back in Persian digits.
    expect(input).toHaveProperty('value', '۱۴۰۵/۰۷/۱۲');
  });

  it('says what is wrong under the field and passes nothing on', async () => {
    const onChange = vi.fn();
    render(
      <DateField
        mode="single"
        label="تاریخ"
        value={null}
        today={TODAY}
        min={d(1)}
        onChange={onChange}
      />,
    );
    const input = screen.getByLabelText('تاریخ');
    await userEvent.type(input, '۱۴۰۵/۱۳/۰۱{Enter}');
    expect(screen.getByRole('alert').textContent).toContain('تاریخ معتبر نیست');
    expect(input.getAttribute('aria-invalid')).toBe('true');
    expect(input.getAttribute('aria-describedby')).toContain(screen.getByRole('alert').id);
    await userEvent.clear(input);
    await userEvent.type(input, '1405/06/30{Enter}');
    expect(screen.getByRole('alert').textContent).toContain('بازه مجاز نیست');
    expect(onChange).not.toHaveBeenCalled();
  });

  it('a range typed with «تا», in either order and any digits', async () => {
    const onChange = vi.fn();
    render(<DateField mode="range" label="بازه" value={null} today={TODAY} onChange={onChange} />);
    await userEvent.type(screen.getByLabelText('بازه'), '1405/07/10 تا ۱۴۰۵/۰۷/۰۱{Enter}');
    expect(onChange).toHaveBeenCalledExactlyOnceWith({ from: d(1), to: d(10) });
  });

  it('a range is shown right to left, each date isolated, and reads back the same', async () => {
    const onChange = vi.fn();
    render(<DateField mode="range" label="بازه" value={null} today={TODAY} onChange={onChange} />);
    const input = screen.getByLabelText('بازه');
    await userEvent.type(input, '1405/07/01 تا 1405/07/10{Enter}');
    // The bidi algorithm would reorder Persian digits and slashes around «تا» otherwise.
    expect(input.getAttribute('dir')).toBe('rtl');
    expect(input).toHaveProperty('value', '\u2066۱۴۰۵/۰۷/۰۱\u2069 تا \u2066۱۴۰۵/۰۷/۱۰\u2069');
    // Committing the shown text again (a blur, say) takes the same range, with no error.
    await userEvent.type(input, '{Enter}');
    expect(onChange).toHaveBeenLastCalledWith({ from: d(1), to: d(10) });
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('a single date stays left to right', () => {
    render(<DateField mode="single" label="تاریخ" value={d(8)} today={TODAY} onChange={vi.fn()} />);
    const input = screen.getByLabelText('تاریخ');
    expect(input.getAttribute('dir')).toBe('ltr');
    expect(input).toHaveProperty('value', '۱۴۰۵/۰۷/۰۸');
  });

  it('opens the calendar and takes a day from it', async () => {
    const onChange = vi.fn();
    render(
      <DateField mode="single" label="تاریخ" value={null} today={TODAY} onChange={onChange} />,
    );
    const toggle = screen.getByRole('button', { name: 'تقویم' });
    await userEvent.click(toggle);
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    await userEvent.click(dayButton(20));
    expect(onChange).toHaveBeenCalledExactlyOnceWith(d(20));
    expect(screen.getByLabelText('تاریخ')).toHaveProperty('value', '۱۴۰۵/۰۷/۲۰');
  });
});

describe('Calendar: choosing a range (doc 08 §13)', () => {
  it('first the start, then the end; the days between are marked', async () => {
    const onChange = vi.fn<(r: DateRange) => void>();
    render(<Calendar mode="range" label="بازه" value={null} today={TODAY} onChange={onChange} />);
    await userEvent.click(dayButton(3));
    expect(onChange).not.toHaveBeenCalled();
    await userEvent.click(dayButton(10));
    expect(onChange).toHaveBeenCalledExactlyOnceWith({ from: d(3), to: d(10) });
    for (const day of [3, 6, 10]) expect(dayButton(day).getAttribute('aria-pressed')).toBe('true');
    expect(dayButton(11).getAttribute('aria-pressed')).toBe('false');
  });

  it('an end before the start becomes the start', async () => {
    const onChange = vi.fn();
    render(<Calendar mode="range" label="بازه" value={null} today={TODAY} onChange={onChange} />);
    await userEvent.click(dayButton(15));
    await userEvent.click(dayButton(4));
    expect(onChange).toHaveBeenCalledExactlyOnceWith({ from: d(4), to: d(15) });
  });

  it.each([
    ['امروز', TODAY, TODAY],
    ['این ماه', d(1), d(30)],
    ['ماه گذشته', { year: 1405, month: 6, day: 1 }, { year: 1405, month: 6, day: 31 }],
  ])('the shortcut «%s»', async (name, from, to) => {
    const onChange = vi.fn();
    render(
      <Calendar
        mode="range"
        shortcuts
        label="بازه"
        value={null}
        today={TODAY}
        onChange={onChange}
      />,
    );
    await userEvent.click(screen.getByRole('button', { name }));
    expect(onChange).toHaveBeenCalledExactlyOnceWith({ from, to });
  });

  it('«این هفته» is Saturday to Friday', async () => {
    const onChange = vi.fn<(r: DateRange) => void>();
    render(
      <Calendar
        mode="range"
        shortcuts
        label="بازه"
        value={null}
        today={TODAY}
        onChange={onChange}
      />,
    );
    await userEvent.click(screen.getByRole('button', { name: 'این هفته' }));
    const range = onChange.mock.calls[0]?.[0];
    expect(range && weekdayOf(range.from)).toBe('saturday');
    expect(range && weekdayOf(range.to)).toBe('friday');
    expect(range && jalaliDaysBetween(range.from, range.to)).toBe(6);
    expect(range && jalaliDaysBetween(range.from, TODAY)).toBeLessThan(7);
  });
});

describe('Calendar: holidays, and Jalali only (doc 08 §13, ADR-011)', () => {
  it('a holiday from the holidays table has its own mark, and says so', () => {
    render(
      <Calendar
        mode="single"
        label="تاریخ"
        value={null}
        today={TODAY}
        holidays={[{ on: key(13), title: 'تعطیلی آزمون' }]}
        onChange={vi.fn()}
      />,
    );
    const holiday = dayButton(13);
    expect(holiday.dataset['holiday']).toBe('true');
    expect(holiday.getAttribute('aria-label')).toContain('تعطیل: تعطیلی آزمون');
    expect(holiday.className).toContain('bg-holiday-soft');
    expect(dayButton(14).dataset['holiday']).toBeUndefined();
  });

  it('shows only Jalali dates: no Gregorian or lunar day anywhere (ADR-011)', () => {
    const { container } = render(
      <Calendar
        mode="single"
        label="تاریخ"
        value={d(12)}
        today={TODAY}
        views={['month', 'week', 'day']}
        onChange={vi.fn()}
      />,
    );
    // 8 Mehr 1405 = 30 September 2026: only the Jalali date is named.
    expect(dayButton(8).getAttribute('aria-label')).toBe('چهارشنبه ۸ مهر ۱۴۰۵');
    expect(dayButton(8).textContent).toBe('۸');
    expect(dayButton(8).getAttribute('aria-current')).toBe('date');
    expect(screen.getByRole('heading', { level: 2 }).textContent).toBe('مهر ۱۴۰۵');
    // Nothing on screen or read aloud names a Gregorian or Hijri month, or a Gregorian year.
    const everything = [
      container.textContent,
      ...[...container.querySelectorAll('[aria-label]')].map((n) => n.getAttribute('aria-label')),
    ].join(' ');
    expect(everything).not.toMatch(
      /ژانویه|فوریه|مارس|آوریل|ژوئن|ژوئیه|اوت|سپتامبر|اکتبر|نوامبر|دسامبر|محرم|صفر|ربیع|جمادی|رجب|شعبان|رمضان|شوال|ذی‌القعده|ذی‌الحجه|۲۰۲[0-9]|202[0-9]|۱۴۴[0-9]/,
    );
    // No ASCII (Gregorian-looking) day numbers either: every digit shown is Persian.
    expect(container.textContent).not.toMatch(/[0-9]/);
  });
});

describe('Calendar: booking (capacity and times) and the views of a center', () => {
  const slots = {
    [key(12)]: [
      { startsAt: '2026-10-04T05:30:00Z', time: '09:00', available: true },
      { startsAt: '2026-10-04T06:00:00Z', time: '09:30', available: false },
    ],
  };

  it('a full day cannot be chosen; a free one shows its times, only the open ones pickable', async () => {
    const onChange = vi.fn();
    const onPickTime = vi.fn();
    const Booking = () => {
      const [value, setValue] = useStateValue();
      return (
        <Calendar
          mode="single"
          label="تاریخ نوبت"
          value={value}
          today={TODAY}
          capacity={{ [key(11)]: 'full', [key(12)]: 'limited' }}
          slots={slots}
          onPickTime={onPickTime}
          onChange={(v) => {
            onChange(v);
            setValue(v);
          }}
        />
      );
    };
    render(<Booking />);
    expect(dayButton(11).getAttribute('aria-disabled')).toBe('true');
    expect(dayButton(11).getAttribute('aria-label')).toContain('ظرفیت پر');
    await userEvent.click(dayButton(11));
    expect(onChange).not.toHaveBeenCalled();

    await userEvent.click(dayButton(12));
    expect(onChange).toHaveBeenCalledExactlyOnceWith(d(12));
    const times = screen.getByRole('group', { name: 'زمان‌های ۱۲ مهر ۱۴۰۵' });
    const open = within(times).getByRole('button', { name: '۰۹:۰۰' });
    expect(within(times).getByRole('button', { name: '۰۹:۳۰' })).toHaveProperty('disabled', true);
    await userEvent.click(open);
    expect(onPickTime).toHaveBeenCalledExactlyOnceWith(slots[key(12)]?.[0], d(12));
  });

  it('month, week and day views; the week lists each day’s times', async () => {
    render(
      <Calendar
        mode="single"
        label="تقویم مرکز"
        value={d(12)}
        today={TODAY}
        views={['month', 'week', 'day']}
        slots={slots}
        onChange={vi.fn()}
      />,
    );
    await userEvent.click(screen.getByRole('tab', { name: 'هفته' }));
    expect(screen.getByRole('tab', { name: 'هفته' }).getAttribute('aria-selected')).toBe('true');
    expect(document.querySelectorAll('[data-day]')).toHaveLength(7);
    expect(screen.getByRole('list', { name: 'زمان‌های ۱۲ مهر ۱۴۰۵' }).textContent).toContain(
      '۰۹:۰۰',
    );
    await userEvent.click(screen.getByRole('tab', { name: 'روز' }));
    // 12 Mehr 1405 = 4 October 2026, a Sunday.
    expect(screen.getByRole('heading', { level: 2 }).textContent).toBe('یکشنبه ۱۲ مهر ۱۴۰۵');
    expect(screen.getByRole('button', { name: '۰۹:۰۰' })).toBeDefined();
  });

  it('the keyboard moves by day as the arrow buttons do (right earlier, left later), week and month', async () => {
    render(<Calendar mode="single" label="تاریخ" value={null} today={TODAY} onChange={vi.fn()} />);
    dayButton(8).focus();
    await userEvent.keyboard('{ArrowLeft}');
    expect(dayButton(9).dataset['focused']).toBe('true');
    await userEvent.keyboard('{ArrowDown}');
    expect(dayButton(16).dataset['focused']).toBe('true');
    await userEvent.keyboard('{ArrowRight}{ArrowUp}');
    expect(dayButton(8).dataset['focused']).toBe('true');
    await userEvent.keyboard('{PageDown}');
    expect(screen.getByRole('heading', { level: 2 }).textContent).toBe('آبان ۱۴۰۵');
  });
});

describe('Calendar: the header, like an enterprise date picker (owner, 1405/07/09)', () => {
  const heading = () => screen.getByRole('heading', { level: 2 }).textContent;
  const single = () =>
    render(
      <Calendar
        mode="single"
        label="تاریخ"
        value={null}
        today={TODAY}
        holidays={[]}
        onChange={vi.fn()}
      />,
    );

  it('RTL: the right button (>) goes back, the left one (<) forward', async () => {
    single();
    const arrows = within(screen.getByRole('group', { name: 'تاریخ' }))
      .getAllByRole('button')
      .filter((b) => b.querySelector('svg[data-points]'));
    // In RTL the first button in the source is the rightmost one. The chevrons are drawn, not
    // typed: a typed › or ‹ is mirrored by the bidi algorithm in a right-to-left page.
    expect(
      arrows.map((b) => [
        b.getAttribute('aria-label'),
        b.querySelector('svg')?.getAttribute('data-points'),
      ]),
    ).toEqual([
      ['ماه قبل', 'right'],
      ['ماه بعد', 'left'],
    ]);
    await userEvent.click(screen.getByRole('button', { name: 'ماه بعد' }));
    expect(heading()).toBe('آبان ۱۴۰۵');
    await userEvent.click(screen.getByRole('button', { name: 'ماه قبل' }));
    await userEvent.click(screen.getByRole('button', { name: 'ماه قبل' }));
    expect(heading()).toBe('شهریور ۱۴۰۵');
  });

  it('the month title opens the twelve months; one is picked and the days come back', async () => {
    single();
    await userEvent.click(screen.getByRole('button', { name: 'انتخاب ماه و سال، مهر ۱۴۰۵' }));
    const months = screen.getByRole('group', { name: 'ماه‌های ۱۴۰۵' });
    expect(within(months).getAllByRole('button')).toHaveLength(12);
    expect(within(months).getByRole('button', { name: 'مهر' }).getAttribute('aria-pressed')).toBe(
      'true',
    );
    // On the month list the arrows move by year.
    await userEvent.click(screen.getByRole('button', { name: 'سال بعد' }));
    expect(screen.getByRole('group', { name: 'ماه‌های ۱۴۰۶' })).toBeDefined();
    await userEvent.click(screen.getByRole('button', { name: 'دی' }));
    expect(heading()).toBe('دی ۱۴۰۶');
    expect(screen.queryByRole('group', { name: /^ماه‌های/ })).toBeNull();
  });

  it('the years: a page of twelve, a filter in any digits, and a year picked', async () => {
    single();
    await userEvent.click(screen.getByRole('button', { name: 'انتخاب ماه و سال، مهر ۱۴۰۵' }));
    await userEvent.click(screen.getByRole('button', { name: 'انتخاب سال، ۱۴۰۵' }));
    const years = () =>
      within(screen.getByRole('group', { name: 'سال‌ها' }))
        .getAllByRole('button')
        .map((b) => b.textContent);
    expect(years()).toHaveLength(12);
    expect(years()).toContain('۱۴۰۵');

    const filter = screen.getByLabelText('جست‌وجوی سال');
    await userEvent.type(filter, '۱۳۷');
    expect(years()).toEqual([
      '۱۳۷۰',
      '۱۳۷۱',
      '۱۳۷۲',
      '۱۳۷۳',
      '۱۳۷۴',
      '۱۳۷۵',
      '۱۳۷۶',
      '۱۳۷۷',
      '۱۳۷۸',
      '۱۳۷۹',
    ]);
    await userEvent.clear(filter);
    await userEvent.type(filter, '137');
    expect(years()).toHaveLength(10);
    await userEvent.click(screen.getByRole('button', { name: '۱۳۷۴' }));
    // A year leads to its months, then a month to its days.
    await userEvent.click(
      within(screen.getByRole('group', { name: 'ماه‌های ۱۳۷۴' })).getByRole('button', {
        name: 'اسفند',
      }),
    );
    expect(heading()).toBe('اسفند ۱۳۷۴');
  });

  it('Enter on a full year in the filter picks it; Escape goes back one level', async () => {
    single();
    await userEvent.click(screen.getByRole('button', { name: 'انتخاب ماه و سال، مهر ۱۴۰۵' }));
    await userEvent.click(screen.getByRole('button', { name: 'انتخاب سال، ۱۴۰۵' }));
    await userEvent.type(screen.getByLabelText('جست‌وجوی سال'), '1360{Enter}');
    expect(screen.getByRole('group', { name: 'ماه‌های ۱۳۶۰' })).toBeDefined();
    await userEvent.keyboard('{Escape}');
    expect(heading()).toBe('مهر ۱۳۶۰');
  });

  it('years and months outside [min, max] cannot be picked', async () => {
    render(
      <Calendar
        mode="single"
        label="تاریخ"
        value={null}
        today={TODAY}
        holidays={[]}
        min={d(1)}
        max={{ year: 1405, month: 9, day: 30 }}
        onChange={vi.fn()}
      />,
    );
    await userEvent.click(screen.getByRole('button', { name: 'انتخاب ماه و سال، مهر ۱۴۰۵' }));
    const dey = screen.getByRole('button', { name: 'دی' });
    expect(dey.getAttribute('aria-disabled')).toBe('true');
    await userEvent.click(dey);
    expect(screen.getByRole('group', { name: 'ماه‌های ۱۴۰۵' })).toBeDefined();
    await userEvent.click(screen.getByRole('button', { name: 'انتخاب سال، ۱۴۰۵' }));
    // The page of twelve shows a year past max, but it cannot be picked; the filter leaves it out.
    const late = screen.getByRole('button', { name: '۱۴۰۶' });
    expect(late.getAttribute('aria-disabled')).toBe('true');
    await userEvent.click(late);
    expect(screen.getByRole('group', { name: 'سال‌ها' })).toBeDefined();
    await userEvent.type(screen.getByLabelText('جست‌وجوی سال'), '۱۴۰');
    expect(screen.queryByRole('button', { name: '۱۴۰۶' })).toBeNull();
  });

  it('the month and year lists have no serious accessibility finding', async () => {
    const { container } = single();
    await userEvent.click(screen.getByRole('button', { name: 'انتخاب ماه و سال، مهر ۱۴۰۵' }));
    // No grid and no field on the month list: the rules on those have nothing to check.
    expect(
      await seriousViolations(container, [
        'aria-allowed-attr',
        'button-name',
        'aria-valid-attr-value',
      ]),
    ).toEqual([]);
    await userEvent.click(screen.getByRole('button', { name: 'انتخاب سال، ۱۴۰۵' }));
    expect(
      await seriousViolations(container, ['aria-allowed-attr', 'button-name', 'label']),
    ).toEqual([]);
  });

  it('«برو به امروز» comes back to this month from anywhere', async () => {
    single();
    await userEvent.click(screen.getByRole('button', { name: 'انتخاب ماه و سال، مهر ۱۴۰۵' }));
    await userEvent.click(screen.getByRole('button', { name: 'سال قبل' }));
    await userEvent.click(screen.getByRole('button', { name: 'برو به امروز' }));
    expect(heading()).toBe('مهر ۱۴۰۵');
  });
});

describe('DateField: the calendar popup', () => {
  it('has a set width, and closes on Escape or a click outside, giving the focus back', async () => {
    render(
      <div>
        <DateField mode="single" label="تاریخ" value={null} today={TODAY} onChange={vi.fn()} />
        <button type="button">بیرون</button>
      </div>,
    );
    const toggle = screen.getByRole('button', { name: 'تقویم' });
    await userEvent.click(toggle);
    const popup = document.getElementById(toggle.getAttribute('aria-controls') ?? '');
    expect(popup?.className).toContain('w-[min(22rem,calc(100vw-2rem))]');
    expect(popup?.className).toContain('top-full');
    await userEvent.keyboard('{Escape}');
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(document.activeElement).toBe(toggle);

    await userEvent.click(toggle);
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    await userEvent.click(screen.getByRole('button', { name: 'بیرون' }));
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
  });

  it('Escape on the month list goes back to the days, not out of the popup', async () => {
    render(<DateField mode="single" label="تاریخ" value={null} today={TODAY} onChange={vi.fn()} />);
    const toggle = screen.getByRole('button', { name: 'تقویم' });
    await userEvent.click(toggle);
    await userEvent.click(screen.getByRole('button', { name: 'انتخاب ماه و سال، مهر ۱۴۰۵' }));
    await userEvent.keyboard('{Escape}');
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    expect(screen.queryByRole('group', { name: 'ماه‌های ۱۴۰۵' })).toBeNull();
  });
});

describe('accessibility (axe-core, WCAG 2.2 AA rules)', () => {
  it('the calendar with holidays, capacity and times, and the date field, have no serious finding', async () => {
    const { container } = render(
      <div>
        <Calendar
          mode="single"
          label="تاریخ نوبت"
          value={d(12)}
          today={TODAY}
          views={['month', 'week', 'day']}
          holidays={[{ on: key(13), title: 'تعطیلی آزمون' }]}
          capacity={{ [key(11)]: 'full', [key(12)]: 'free' }}
          slots={{ [key(12)]: [{ startsAt: 'x', time: '09:00', available: true }] }}
          onPickTime={vi.fn()}
          onChange={vi.fn()}
        />
        <Calendar
          mode="range"
          shortcuts
          label="بازه گزارش"
          value={null}
          today={TODAY}
          onChange={vi.fn()}
        />
        <DateField mode="single" label="تاریخ تولد" value={null} today={TODAY} onChange={vi.fn()} />
      </div>,
    );
    expect(await seriousViolations(container)).toEqual([]);
  });
});

/** A tiny controlled value for the booking test. */
function useStateValue() {
  return useState<JalaliDate | null>(null);
}

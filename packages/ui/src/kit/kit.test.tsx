// @vitest-environment jsdom
import { cleanup, render, screen, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import axe from 'axe-core';
import { afterEach, describe, expect, it } from 'vitest';
import { SelectField, StatusBadge, TextField } from './controls.js';
import { DateFilter } from './date-filter.js';
import {
  jalaliOfDay,
  jalaliParam,
  parseJalaliParam,
  showDay,
  showInstant,
  rial,
  showTime,
  toman,
} from './format.js';
import { DataTable, FilterBar, Pagination, withParams } from './lists.js';
import { BottomBar, ShellMenu } from './menu.js';
import { AppShell } from './shell.js';

afterEach(cleanup);

describe('format: only Jalali, only Persian digits (ADR-011)', () => {
  it('an API civil day becomes its Jalali day', () => {
    expect(jalaliOfDay('2026-09-30')).toEqual({ year: 1405, month: 7, day: 8 });
    expect(showDay('2026-09-30')).toBe('۱۴۰۵/۰۷/۰۸');
    expect(showDay('2026-09-30', 'long')).toBe('۸ مهر ۱۴۰۵');
    expect(showDay('not a day')).toBe('');
  });

  it('an instant is shown at its Tehran day and time', () => {
    // 20:45 UTC on 30 September is 00:15 on 1 October in Tehran (UTC+3:30): 9 Mehr.
    expect(showInstant('2026-09-30T20:45:00Z')).toBe('۱۴۰۵/۰۷/۰۹ ۰۰:۱۵');
    expect(showTime('2026-09-30T05:30:00Z')).toBe('۰۹:۰۰');
  });

  it('rials are shown as tomans with Persian digits and separators', () => {
    expect(toman(12_500_000n)).toBe('۱٬۲۵۰٬۰۰۰ تومان');
    expect(toman('90')).toBe('۹ تومان');
  });

  it('exact rials keep the last digit a toman would drop (task 4-4)', () => {
    expect(rial(1_234_567n)).toBe('۱٬۲۳۴٬۵۶۷ ریال');
    expect(rial('6')).toBe('۶ ریال');
  });

  it('a filter date travels as an ASCII Jalali day and comes back', () => {
    expect(jalaliParam({ year: 1405, month: 7, day: 8 })).toBe('1405-07-08');
    expect(parseJalaliParam('1405-07-08')).toEqual({ year: 1405, month: 7, day: 8 });
    expect(parseJalaliParam('۱۴۰۵-۰۷-۰۸')).toEqual({ year: 1405, month: 7, day: 8 });
    expect(parseJalaliParam('1405-13-01')).toBeNull();
    expect(parseJalaliParam(undefined)).toBeNull();
    expect(parseJalaliParam(['1405-07-08'])).toBeNull();
  });
});

describe('withParams', () => {
  it('changes, removes and keeps query keys', () => {
    const current = { q: 'علی', page: '3', field: ['a', 'b'], empty: '' };
    expect(withParams('/search', current, { page: 4 })).toBe(
      '/search?q=%D8%B9%D9%84%DB%8C&field=a&field=b&page=4',
    );
    expect(withParams('/search', current, { page: null, q: null, field: null })).toBe('/search');
  });
});

describe('lists', () => {
  const rows = [
    { id: '1', name: 'دکتر الف', count: 3 },
    { id: '2', name: 'دکتر ب', count: 12 },
  ];

  it('a table with a caption, header cells and numeric columns at the end', () => {
    render(
      <DataTable
        caption="پزشکان"
        rows={rows}
        rowKey={(r) => r.id}
        empty={<p>خالی</p>}
        columns={[
          { key: 'name', header: 'نام', cell: (r) => r.name },
          { key: 'count', header: 'تعداد', cell: (r) => r.count, numeric: true },
        ]}
      />,
    );
    const table = screen.getByRole('table', { name: 'پزشکان' });
    expect(
      within(table)
        .getAllByRole('columnheader')
        .map((h) => h.textContent),
    ).toEqual(['نام', 'تعداد']);
    expect(within(table).getAllByRole('row')).toHaveLength(3);
  });

  it('an empty list shows its empty state, not an empty table', () => {
    render(
      <DataTable
        caption="پزشکان"
        rows={[]}
        rowKey={() => ''}
        empty={<p>پزشکی پیدا نشد</p>}
        columns={[]}
      />,
    );
    expect(screen.queryByRole('table')).toBeNull();
    expect(screen.getByText('پزشکی پیدا نشد')).toBeDefined();
  });

  it('pagination keeps the filter, says the count in Persian and has no dead links', () => {
    render(
      <Pagination page={1} pageSize={20} total={45} hrefFor={(p) => `/x?q=a&page=${String(p)}`} />,
    );
    const nav = screen.getByRole('navigation', { name: 'صفحه‌ها' });
    expect(nav.textContent).toContain('صفحه ۱ از ۳ (۴۵ مورد)');
    expect(within(nav).getByRole('link', { name: 'صفحه بعد' }).getAttribute('href')).toBe(
      '/x?q=a&page=2',
    );
    expect(within(nav).queryByRole('link', { name: 'صفحه قبل' })).toBeNull();
  });

  it('one page needs no pagination', () => {
    const { container } = render(
      <Pagination page={1} pageSize={20} total={5} hrefFor={() => ''} />,
    );
    expect(container.innerHTML).toBe('');
  });
});

describe('the filter is a GET form: the URL is its one source', () => {
  it('submitting puts the fields and the Jalali dates in the query', async () => {
    let submitted = '';
    render(
      <FilterBar action="/panel/appointments" resetHref="/panel/appointments">
        <TextField id="q" name="q" label="جست‌وجو" defaultValue="" />
        <SelectField
          id="status"
          name="status"
          label="وضعیت"
          emptyLabel="همه"
          options={[{ value: 'pending', label: 'در انتظار' }]}
          defaultValue="pending"
        />
        <DateFilter
          mode="range"
          label="بازه"
          names={{ from: 'from', to: 'to' }}
          today={{ year: 1405, month: 7, day: 8 }}
          defaultValue={null}
        />
      </FilterBar>,
    );
    const form = screen.getByRole('search');
    if (!(form instanceof HTMLFormElement)) throw new Error('the filter is not a form');
    expect(form.getAttribute('method')).toBe('get');
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      const pairs: [string, string][] = [];
      new FormData(form).forEach((v, k) => {
        if (typeof v === 'string') pairs.push([k, v]);
      });
      submitted = new URLSearchParams(pairs).toString();
    });
    await userEvent.type(screen.getByLabelText('جست‌وجو'), 'علی');
    await userEvent.type(screen.getByLabelText('بازه'), '۱۴۰۵/۰۷/۰۱ تا ۱۴۰۵/۰۷/۱۰{Enter}');
    await userEvent.click(screen.getByRole('button', { name: 'اعمال فیلتر' }));
    expect(new URLSearchParams(submitted).get('q')).toBe('علی');
    expect(new URLSearchParams(submitted).get('status')).toBe('pending');
    expect(new URLSearchParams(submitted).get('from')).toBe('1405-07-01');
    expect(new URLSearchParams(submitted).get('to')).toBe('1405-07-10');
    expect(screen.getByRole('link', { name: 'پاک کردن' }).getAttribute('href')).toBe(
      '/panel/appointments',
    );
  });
});

describe('accessibility of the kit (axe-core)', () => {
  it('a page in the shell with a filter, a table and a badge has no serious finding', async () => {
    const { container } = render(
      <AppShell
        tone="panel"
        brand={<a href="/">سپهر سلامتی</a>}
        menu={
          <ShellMenu
            label="بخش‌های پنل"
            home={{ href: '/panel', label: 'پیشخوان' }}
            currentPath="/panel/appointments"
            groups={[
              {
                label: 'کار روزانه',
                items: [
                  {
                    href: '/panel/appointments',
                    label: 'نوبت‌ها',
                    glyph: 'calendar',
                    color: 'teal',
                    group: 'کار روزانه',
                  },
                ],
              },
            ]}
            about="سپهر سلامتی"
            version="0.5.0"
            theme="light"
          />
        }
        notices={{ href: '/panel#pending', count: 2 }}
        bottomBar={
          <BottomBar home={{ href: '/panel', label: 'خانه' }} items={[]} currentPath="/panel" />
        }
      >
        <h1>نوبت‌ها</h1>
        <FilterBar action="/x">
          <TextField id="q" name="q" label="جست‌وجو" hint="نام یا موبایل" />
        </FilterBar>
        <DataTable
          caption="نوبت‌ها"
          rows={[{ id: '1' }]}
          rowKey={(r) => r.id}
          empty={null}
          columns={[
            {
              key: 's',
              header: 'وضعیت',
              cell: () => <StatusBadge tone="warning">در انتظار تأیید</StatusBadge>,
            },
          ]}
        />
      </AppShell>,
    );
    const result = await axe.run(container);
    expect(result.passes.map((p) => p.id)).toEqual(
      expect.arrayContaining(['label', 'landmark-unique', 'th-has-data-cells']),
    );
    expect(
      result.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical'),
    ).toEqual([]);
  });
});

// @vitest-environment jsdom
import { cleanup, render, screen, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import axe from 'axe-core';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { ServiceDesk } from './desk.js';
import { currentHref, groupItems, searchItems, type DeskItem } from './desk-model.js';
import { GLYPH_NAMES } from './glyphs.js';
import { ShellMenu } from './menu.js';

afterEach(cleanup);

// jsdom draws no top layer: a modal dialog is only opened and closed.
beforeAll(() => {
  Object.assign(HTMLDialogElement.prototype, {
    showModal(this: HTMLDialogElement) {
      this.open = true;
    },
    close(this: HTMLDialogElement) {
      this.open = false;
    },
  });
});

const item = (over: Partial<DeskItem> & Pick<DeskItem, 'href' | 'label'>): DeskItem => ({
  glyph: 'calendar',
  color: 'teal',
  group: 'نوبت و پزشک',
  ...over,
});

const ITEMS = [
  item({ href: '/me/appointments', label: 'نوبت‌های من', count: 2 }),
  item({ href: '/search', label: 'پیدا کردن پزشک', glyph: 'stethoscope' }),
  item({
    href: '/me/credit',
    label: 'اعتبار من',
    glyph: 'shield',
    color: 'indigo',
    group: 'اعتبار و پرداخت',
    description: 'پرونده‌های اعتباری و مدارک',
  }),
  item({
    href: '/me/guarantees',
    label: 'ضمانت‌های من',
    glyph: 'guarantee',
    color: 'indigo',
    group: 'اعتبار و پرداخت',
    isNew: true,
  }),
];

describe('the desk model', () => {
  it('groups in the order first seen', () => {
    expect(groupItems(ITEMS).map((g) => [g.label, g.items.length])).toEqual([
      ['نوبت و پزشک', 2],
      ['اعتبار و پرداخت', 2],
    ]);
  });

  it('finds a service with Arabic ی and ک, and by its description', () => {
    expect(searchItems(ITEMS, 'نوبت هاي').map((i) => i.href)).toEqual(['/me/appointments']);
    expect(searchItems(ITEMS, 'ضمانت').map((i) => i.href)).toEqual(['/me/guarantees']);
    expect(searchItems(ITEMS, 'مدارك').map((i) => i.href)).toEqual(['/me/credit']);
    expect(searchItems(ITEMS, '  ')).toEqual([]);
  });

  it('marks the longest match as the page, home only on itself', () => {
    const hrefs = ['/', '/credit', '/credit/rules'];
    expect(currentHref(hrefs, '/credit/rules', '/')).toBe('/credit/rules');
    expect(currentHref(hrefs, '/credit/1', '/')).toBe('/credit');
    expect(currentHref(hrefs, '/', '/')).toBe('/');
    expect(currentHref(hrefs, '/reports', '/')).toBeUndefined();
  });

  it('has a glyph for every name, all distinct', () => {
    expect(new Set(GLYPH_NAMES).size).toBe(GLYPH_NAMES.length);
    expect(GLYPH_NAMES.length).toBeGreaterThan(40);
  });
});

describe('the service desk', () => {
  it('shows each service with its count and «جدید», then «همه خدمات»', () => {
    render(<ServiceDesk title="پیشخوان" items={ITEMS} slides={[]} shortcuts={[]} />);
    const services = screen.getByRole('region', { name: 'خدمات' });
    expect(
      within(services).getByRole('link', { name: 'نوبت‌های من، ۲ مورد در انتظار' }),
    ).toBeTruthy();
    expect(within(services).getByRole('link', { name: 'ضمانت‌های من، جدید' })).toBeTruthy();
    expect(within(services).getAllByRole('listitem').at(-1)?.textContent).toContain('همه خدمات');
    // What waits is listed beside, and the bell leads there.
    const pending = screen.getByRole('region', { name: 'در انتظار شما' });
    expect(pending.id).toBe('pending');
    expect(within(pending).getByRole('link').textContent).toContain('نوبت‌های من');
  });

  it('has no serious accessibility finding', async () => {
    const { container } = render(
      <ServiceDesk
        title="پیشخوان"
        items={ITEMS}
        slides={[{ title: 'باشگاه', text: 'طرح‌های ویژه اعضا' }]}
        shortcuts={ITEMS.slice(0, 2)}
      />,
    );
    const result = await axe.run(container);
    expect(
      result.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical'),
    ).toEqual([]);
  });
});

describe('the menu', () => {
  const menu = (
    <ShellMenu
      label="بخش‌های حساب من"
      home={{ href: '/me', label: 'پیشخوان' }}
      currentPath="/me/credit/123"
      groups={groupItems(ITEMS)}
      user={{ title: 'بیمار', subtitle: 'موبایل …۱۲۳۴' }}
      about="سپهر سلامتی"
      version="0.5.0"
      theme="light"
    />
  );

  it('opens from ☰ with the groups, the page marked, and closes', async () => {
    const user = userEvent.setup();
    render(menu);
    await user.click(screen.getByRole('button', { name: 'منو' }));
    const nav = screen.getByRole('navigation', { name: 'بخش‌های حساب من' });
    expect(within(nav).getByRole('region', { name: 'اعتبار و پرداخت' })).toBeTruthy();
    expect(within(nav).getByRole('link', { name: 'اعتبار من' }).getAttribute('aria-current')).toBe(
      'page',
    );
    expect(screen.getByText('بیمار')).toBeTruthy();
    expect(screen.getByText('نسخه ۰.۵.۰')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'بستن منو' }));
    expect(screen.queryByRole('navigation', { name: 'بخش‌های حساب من' })).toBeNull();
  });

  it('searches the services and switches to dark on the shell', async () => {
    const user = userEvent.setup();
    render(<div data-shell="">{menu}</div>);
    await user.click(screen.getByRole('button', { name: 'منو' }));
    await user.type(screen.getByRole('searchbox', { name: 'جستجوی خدمات' }), 'ضمانت');
    const found = screen.getByRole('region', { name: 'نتیجه جستجو' });
    expect(
      within(found)
        .getAllByRole('link')
        .map((a) => a.getAttribute('href')),
    ).toEqual(['/me/guarantees']);
    const dark = screen.getByRole('switch', { name: 'حالت تیره' });
    await user.click(dark);
    expect(dark.getAttribute('aria-checked')).toBe('true');
    expect(document.querySelector('[data-shell]')?.getAttribute('data-theme')).toBe('dark');
    expect(document.cookie).toContain('sepehr-theme=dark');
  });
});

// @vitest-environment jsdom
import { cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { BarChart, millionTomans } from './charts.js';

afterEach(cleanup);

const axisLabels = () =>
  [...document.querySelectorAll('svg text')].map((t) => t.textContent).filter(Boolean);

describe('BarChart (task 7-5)', () => {
  it('has its data table, one row per category; a legend only for two series', () => {
    render(
      <BarChart
        title="آزمون"
        categoryHeader="ماه"
        categories={['الف', 'ب', 'پ']}
        series={[
          { label: 'یک', values: [1, 2, 3] },
          { label: 'دو', values: [3, 2, 1] },
        ]}
        format={(n) => String(n)}
      />,
    );
    const table = screen.getByRole('table', { name: 'آزمون' });
    expect(within(table).getAllByRole('row')).toHaveLength(4);
    expect(screen.getAllByRole('listitem').map((l) => l.textContent)).toEqual(['یک', 'دو']);
    expect(screen.getByRole('img', { name: 'آزمون؛ جدول داده در زیر' })).toBeDefined();
    // One tooltip per bar.
    expect(document.querySelectorAll('svg path title')).toHaveLength(6);
  });

  it('counts step by whole numbers, never a repeated label; one series has no legend', () => {
    render(
      <BarChart
        title="تیکت"
        categoryHeader="روز"
        categories={['۱', '۲']}
        series={[{ label: 'تیکت', values: [1, 0] }]}
        format={(n) => String(n)}
        integer
      />,
    );
    const ticks = axisLabels().filter((t) => /^\d+$/.test(t));
    expect(new Set(ticks).size).toBe(ticks.length);
    expect(screen.queryAllByRole('listitem')).toHaveLength(0);
  });

  it('says there is no data instead of an empty axis; the table stays', () => {
    render(
      <BarChart
        title="خالی"
        categoryHeader="ماه"
        categories={['الف']}
        series={[{ label: 'یک', values: [0] }]}
        format={(n) => String(n)}
      />,
    );
    expect(screen.getByText('در این بازه داده‌ای نیست.')).toBeDefined();
    expect(document.querySelector('svg')).toBeNull();
    expect(screen.getByRole('table', { name: 'خالی' })).toBeDefined();
  });

  it('labels many categories sparsely; every one stays in the table', () => {
    const days = Array.from({ length: 14 }, (_, i) => `روز${String(i)}`);
    render(
      <BarChart
        title="روزها"
        categoryHeader="روز"
        categories={days}
        series={[{ label: 'تیکت', values: days.map(() => 1) }]}
        format={(n) => String(n)}
        integer
      />,
    );
    expect(axisLabels().filter((t) => t.startsWith('روز')).length).toBeLessThanOrEqual(8);
    expect(within(screen.getByRole('table', { name: 'روزها' })).getAllByRole('row')).toHaveLength(
      15,
    );
  });
});

describe('millionTomans', () => {
  it('rials as millions of tomans, Persian digits', () => {
    expect(millionTomans(25_000_000)).toBe('۲٫۵ میلیون تومان');
    expect(millionTomans(50_000_000)).toBe('۵ میلیون تومان');
  });
});

// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import axe from 'axe-core';
import { afterEach, describe, expect, it } from 'vitest';
import { MoneyField } from './money-field.js';

afterEach(cleanup);

describe('MoneyField (owner, 1405/07/11)', () => {
  it('takes rials grouped by three and shows the same amount in tomans, exactly', async () => {
    render(
      <form aria-label="فرم">
        <MoneyField id="amount" name="amount" label="مبلغ" />
      </form>,
    );
    const input = screen.getByLabelText('مبلغ (ریال)');
    await userEvent.type(input, '۲۴۶۹۱۴');
    expect(input).toHaveProperty('value', '246,914');
    expect(screen.getByText('= ۲۴٬۶۹۱ تومان و ۴ ریال')).toBeTruthy();
    const form = new FormData(input.closest('form') ?? undefined);
    expect(form.get('amount')).toBe('246,914');
  });

  it('starts from the rials it is given, and says when the text is no amount', async () => {
    render(<MoneyField id="m" name="m" label="مبلغ" defaultValue="6000000" />);
    const input = screen.getByLabelText('مبلغ (ریال)');
    expect(input).toHaveProperty('value', '6,000,000');
    expect(screen.getByText('= ۶۰۰٬۰۰۰ تومان')).toBeTruthy();
    await userEvent.type(input, '.5');
    expect(screen.getByText('عدد صحیح ریال وارد کنید.')).toBeTruthy();
  });

  it('has no accessibility violation', async () => {
    const { container } = render(<MoneyField id="a" name="a" label="مبلغ" hint="راهنما" />);
    const result = await axe.run(container);
    expect(result.violations).toEqual([]);
  });
});

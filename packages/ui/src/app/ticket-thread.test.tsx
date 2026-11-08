// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { TicketDeadline, TicketThread } from './ticket-thread.js';

afterEach(cleanup);

const at = '2026-10-08T08:30:00.000Z';
const message = (
  id: string,
  side: 'requester' | 'staff' | 'respondent',
  body: string,
  extra: { visibility?: 'public' | 'internal'; containsTreatment?: boolean } = {},
) => ({ id, side, body, createdAt: at, ...extra });

describe('TicketThread (task 7-7)', () => {
  it('names each side, staff’s never «شما» (they are many), and labels an internal note', () => {
    render(
      <TicketThread
        reader="staff"
        links={[
          { type: 'doctor_payable', id: '00000000-0000-7000-8000-000000000001', label: 'ویزیت' },
        ]}
        attachments={[]}
        messages={[
          message('m1', 'requester', 'سلام'),
          message('m2', 'staff', 'پاسخ عمومی', { visibility: 'public' }),
          message('m3', 'staff', 'یادداشت کارشناس', { visibility: 'internal' }),
          message('m4', 'respondent', 'پاسخ پزشک به بیمار'),
        ]}
      />,
    );
    const items = screen.getAllByRole('listitem').map((l) => l.textContent);
    expect(items[0]).toContain('قلم تسویه: ویزیت');
    expect(items[1]).toContain('ثبت‌کننده');
    expect(items[2]).toContain('کارشناس');
    expect(items[2]).not.toContain('شما');
    expect(items[3]).toContain('یادداشت داخلی');
    expect(items[4]).toContain('پاسخ پزشک');
    // Persian digits in the time (rule 21's display).
    expect(items[1]).toMatch(/[۰-۹]{4}\/[۰-۹]{2}\/[۰-۹]{2}/);
  });

  it('labels nothing internal in the requester’s view, which has no visibility at all', () => {
    render(
      <TicketThread
        reader="requester"
        links={[]}
        attachments={[]}
        messages={[message('m1', 'requester', 'سلام'), message('m2', 'staff', 'پاسخ')]}
      />,
    );
    expect(screen.queryByText('یادداشت داخلی')).toBeNull();
    expect(screen.getAllByRole('listitem')[0]?.textContent).toContain('شما');
    expect(screen.queryByText('حاوی اطلاعات درمان')).toBeNull();
  });

  it('shows a message’s digits in Persian, as they are stored Latin (rule 23)', () => {
    render(
      <TicketThread
        reader="requester"
        links={[]}
        attachments={[]}
        messages={[message('m1', 'staff', 'هر روز از 8 تا 16.')]}
      />,
    );
    expect(screen.getByText('هر روز از ۸ تا ۱۶.')).toBeDefined();
  });
});

describe('TicketDeadline (task 7-7)', () => {
  const now = new Date('2026-10-08T12:00:00.000Z');
  it('says past, stopped, or none, never by color alone', () => {
    const { rerender } = render(<TicketDeadline dueAt={at} paused={false} now={now} />);
    expect(screen.getByText(/گذشته از مهلت/)).toBeDefined();
    rerender(<TicketDeadline dueAt={at} paused now={now} />);
    expect(screen.getByText('متوقف تا پاسخ ثبت‌کننده')).toBeDefined();
    rerender(<TicketDeadline dueAt={null} paused={false} now={now} />);
    expect(screen.getByText('بی مهلت')).toBeDefined();
    rerender(<TicketDeadline dueAt="2026-10-09T12:00:00.000Z" paused={false} now={now} />);
    expect(screen.queryByText(/گذشته از مهلت/)).toBeNull();
  });
});

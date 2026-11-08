import type { ModuleRef } from '@nestjs/core';
import { describe, expect, it } from 'vitest';
import type { SqlExecutor } from '../../common/audit/audit.port';
import { ACCOUNT_DIRECTORY } from '../../common/auth/account-directory.port';
import { BOOKING_PATIENTS } from '../../common/booking/booking-patients.port';
import { WORKPLACE_DIRECTORY } from '../../common/catalog/workplace-directory.port';
import type { EventConsumerRegistry } from '../../common/events/outbox.port';
import { LEAD_CASES } from '../../common/lead/lead-cases.port';
import type { InboxNotice, InboxPort } from '../../common/notification/inbox.port';
import { TICKET_REQUESTERS } from '../../common/ticket/ticket-requesters.port';
import { InboxConsumer } from './inbox.consumer';

const tx = {} as SqlExecutor;
const UUID = (n: number) => `00000000-0000-7000-8000-${String(n).padStart(12, '0')}`;

/** The bell's consumer with every port faked: who is told what, for each event. */
function world() {
  const told: { to: string[] | string; notice: InboxNotice }[] = [];
  const inbox: InboxPort = {
    notifyAccounts: (ids, notice) => {
      told.push({ to: [...ids], notice });
      return Promise.resolve();
    },
    notifyHolders: (permission, notice) => {
      told.push({ to: permission, notice });
      return Promise.resolve();
    },
  };
  const ports = new Map<unknown, unknown>([
    [
      LEAD_CASES,
      {
        caseFacts: () => Promise.resolve({ caseId: UUID(1), personId: UUID(2) }),
        samePersonIds: () => Promise.resolve([UUID(2)]),
        mobileOf: () => Promise.resolve('9120000000'),
      },
    ],
    [ACCOUNT_DIRECTORY, { patientAccountsOf: () => Promise.resolve([UUID(10)]) }],
    [BOOKING_PATIENTS, { patientAccountOf: () => Promise.resolve(UUID(11)) }],
    [WORKPLACE_DIRECTORY, { workplace: () => Promise.resolve({ doctorAccountId: UUID(12) }) }],
    [
      TICKET_REQUESTERS,
      {
        partiesOf: () =>
          Promise.resolve({
            requesterAccountId: UUID(13),
            channel: 'patient',
            assigneeAccountId: null,
          }),
      },
    ],
  ]);
  const moduleRef = { get: (token: unknown) => ports.get(token) } as unknown as ModuleRef;
  const registry: EventConsumerRegistry = { register: () => undefined };
  const consumer = new InboxConsumer(inbox, registry, moduleRef);
  const send = (type: string, payload: Record<string, unknown>) =>
    consumer.handle(
      {
        id: UUID(99),
        type,
        aggregateType: 'x',
        aggregateId: 'x',
        payload,
        occurredAt: new Date().toISOString(),
      },
      tx,
    );
  return { told, send };
}

describe('the bell’s notifications from the domain events (owner 1405/08/10)', () => {
  it('tells the patient of the case, with a link and never an amount', async () => {
    const { told, send } = world();
    await send('installment.overdue', {
      installmentId: UUID(3),
      scheduleId: UUID(4),
      caseId: UUID(1),
      dueOn: '2026-10-01',
      daysPastDue: 3,
      outstandingRial: '25000000',
    });
    expect(told).toEqual([
      {
        to: [UUID(10)],
        notice: expect.objectContaining({
          kind: 'installment',
          linkHref: '/me/repayment',
          dedupeKey: `installment.overdue:${UUID(99)}`,
        }) as unknown,
      },
    ]);
    expect(JSON.stringify(told)).not.toContain('25000000');
  });

  it('tells the patient of an appointment, the doctor of a request, the holders of an approval', async () => {
    const { told, send } = world();
    const appointment = {
      appointmentId: UUID(5),
      workplaceId: UUID(6),
      doctorId: UUID(7),
      caseId: null,
    };
    await send('booking.appointment_confirmed', appointment);
    await send('booking.appointment_requested', appointment);
    await send('wallet.funding_requested', {
      fundingRequestId: UUID(8),
      creditApplicationId: UUID(9),
    });
    expect(told.map((t) => t.to)).toEqual([[UUID(11)], [UUID(12)], 'wallet.approve_funding']);
  });

  it('says nothing of a cancellation by the patient themself, nor of other repayment records', async () => {
    const { told, send } = world();
    await send('booking.appointment_cancelled', {
      appointmentId: UUID(5),
      workplaceId: UUID(6),
      doctorId: UUID(7),
      caseId: null,
      by: 'patient',
    });
    await send('repayment.recorded', {
      scheduleId: UUID(4),
      caseId: UUID(1),
      kind: 'receipt_registered',
      paymentId: null,
      amountRial: '1000',
    });
    expect(told).toEqual([]);
  });

  it('tells a ticket’s requester its answer on their own site', async () => {
    const { told, send } = world();
    await send('ticket.resolved', { ticketId: UUID(20), unit: 'support', status: 'resolved' });
    expect(told[0]?.to).toEqual([UUID(13)]);
    expect(told[0]?.notice.linkHref).toBe(`/me/tickets/${UUID(20)}`);
  });
});

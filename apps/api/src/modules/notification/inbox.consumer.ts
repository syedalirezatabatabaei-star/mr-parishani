import { Inject, Injectable, type OnModuleInit } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import type { EventEnvelope, PermissionCode } from '@sepehr/contracts';
import type { SqlExecutor } from '../../common/audit/audit.port';
import { ACCOUNT_DIRECTORY, type AccountDirectory } from '../../common/auth/account-directory.port';
import { BOOKING_PATIENTS, type BookingPatients } from '../../common/booking/booking-patients.port';
import {
  WORKPLACE_DIRECTORY,
  type WorkplaceDirectory,
} from '../../common/catalog/workplace-directory.port';
import {
  EVENT_CONSUMERS,
  type EventConsumer,
  type EventConsumerRegistry,
} from '../../common/events/outbox.port';
import { LEAD_CASES, type LeadCases } from '../../common/lead/lead-cases.port';
import { INBOX, type InboxNotice, type InboxPort } from '../../common/notification/inbox.port';
import {
  TICKET_REQUESTERS,
  type TicketRequesters,
} from '../../common/ticket/ticket-requesters.port';

type Payload = Record<string, unknown>;
type Notice = Omit<InboxNotice, 'dedupeKey'>;

/** What each event tells the patient of its case: a generic line and the page; never an amount. */
const PATIENT: Readonly<Record<string, Notice | ((p: Payload) => Notice | null)>> = {
  'booking.appointment_confirmed': {
    kind: 'appointment',
    title: 'نوبت شما تأیید شد',
    body: 'جزئیات و کد پذیرش در «نوبت‌های من» است.',
    linkHref: '/me/appointments',
  },
  'booking.appointment_rejected': {
    kind: 'appointment',
    title: 'درخواست نوبت پذیرفته نشد',
    body: 'می‌توانید زمان دیگری انتخاب کنید.',
    linkHref: '/me/appointments',
  },
  'booking.appointment_cancelled': (p) =>
    p['by'] === 'center'
      ? {
          kind: 'appointment',
          title: 'نوبت شما از سوی مرکز لغو شد',
          body: 'برای زمان جایگزین به «نوبت‌های من» سر بزنید.',
          linkHref: '/me/appointments',
        }
      : null,
  'proforma.issued': {
    kind: 'proforma',
    title: 'پیش‌فاکتور تازه',
    body: 'پزشک برای شما پیش‌فاکتور صادر کرد؛ آن را ببینید و پاسخ دهید.',
    linkHref: '/me/proformas',
  },
  'credit.decided': {
    kind: 'credit',
    title: 'نتیجه بررسی پرونده اعتباری',
    body: 'نتیجه بررسی پرونده شما آماده است.',
    linkHref: '/me/credit',
  },
  'credit.document_rejected': {
    kind: 'credit',
    title: 'مدرکی اصلاح لازم دارد',
    body: 'یکی از مدارک پرونده اعتباری شما پذیرفته نشد؛ آن را دوباره بفرستید.',
    linkHref: '/me/credit',
  },
  'wallet.funded': {
    kind: 'credit',
    title: 'کیف اعتبار شما شارژ شد',
    body: 'اکنون می‌توانید خدمت را نزد پزشک دریافت کنید.',
    linkHref: '/me/credit',
  },
  'installment.due': {
    kind: 'installment',
    title: 'قسط نزدیک است',
    body: 'سررسید یکی از اقساط شما نزدیک است.',
    linkHref: '/me/repayment',
  },
  'installment.overdue': {
    kind: 'installment',
    title: 'قسط سررسید گذشته',
    body: 'یکی از اقساط شما از سررسید گذشته است؛ لطفاً پرداخت کنید.',
    linkHref: '/me/repayment',
  },
  'repayment.recorded': (p) =>
    p['kind'] === 'payment_approved'
      ? {
          kind: 'payment',
          title: 'پرداخت شما تأیید شد',
          body: 'فیش پرداخت شما بررسی و تأیید شد.',
          linkHref: '/me/repayment',
        }
      : p['kind'] === 'payment_rejected'
        ? {
            kind: 'payment',
            title: 'فیش پرداخت پذیرفته نشد',
            body: 'فیش پرداخت شما تأیید نشد؛ جزئیات در «اقساط من» است.',
            linkHref: '/me/repayment',
          }
        : null,
};

/** What waits on a second person: told to everyone who may decide it. */
const APPROVERS: Readonly<Record<string, { permission: PermissionCode; notice: Notice }>> = {
  'wallet.funding_requested': {
    permission: 'wallet.approve_funding',
    notice: {
      kind: 'approval',
      title: 'شارژ منتظر تأیید',
      body: 'یک درخواست شارژ کیف اعتبار تأیید شما را می‌خواهد.',
      linkHref: '/funding',
    },
  },
  'wallet.special_operation_requested': {
    permission: 'wallet.approve_special_operation',
    notice: {
      kind: 'approval',
      title: 'عملیات ویژه منتظر تأیید',
      body: 'یک عملیات ویژه تأیید نفر دوم را می‌خواهد.',
      linkHref: '/special-operations',
    },
  },
  'contract.refund_payment_requested': {
    permission: 'contract.approve_refund_payment',
    notice: {
      kind: 'approval',
      title: 'پرداخت استرداد منتظر تأیید',
      body: 'یک پرداخت استرداد تأیید نفر دوم را می‌خواهد.',
      linkHref: '/special-operations',
    },
  },
  'credit.penalty_override_requested': {
    permission: 'credit.approve_penalty_override',
    notice: {
      kind: 'approval',
      title: 'تغییر خسارت منتظر تأیید',
      body: 'درخواست تغییر خسارت یک پرونده تأیید شما را می‌خواهد.',
      linkHref: '/special-operations',
    },
  },
};

/** What a doctor hears of their own workplace. */
const DOCTOR: Readonly<Record<string, Notice>> = {
  'booking.appointment_requested': {
    kind: 'appointment',
    title: 'درخواست نوبت تازه',
    body: 'یک درخواست نوبت منتظر پاسخ است.',
    linkHref: '/panel/appointments',
  },
  'proforma.confirmed': {
    kind: 'proforma',
    title: 'پیش‌فاکتور تأیید شد',
    body: 'بیمار پیش‌فاکتور شما را تأیید کرد.',
    linkHref: '/panel/proformas',
  },
  'proforma.disputed': {
    kind: 'proforma',
    title: 'اعتراض به پیش‌فاکتور',
    body: 'بیمار به پیش‌فاکتور شما اعتراض کرد.',
    linkHref: '/panel/proformas',
  },
};

const TICKET_TYPES = ['ticket.assigned', 'ticket.resolved'] as const;

/**
 * The bell's system notifications (owner 1405/08/10): from the domain events that exist, each
 * told only to the accounts it is about — the patient of the case or the appointment, the
 * doctor of the workplace, the ticket's requester or assignee, the holders of the permission
 * that decides an approval. The recipients come from the owning modules' ports (no other
 * module's table is read); texts are generic, with a link; each event notifies an account once.
 */
@Injectable()
export class InboxConsumer implements EventConsumer, OnModuleInit {
  readonly name = 'notification.inbox';
  readonly eventTypes = [
    ...Object.keys(PATIENT),
    ...Object.keys(APPROVERS),
    ...Object.keys(DOCTOR),
    ...TICKET_TYPES,
  ];

  constructor(
    @Inject(INBOX) private readonly inbox: InboxPort,
    @Inject(EVENT_CONSUMERS) private readonly consumers: EventConsumerRegistry,
    // Other modules' ports, resolved wherever they are provided, when first used.
    private readonly moduleRef: ModuleRef,
  ) {}

  private get leads(): LeadCases {
    return this.moduleRef.get<LeadCases>(LEAD_CASES, { strict: false });
  }

  private get accounts(): AccountDirectory {
    return this.moduleRef.get<AccountDirectory>(ACCOUNT_DIRECTORY, { strict: false });
  }

  private get bookings(): BookingPatients {
    return this.moduleRef.get<BookingPatients>(BOOKING_PATIENTS, { strict: false });
  }

  private get workplaces(): WorkplaceDirectory {
    return this.moduleRef.get<WorkplaceDirectory>(WORKPLACE_DIRECTORY, { strict: false });
  }

  private get tickets(): TicketRequesters {
    return this.moduleRef.get<TicketRequesters>(TICKET_REQUESTERS, { strict: false });
  }

  onModuleInit(): void {
    this.consumers.register(this);
  }

  /** The patient accounts of a case: its person, any person merged with it, and their mobile. */
  private async patientsOfCase(caseId: string, tx: SqlExecutor): Promise<string[]> {
    const leads = this.leads;
    const facts = await leads.caseFacts(caseId, tx);
    if (!facts) return [];
    const persons = await leads.samePersonIds(facts.personId, tx);
    const mobile = await leads.mobileOf(facts.personId, tx);
    return (await this.accounts.patientAccountsOf?.(persons, mobile ? [mobile] : [])) ?? [];
  }

  async handle(event: EventEnvelope, tx: SqlExecutor): Promise<void> {
    const p = event.payload as Payload;
    const dedupeKey = `${event.type}:${event.id}`;

    const approval = APPROVERS[event.type];
    if (approval) {
      await this.inbox.notifyHolders(approval.permission, { ...approval.notice, dedupeKey }, tx);
      return;
    }

    const doctor = DOCTOR[event.type];
    if (doctor) {
      const workplace = await this.workplaces.workplace(p['workplaceId'] as string, tx);
      if (workplace?.doctorAccountId) {
        await this.inbox.notifyAccounts([workplace.doctorAccountId], { ...doctor, dedupeKey }, tx);
      }
      return;
    }

    if ((TICKET_TYPES as readonly string[]).includes(event.type)) {
      await this.ticket(event.type, p, dedupeKey, tx);
      return;
    }

    const rule = PATIENT[event.type];
    const notice = typeof rule === 'function' ? rule(p) : rule;
    if (!notice) return;
    let accounts: string[] = [];
    if (event.type.startsWith('booking.')) {
      const id = await this.bookings.patientAccountOf?.(p['appointmentId'] as string, tx);
      accounts = id ? [id] : [];
    } else if (typeof p['caseId'] === 'string') {
      accounts = await this.patientsOfCase(p['caseId'], tx);
    }
    await this.inbox.notifyAccounts(accounts, { ...notice, dedupeKey }, tx);
  }

  private async ticket(type: string, p: Payload, dedupeKey: string, tx: SqlExecutor) {
    const id = p['ticketId'] as string;
    const parties = await this.tickets.partiesOf(id, tx);
    if (!parties) return;
    if (type === 'ticket.assigned') {
      const assignee = (p['assigneeAccountId'] as string | undefined) ?? parties.assigneeAccountId;
      if (assignee) {
        await this.inbox.notifyAccounts(
          [assignee],
          {
            kind: 'ticket',
            title: 'تیکتی به شما سپرده شد',
            body: 'یک تیکت تازه در صف شماست.',
            linkHref: `/tickets/${id}`,
            dedupeKey,
          },
          tx,
        );
      }
      return;
    }
    if (!parties.requesterAccountId) return;
    const base =
      parties.channel === 'patient'
        ? '/me/tickets'
        : parties.channel === 'center'
          ? '/panel/tickets'
          : null;
    if (!base) return;
    await this.inbox.notifyAccounts(
      [parties.requesterAccountId],
      {
        kind: 'ticket',
        title: 'تیکت شما پاسخ گرفت',
        body: 'تیکت شما حل‌شده اعلام شد؛ پاسخ را ببینید.',
        linkHref: `${base}/${id}`,
        dedupeKey,
      },
      tx,
    );
  }
}

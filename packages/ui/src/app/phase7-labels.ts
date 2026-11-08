import type { TicketEventKind, TicketLinkType, TicketStatus } from '@sepehr/contracts';
import type { Tone as StatusTone } from '../kit/controls.js';

type Label = { readonly label: string; readonly tone: StatusTone };

/**
 * Phase 7's states in words (task 7-7; doc 17 §1), and the color each is shown in. A state is
 * always written, never told by its color alone.
 */

export const TICKET_STATUS: Readonly<Record<TicketStatus, Label>> = {
  open: { label: 'ثبت‌شده', tone: 'info' },
  assigned: { label: 'سپرده به کارشناس', tone: 'info' },
  in_progress: { label: 'در دست بررسی', tone: 'warning' },
  waiting_on_requester: { label: 'در انتظار پاسخ شما', tone: 'warning' },
  resolved: { label: 'حل‌شده', tone: 'success' },
  closed: { label: 'بسته‌شده', tone: 'neutral' },
  reopened: { label: 'بازگشایی‌شده', tone: 'warning' },
};

/** The same, as staff read it: waiting on the requester, not on «you». */
export const STAFF_TICKET_STATUS: Readonly<Record<TicketStatus, Label>> = {
  ...TICKET_STATUS,
  waiting_on_requester: { label: 'در انتظار پاسخ ثبت‌کننده', tone: 'warning' },
};

export const TICKET_KIND: Readonly<Record<'ticket' | 'complaint', string>> = {
  ticket: 'تیکت',
  complaint: 'شکایت',
};

export const TICKET_LINK: Readonly<Record<TicketLinkType, string>> = {
  appointment: 'نوبت',
  proforma: 'پیش‌فاکتور',
  service: 'خدمت',
  installment: 'قسط',
  payment: 'فیش',
  statement: 'صورت‌وضعیت',
  doctor_payable: 'قلم تسویه',
  service_fee: 'کارمزد خدمت',
};

export const TICKET_EVENT: Readonly<Record<TicketEventKind, string>> = {
  opened: 'ثبت',
  assigned: 'سپردن به کارشناس',
  status: 'تغییر وضعیت',
  transferred: 'ارجاع به واحد',
  sla_warning: 'هشدار نزدیک شدن مهلت',
  sla_breached: 'گذشتن از مهلت',
};

/** The units with a ticket queue (task 7-1's topics) and their names (doc 04; 7-5's dashboards). */
export const TICKET_UNIT: Readonly<Record<string, string>> = {
  support: 'پشتیبانی',
  accounting: 'حسابداری و تسویه',
  collection: 'واحد معوقات',
  network_specialist: 'شبکه درمان',
  case_completion: 'تکمیل پرونده',
  credit_specialist: 'اعتبار',
  advisor: 'مشاوره',
};

export const ticketUnit = (unit: string): string => TICKET_UNIT[unit] ?? unit;

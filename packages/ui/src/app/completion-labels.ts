import type {
  COMPLETION_RECEIPT_STATUSES,
  CompletionReceiptKind,
  CONTRACT_STATUSES,
  DELIVERY_ITEM_KINDS,
  DELIVERY_ITEM_STATUSES,
  DELIVERY_METHODS,
  DeliveryStatus,
  InstrumentStatus,
} from '@sepehr/contracts';
import type { Tone as StatusTone } from '../kit/controls.js';
import { faDigits } from '../kit/format.js';

type Label = { readonly label: string; readonly tone: StatusTone };

/** A loan contract's state (doc 12 §2; task 4-1). */
export const CONTRACT_STATUS: Readonly<Record<(typeof CONTRACT_STATUSES)[number], Label>> = {
  generating: { label: 'در حال آماده‌سازی', tone: 'info' },
  ready: { label: 'آماده پذیرش', tone: 'warning' },
  failed: { label: 'ناموفق', tone: 'danger' },
  accepted: { label: 'پذیرفته‌شده به‌دست همه طرفین', tone: 'success' },
};

/** A physical delivery's state (doc 12 §3; task 4-2). */
export const DELIVERY_STATUS: Readonly<Record<DeliveryStatus, Label>> = {
  awaiting_send: { label: 'در انتظار ارسال', tone: 'warning' },
  sent: { label: 'ارسال‌شده', tone: 'info' },
  received: { label: 'رسیده، در حال بررسی', tone: 'info' },
  verified: { label: 'بررسی‌شده و کامل', tone: 'success' },
  incomplete: { label: 'ناقص', tone: 'danger' },
  returned: { label: 'برگشت‌داده‌شده', tone: 'neutral' },
  archived: { label: 'بایگانی‌شده', tone: 'success' },
  released: { label: 'مسترد‌شده', tone: 'neutral' },
};

export const DELIVERY_ITEM_KIND: Readonly<Record<(typeof DELIVERY_ITEM_KINDS)[number], string>> = {
  signed_contract: 'قرارداد امضاشده',
  cheque: 'چک',
  promissory_note: 'سفته',
  other: 'سایر',
};

export const DELIVERY_ITEM_STATUS: Readonly<
  Record<(typeof DELIVERY_ITEM_STATUSES)[number], Label>
> = {
  expected: { label: 'در انتظار', tone: 'neutral' },
  received: { label: 'رسید', tone: 'success' },
  missing: { label: 'نرسید', tone: 'danger' },
};

export const DELIVERY_METHOD: Readonly<Record<(typeof DELIVERY_METHODS)[number], string>> = {
  courier: 'پیک',
  post: 'پست',
  in_person: 'حضوری',
};

export const INSTRUMENT_STATUS: Readonly<Record<InstrumentStatus, Label>> = {
  received: { label: 'دریافت‌شده', tone: 'info' },
  verified: { label: 'بررسی‌شده', tone: 'success' },
  held: { label: 'نگهداری', tone: 'success' },
  released: { label: 'مسترد‌شده', tone: 'neutral' },
  presented: { label: 'ارائه به بانک', tone: 'info' },
  cleared: { label: 'وصول‌شده', tone: 'success' },
  bounced: { label: 'برگشتی', tone: 'danger' },
  legal_action: { label: 'اقدام حقوقی', tone: 'danger' },
};

/** What a completion receipt pays (doc 12 §4; task 4-3). */
export const RECEIPT_KIND: Readonly<Record<CompletionReceiptKind, string>> = {
  origination_fee: 'هزینه تشکیل پرونده',
  plan_fee: 'کارمزد طرح',
  down_payment: 'پیش‌پرداخت',
};

export const RECEIPT_STATUS: Readonly<Record<(typeof COMPLETION_RECEIPT_STATUSES)[number], Label>> =
  {
    pending_approval: { label: 'در انتظار تأیید مالی', tone: 'warning' },
    approved: { label: 'تأییدشده', tone: 'success' },
    rejected: { label: 'ردشده', tone: 'danger' },
  };

/**
 * What still stands in the way of completion, as the service names it (doc 12 §4). The
 * conditions are checked by the service only; this only puts its answer into words.
 */
export function missingLabel(code: string): string {
  if (code === 'approval') return 'تأیید اعتبار';
  if (code === 'contract') return 'پذیرش قرارداد به‌دست همه طرفین';
  if (code === 'delivery') return 'بررسی کامل مدارک فیزیکی';
  if (code.startsWith('condition:')) return `شرط ${faDigits(Number(code.slice(10)) + 1)} تصمیم`;
  // The cheque rule (owner 1405/07/29, ج۵); its numbers are the panel's, never written here.
  if (code === 'cheque:borrower') return 'حداقل چک قسط وام‌گیرنده (بررسی‌شده)';
  if (code.startsWith('cheque:guarantor:')) {
    return `حداقل مبلغ چک ضمانت ضامن ${faDigits(Number(code.slice(17)) + 1)} (بررسی‌شده)`;
  }
  if (code.startsWith('receipt:')) {
    const kind = code.slice(8);
    const label = (RECEIPT_KIND as Readonly<Record<string, string | undefined>>)[kind];
    return `تأیید فیش ${label ?? kind}`;
  }
  return code;
}

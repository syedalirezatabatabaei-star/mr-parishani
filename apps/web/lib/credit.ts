import type { CreditApplicationStatus, ProformaStatus } from '@sepehr/contracts';
import type { StatusTone } from '@sepehr/ui';

type Label = { readonly label: string; readonly tone: StatusTone };

/** A proforma's status in words (doc 10 §2), and its color. */
export const PROFORMA_STATUS: Readonly<Record<ProformaStatus, Label>> = {
  draft: { label: 'پیش‌نویس', tone: 'neutral' },
  issued: { label: 'صادرشده، در انتظار بیمار', tone: 'warning' },
  patient_confirmed: { label: 'تأییدشده به‌دست بیمار', tone: 'success' },
  disputed: { label: 'اعتراض بیمار', tone: 'danger' },
  superseded: { label: 'جایگزین‌شده با نسخه تازه', tone: 'neutral' },
  expired: { label: 'منقضی', tone: 'neutral' },
};

/** Proformas the doctor may correct with a new version (task 3-4 decision). */
export const REVISABLE: readonly ProformaStatus[] = ['issued', 'disputed', 'expired'];

/**
 * A credit application's status as the patient reads it (doc 10 §6): the state and what
 * comes next, never a score.
 */
export const CREDIT_STATUS: Readonly<Record<CreditApplicationStatus, Label>> = {
  draft: { label: 'پیش‌نویس، ارسال نشده', tone: 'neutral' },
  incomplete: { label: 'در حال تکمیل مدارک', tone: 'warning' },
  ready_for_review: { label: 'در صف بررسی اعتبار', tone: 'info' },
  scoring: { label: 'در حال بررسی اعتبار', tone: 'info' },
  manual_review: { label: 'در انتظار تصمیم', tone: 'info' },
  approved: { label: 'تأییدشده', tone: 'success' },
  conditional: { label: 'تأیید با شرط', tone: 'accent' },
  rejected: { label: 'تأیید نشد', tone: 'danger' },
  expired: { label: 'منقضی', tone: 'neutral' },
};

/** The credit states a patient may still act in: consent, documents, guarantors. */
export const CREDIT_OPEN: readonly CreditApplicationStatus[] = [
  'incomplete',
  'ready_for_review',
  'scoring',
  'manual_review',
];

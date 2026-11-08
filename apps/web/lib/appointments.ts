import type { AppointmentStatus } from '@sepehr/contracts';
import type { StatusTone } from '@sepehr/ui';

/** An appointment's status in words (doc 08 §7), and the color it is shown in. */
export const APPOINTMENT_STATUS: Readonly<
  Record<AppointmentStatus, { readonly label: string; readonly tone: StatusTone }>
> = {
  held: { label: 'در حال انتخاب', tone: 'neutral' },
  requested: { label: 'در انتظار تأیید مرکز', tone: 'warning' },
  confirmed: { label: 'تأییدشده', tone: 'success' },
  checked_in: { label: 'پذیرش‌شده', tone: 'info' },
  examined: { label: 'انجام‌شده', tone: 'accent' },
  rejected: { label: 'ردشده', tone: 'danger' },
  expired: { label: 'منقضی', tone: 'neutral' },
  cancelled_by_patient: { label: 'لغو به‌دست شما', tone: 'neutral' },
  cancelled_by_center: { label: 'لغو به‌دست مرکز', tone: 'danger' },
  no_show: { label: 'عدم حضور', tone: 'danger' },
  rescheduled: { label: 'جابه‌جاشده', tone: 'neutral' },
};

/** What a patient may still cancel; the API enforces the time limit itself. */
export const PATIENT_CANCELLABLE: readonly AppointmentStatus[] = ['requested', 'confirmed'];

/** Whether the patient may still try to cancel: an active status, not yet started. */
export const patientMayCancel = (
  appointment: { readonly status: AppointmentStatus; readonly startsAt: string },
  now: number = Date.now(),
): boolean =>
  PATIENT_CANCELLABLE.includes(appointment.status) && Date.parse(appointment.startsAt) > now;

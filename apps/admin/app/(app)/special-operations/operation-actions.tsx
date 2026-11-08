'use client';

import { ApiError, unwrap } from '@sepehr/api-client';
import { normalizeDigits, parseRial, type JalaliDate } from '@sepehr/contracts';
import {
  apiDay,
  buttonClass,
  DateField,
  errorMessage,
  formText,
  MoneyField,
  Notice,
  OWN_FUNDING_REQUEST,
  SelectField,
  TextField,
  useApi,
} from '@sepehr/ui';
import { useRouter } from 'next/navigation';
import { useState, type ReactNode, type SubmitEvent } from 'react';

/**
 * Task 4-8's special operations, as finance and case completion see them: asking, and
 * deciding what another asked. Every rule (two people, caps, what is owed, the codes) is the
 * service's; these forms only ask, and say a refusal in Persian.
 */

/** The maker-checker refusal reads the same on every 4-8 page (owner, task 4-7). */
const operationError = (err: unknown) =>
  err instanceof ApiError && err.code === 'same_person' ? OWN_FUNDING_REQUEST : errorMessage(err);

function useAction() {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const run = async (action: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await action();
      router.refresh();
      return true;
    } catch (err) {
      setError(operationError(err));
      return false;
    } finally {
      setBusy(false);
    }
  };
  return { error, setError, busy, run };
}

/** A key per submitted form, so a retried submit records once (rule 5). */
const newKey = (prefix: string) => `${prefix}-${crypto.randomUUID()}`;

// --- deciding --------------------------------------------------------------------------

export type DecisionTarget =
  | { kind: 'purse_operation'; id: string }
  | { kind: 'cancellation'; id: string }
  | { kind: 'refund_payment'; id: string }
  | { kind: 'credit_transfer'; id: string }
  | { kind: 'credit_transfer_revoke'; id: string }
  | { kind: 'penalty_override'; id: string };

function useDecide() {
  const api = useApi();
  return (target: DecisionTarget, approve: boolean, reason: string, confirmed = false) => {
    const params = { params: { path: { id: target.id } }, body: { reason } };
    switch (target.kind) {
      case 'purse_operation':
        return approve
          ? unwrap(api.POST('/api/v1/wallet/special-operations/{id}/approve', params))
          : unwrap(api.POST('/api/v1/wallet/special-operations/{id}/reject', params));
      case 'cancellation':
        return approve
          ? unwrap(api.POST('/api/v1/credit/cancellations/{id}/approve', params))
          : unwrap(api.POST('/api/v1/credit/cancellations/{id}/reject', params));
      case 'refund_payment':
        return approve
          ? unwrap(api.POST('/api/v1/refund-payments/{id}/approve', params))
          : unwrap(api.POST('/api/v1/refund-payments/{id}/reject', params));
      case 'credit_transfer':
        // ADR-047: approving says the signed paper was received.
        return approve
          ? unwrap(
              api.POST('/api/v1/wallet/credit-transfers/{id}/approve', {
                params: { path: { id: target.id } },
                body: { reason, paperReceived: confirmed },
              }),
            )
          : unwrap(api.POST('/api/v1/wallet/credit-transfers/{id}/reject', params));
      case 'credit_transfer_revoke':
        return approve
          ? unwrap(api.POST('/api/v1/wallet/credit-transfers/{id}/revoke/approve', params))
          : unwrap(api.POST('/api/v1/wallet/credit-transfers/{id}/revoke/reject', params));
      case 'penalty_override':
        return approve
          ? unwrap(api.POST('/api/v1/credit/penalty-overrides/{id}/approve', params))
          : unwrap(api.POST('/api/v1/credit/penalty-overrides/{id}/reject', params));
    }
  };
}

/**
 * Approve or reject, each with a reason (the audit keeps it). Never one's own request
 * (doc 12 §7): said here, and the API refuses it anyway.
 */
export function Decide({
  target,
  mine,
  approveLabel,
  confirm,
}: {
  target: DecisionTarget;
  mine: boolean;
  approveLabel: string;
  /** ADR-047: a statement the approver ticks before approving (the signed paper received). */
  confirm?: string;
}) {
  const decide = useDecide();
  const { error, setError, busy, run } = useAction();
  const [mode, setMode] = useState<'approve' | 'reject' | null>(null);
  if (mine) return <Notice tone="warning">{OWN_FUNDING_REQUEST}</Notice>;
  if (mode) {
    const id = `decide-${target.kind}-${target.id}`;
    return (
      <form
        className="flex flex-wrap items-end gap-2"
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          const reason = formText(e.currentTarget, 'reason');
          const confirmed = new FormData(e.currentTarget).get('confirm') === 'on';
          if (mode === 'approve' && confirm && !confirmed) {
            setError('پیش از تأیید، دریافت سند امضاشده را تأیید کنید.');
            return;
          }
          void run(() => decide(target, mode === 'approve', reason, confirmed));
        }}
      >
        <TextField
          id={id}
          name="reason"
          label={mode === 'approve' ? 'دلیل تأیید' : 'دلیل رد'}
          required
        />
        {mode === 'approve' && confirm && (
          <label className="flex items-center gap-2">
            <input type="checkbox" name="confirm" required />
            {confirm}
          </label>
        )}
        <button
          type="submit"
          disabled={busy}
          className={buttonClass(mode === 'approve' ? 'primary' : 'danger')}
        >
          {mode === 'approve' ? approveLabel : 'رد درخواست'}
        </button>
        <button
          type="button"
          className={buttonClass('quiet')}
          onClick={() => {
            setMode(null);
          }}
        >
          انصراف
        </button>
        {error && <Notice tone="danger">{error}</Notice>}
      </form>
    );
  }
  return (
    <span className="flex flex-wrap gap-2">
      <button
        type="button"
        className={buttonClass('primary')}
        onClick={() => {
          setMode('approve');
        }}
      >
        {approveLabel}
      </button>
      <button
        type="button"
        className={buttonClass('secondary')}
        onClick={() => {
          setMode('reject');
        }}
      >
        رد با دلیل
      </button>
    </span>
  );
}

// --- asking ----------------------------------------------------------------------------

function AskForm({
  label,
  submit,
  children,
  busy,
  error,
  danger,
  onSubmit,
}: {
  label: string;
  submit: string;
  children: ReactNode;
  busy: boolean;
  error: string | null;
  danger?: boolean;
  onSubmit: (form: HTMLFormElement) => void;
}) {
  return (
    <form
      className="space-y-3 rounded-md border border-border p-3"
      aria-label={label}
      noValidate
      onSubmit={(e: SubmitEvent<HTMLFormElement>) => {
        e.preventDefault();
        onSubmit(e.currentTarget);
      }}
    >
      <div className="grid gap-3 sm:grid-cols-2">{children}</div>
      <button type="submit" disabled={busy} className={buttonClass(danger ? 'danger' : 'primary')}>
        {submit}
      </button>
      {error && <Notice tone="danger">{error}</Notice>}
    </form>
  );
}

/** Before funding (task 4-8, part 3): every approved receipt refunded, without penalty. */
export function AskCancellation({ applicationId }: { applicationId: string }) {
  const api = useApi();
  const { error, busy, run } = useAction();
  return (
    <AskForm
      label="درخواست انصراف پیش از شارژ"
      submit="درخواست انصراف"
      danger
      busy={busy}
      error={error}
      onSubmit={(form) =>
        void run(() =>
          unwrap(
            api.POST('/api/v1/credit/cancellations', {
              body: { creditApplicationId: applicationId, reason: formText(form, 'reason') },
            }),
          ),
        )
      }
    >
      <TextField id={`cancel-${applicationId}`} name="reason" label="دلیل انصراف" required />
    </AskForm>
  );
}

/** After funding (part 1): what is unused, all of it or an amount. */
export function AskCancelUnused({ purseId }: { purseId: string }) {
  const api = useApi();
  const { error, setError, busy, run } = useAction();
  return (
    <AskForm
      label="درخواست ابطال مانده مصرف‌نشده"
      submit="درخواست ابطال"
      danger
      busy={busy}
      error={error}
      onSubmit={(form) => {
        const typed = formText(form, 'amount').trim();
        const amount = typed ? parseRial(typed) : null;
        if (typed && (amount === null || amount <= 0n)) {
          setError(
            'مبلغ را به ریال و بدون اعشار وارد کنید، یا خالی بگذارید تا همه مانده باطل شود.',
          );
          return;
        }
        void run(() =>
          unwrap(
            api.POST('/api/v1/wallet/special-operations', {
              body: {
                kind: 'cancel_unused',
                purseId,
                ...(amount ? { amountRial: amount.toString() } : {}),
                reason: formText(form, 'reason'),
              },
            }),
          ),
        );
      }}
    >
      <MoneyField
        id={`unused-amount-${purseId}`}
        name="amount"
        label="مبلغ ابطال (خالی: همه مانده)"
        hint="از آخرین اقساط دست‌نخورده کم می‌شود."
      />
      <TextField id={`unused-reason-${purseId}`} name="reason" label="دلیل" required />
    </AskForm>
  );
}

/**
 * Cancelling after funding (doc 02 §6, part 7): what is unused, the fee of installments not
 * yet due waived, the contract's penalty as a lump sum; the purse closed. Never undone here.
 */
export function AskCancelAfterFunding({ purseId }: { purseId: string }) {
  const api = useApi();
  const { error, busy, run } = useAction();
  return (
    <AskForm
      label="درخواست انصراف پس از شارژ"
      submit="درخواست انصراف پس از شارژ"
      danger
      busy={busy}
      error={error}
      onSubmit={(form) =>
        void run(() =>
          unwrap(
            api.POST('/api/v1/wallet/special-operations', {
              body: { kind: 'cancel_after_funding', purseId, reason: formText(form, 'reason') },
            }),
          ),
        )
      }
    >
      <p className="sm:col-span-2 text-ink-muted">
        مانده مصرف‌نشده باطل، کارمزد اقساط سررسیدنشده بخشوده و خسارت قرارداد یکجا با سررسید جدا ثبت
        می‌شود؛ کیف بسته می‌شود.
      </p>
      <TextField id={`after-funding-${purseId}`} name="reason" label="دلیل انصراف" required />
    </AskForm>
  );
}

/**
 * A case's own cancellation-penalty rate (owner پ۱۳): a percent from 0 to 18, asked before
 * the contract; another person approves it, and the contract made after locks it.
 */
export function AskPenaltyOverride({ applicationId }: { applicationId: string }) {
  const api = useApi();
  const { error, setError, busy, run } = useAction();
  return (
    <AskForm
      label="درخواست نرخ خسارت این پرونده"
      submit="درخواست نرخ"
      busy={busy}
      error={error}
      onSubmit={(form) => {
        const typed = normalizeDigits(formText(form, 'percent')).trim();
        const percent = Number(typed);
        // Two decimals at most: whole basis points.
        if (!/^\d{1,2}(\.\d{1,2})?$/.test(typed) || percent > 18) {
          setError('نرخ را به درصد، بین ۰ تا ۱۸ و با حداکثر دو رقم اعشار، وارد کنید.');
          return;
        }
        void run(() =>
          unwrap(
            api.POST('/api/v1/credit/applications/{id}/penalty-overrides', {
              params: { path: { id: applicationId } },
              body: { penaltyBps: Math.round(percent * 100), reason: formText(form, 'reason') },
            }),
          ),
        );
      }}
    >
      <TextField
        id={`penalty-${applicationId}`}
        name="percent"
        label="نرخ خسارت (درصد)"
        hint="بین ۰ تا ۱۸؛ بالاتر فقط با ADR تازه."
        dir="ltr"
        figures
        required
      />
      <TextField id={`penalty-reason-${applicationId}`} name="reason" label="دلیل" required />
    </AskForm>
  );
}

/** A cancellation done, reversed exactly (doc 02 §8-8). */
export function AskReverse({ requestId }: { requestId: string }) {
  const api = useApi();
  const { error, busy, run } = useAction();
  return (
    <AskForm
      label="درخواست برگشت ابطال"
      submit="درخواست برگشت"
      busy={busy}
      error={error}
      onSubmit={(form) =>
        void run(() =>
          unwrap(
            api.POST('/api/v1/wallet/special-operations', {
              body: {
                kind: 'reverse_cancel_unused',
                requestId,
                reason: formText(form, 'reason'),
              },
            }),
          ),
        )
      }
    >
      <TextField id={`reverse-${requestId}`} name="reason" label="دلیل برگشت" required />
    </AskForm>
  );
}

interface DoctorCandidate {
  workplaceId: string;
  /** Absent for whoever may not see the doctor (doc 04 §4): the API strips it. */
  doctorName?: string;
  centerName: string | null;
}

/** Owner 1405/07/24: the center's name; the doctor only for whoever may see them. */
const candidateLabel = (c: DoctorCandidate) =>
  [c.doctorName, c.centerName ?? 'مطب شخصی']
    .filter((part) => part !== undefined && part !== '')
    .join(' · ');

/**
 * A new doctor for the purse (part 2): picked from the doctors the service would accept
 * (f7, owner 1405/07/23): the purse's treatment field, an active center, not its doctor.
 */
export function AskChangeDoctor({ purseId }: { purseId: string }) {
  const api = useApi();
  const { error, setError, busy, run } = useAction();
  const [candidates, setCandidates] = useState<readonly DoctorCandidate[] | null>(null);
  const [searching, setSearching] = useState(false);
  const search = async (q: string) => {
    setSearching(true);
    try {
      const found = await unwrap(
        api.GET('/api/v1/wallet/purses/{id}/doctor-candidates', {
          params: { path: { id: purseId }, query: q.trim() === '' ? {} : { q } },
        }),
      );
      setCandidates(found);
    } catch (err) {
      setError(operationError(err));
    } finally {
      setSearching(false);
    }
  };
  return (
    <AskForm
      label="درخواست تغییر پزشک"
      submit="درخواست تغییر پزشک"
      busy={busy}
      error={error}
      onSubmit={(form) => {
        const workplaceId = formText(form, 'workplace');
        if (workplaceId === '') {
          setError('پزشک تازه را از فهرست انتخاب کنید.');
          return;
        }
        void run(() =>
          unwrap(
            api.POST('/api/v1/wallet/special-operations', {
              body: {
                kind: 'change_doctor',
                purseId,
                workplaceId,
                reason: formText(form, 'reason'),
              },
            }),
          ),
        );
      }}
    >
      <div className="space-y-2">
        <TextField
          id={`doctor-search-${purseId}`}
          name="q"
          label="جست‌وجوی پزشک یا مرکز"
          type="search"
          hint="خالی: همه. فقط پزشکان همان رشته درمان و همان شهر، در مرکز فعال."
        />
        <button
          type="button"
          disabled={searching}
          className={buttonClass('secondary')}
          onClick={(e) => {
            const field = e.currentTarget.form?.elements.namedItem('q');
            void search(field instanceof HTMLInputElement ? field.value : '');
          }}
        >
          {candidates === null ? 'نمایش پزشکان' : 'جست‌وجو'}
        </button>
      </div>
      {candidates === null ? null : candidates.length === 0 ? (
        <Notice tone="info">پزشکی با این شرط‌ها پیدا نشد.</Notice>
      ) : (
        <SelectField
          key={candidates.map((c) => c.workplaceId).join(',')}
          id={`doctor-${purseId}`}
          name="workplace"
          label="پزشک تازه"
          emptyLabel="انتخاب کنید"
          options={candidates.map((c) => ({
            value: c.workplaceId,
            label: candidateLabel(c),
          }))}
        />
      )}
      <TextField id={`doctor-reason-${purseId}`} name="reason" label="دلیل" required />
    </AskForm>
  );
}

/** A refund paid by bank (part 4): part may be paid, never more than is owed. */
export function RecordRefundPayment({
  applicationId,
  today,
  owed,
}: {
  applicationId: string;
  today: JalaliDate;
  owed: { fee: string; downPayment: string };
}) {
  const api = useApi();
  const { error, setError, busy, run } = useAction();
  const [paidOn, setPaidOn] = useState<JalaliDate | null>(null);
  const [key, setKey] = useState(() => newKey('refund'));
  return (
    <AskForm
      label="ثبت پرداخت استرداد"
      submit="ثبت پرداخت"
      busy={busy}
      error={error}
      onSubmit={(form) => {
        const amount = parseRial(formText(form, 'amount'));
        if (amount === null || amount <= 0n) {
          setError('مبلغ را به ریال و بدون اعشار، همان‌طور که در حواله آمده است، وارد کنید.');
          return;
        }
        if (!paidOn) {
          setError('روز پرداخت را انتخاب کنید.');
          return;
        }
        const account = formText(form, 'account') === 'fee' ? 'fee' : 'down_payment';
        void run(() =>
          unwrap(
            api.POST('/api/v1/refund-payments', {
              body: {
                creditApplicationId: applicationId,
                account,
                amountRial: amount.toString(),
                bankReference: formText(form, 'reference'),
                paidOn: apiDay(paidOn),
                idempotencyKey: key,
                reason: formText(form, 'reason'),
              },
            }),
          ),
        ).then((ok) => {
          if (ok) setKey(newKey('refund'));
        });
      }}
    >
      <SelectField
        id={`refund-account-${applicationId}`}
        name="account"
        label="بابت"
        options={[
          { value: 'down_payment', label: `پیش‌پرداخت (مانده ${owed.downPayment})` },
          { value: 'fee', label: `هزینه‌های پرونده (مانده ${owed.fee})` },
        ]}
      />
      <MoneyField id={`refund-amount-${applicationId}`} name="amount" label="مبلغ" required />
      <DateField
        mode="single"
        label="روز پرداخت"
        today={today}
        max={today}
        value={paidOn}
        onChange={setPaidOn}
      />
      <TextField
        id={`refund-reference-${applicationId}`}
        name="reference"
        label="شماره پیگیری بانک"
        dir="ltr"
        figures
        required
      />
      <TextField id={`refund-reason-${applicationId}`} name="reason" label="توضیح" required />
    </AskForm>
  );
}

/** A credit transfer (part 5): the recipient, and the amount they may use. */
export function AskCreditTransfer({ purseId }: { purseId: string }) {
  const api = useApi();
  const { error, setError, busy, run } = useAction();
  return (
    <AskForm
      label="درخواست انتقال اعتبار"
      submit="ثبت و ارسال کدها"
      busy={busy}
      error={error}
      onSubmit={(form) => {
        const amount = parseRial(formText(form, 'amount'));
        if (amount === null || amount <= 0n) {
          setError('مبلغ را به ریال و بدون اعشار وارد کنید.');
          return;
        }
        void run(() =>
          unwrap(
            api.POST('/api/v1/wallet/credit-transfers', {
              body: {
                purseId,
                recipient: {
                  name: formText(form, 'name'),
                  nationalId: formText(form, 'nationalId'),
                  mobile: formText(form, 'mobile'),
                },
                amountRial: amount.toString(),
                reason: formText(form, 'reason'),
                paperDocumentNumber: formText(form, 'paper'),
              },
            }),
          ),
        );
      }}
    >
      <TextField id={`recipient-name-${purseId}`} name="name" label="نام گیرنده" required />
      <TextField
        id={`recipient-id-${purseId}`}
        name="nationalId"
        label="کد ملی گیرنده"
        dir="ltr"
        figures
        required
      />
      <TextField
        id={`recipient-mobile-${purseId}`}
        name="mobile"
        label="موبایل گیرنده"
        dir="ltr"
        figures
        required
      />
      <MoneyField
        id={`recipient-amount-${purseId}`}
        name="amount"
        label="سقف استفاده گیرنده"
        required
      />
      <TextField id={`recipient-reason-${purseId}`} name="reason" label="دلیل" required />
      <TextField
        id={`recipient-paper-${purseId}`}
        name="paper"
        label="شماره سند کاغذی امضاشده انتقال‌دهنده"
        dir="ltr"
        required
      />
    </AskForm>
  );
}

/** The two codes, as the recipient and the borrower read them (owner س۴); or send again. */
export function EnterTransferCodes({ id }: { id: string }) {
  const api = useApi();
  const { error, busy, run } = useAction();
  return (
    <div className="space-y-2">
      <AskForm
        label="کدهای انتقال اعتبار"
        submit="ثبت کدها"
        busy={busy}
        error={error}
        onSubmit={(form) =>
          void run(() =>
            unwrap(
              api.POST('/api/v1/wallet/credit-transfers/{id}/codes', {
                params: { path: { id } },
                body: {
                  recipientCode: formText(form, 'recipientCode'),
                  borrowerCode: formText(form, 'borrowerCode'),
                },
              }),
            ),
          )
        }
      >
        <TextField
          id={`code-recipient-${id}`}
          name="recipientCode"
          label="کد پیامک‌شده به گیرنده"
          dir="ltr"
          figures
          autoComplete="off"
          required
        />
        <TextField
          id={`code-borrower-${id}`}
          name="borrowerCode"
          label="کد رضایت پیامک‌شده به وام‌گیرنده"
          dir="ltr"
          figures
          autoComplete="off"
          required
        />
      </AskForm>
      <button
        type="button"
        disabled={busy}
        className={buttonClass('quiet')}
        onClick={() =>
          void run(() =>
            unwrap(
              api.POST('/api/v1/wallet/credit-transfers/{id}/resend', { params: { path: { id } } }),
            ),
          )
        }
      >
        ارسال دوباره کدها
      </button>
    </div>
  );
}

/** Finance asks for the recipient to be revoked; another approves it (owner س۷). */
export function AskRevokeTransfer({ id }: { id: string }) {
  const api = useApi();
  const { error, busy, run } = useAction();
  return (
    <AskForm
      label="درخواست ابطال گیرنده"
      submit="درخواست ابطال گیرنده"
      danger
      busy={busy}
      error={error}
      onSubmit={(form) =>
        void run(() =>
          unwrap(
            api.POST('/api/v1/wallet/credit-transfers/{id}/revoke', {
              params: { path: { id } },
              body: { reason: formText(form, 'reason') },
            }),
          ),
        )
      }
    >
      <TextField id={`revoke-${id}`} name="reason" label="دلیل ابطال" required />
    </AskForm>
  );
}

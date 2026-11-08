import type { ChangeEvent, ReactNode } from 'react';

/**
 * Plain controls of the design system (task 2-10 style guide, task 2-11 pages). They hold no
 * state, so server pages render them as they are; forms post or GET natively.
 */

export type ButtonVariant = 'primary' | 'secondary' | 'quiet' | 'danger';

const BUTTON =
  'inline-flex min-h-10 items-center justify-center gap-2 rounded-md px-4 text-[length:var(--text-sm)] font-medium transition-colors duration-[var(--duration-base)] ease-[var(--ease)] disabled:cursor-not-allowed disabled:opacity-50 aria-disabled:cursor-not-allowed aria-disabled:opacity-50';

const VARIANT: Record<ButtonVariant, string> = {
  primary: 'bg-accent text-on-accent hover:bg-accent-hover',
  secondary: 'border border-border-strong bg-surface text-ink hover:bg-sunken',
  quiet: 'text-accent hover:bg-accent-soft',
  danger: 'bg-danger text-on-accent hover:opacity-90',
};

/** The classes of a button, for `<button>` and for links that look like one. */
export const buttonClass = (variant: ButtonVariant = 'primary', extra = '') =>
  `${BUTTON} ${VARIANT[variant]}${extra ? ` ${extra}` : ''}`;

export const inputClass =
  'block min-h-10 w-full rounded-md border border-border-strong bg-surface px-3 text-ink placeholder:text-ink-subtle aria-invalid:border-2 aria-invalid:border-danger';

const LABEL = 'block text-[length:var(--text-sm)] font-medium text-ink';
const HINT = 'block text-[length:var(--text-xs)] text-ink-subtle';
const ERROR = 'block text-[length:var(--text-xs)] text-danger';

interface FieldFrame {
  readonly label: string;
  readonly hint?: string;
  readonly error?: string | null;
  readonly className?: string;
}

function Frame({
  id,
  label,
  hint,
  error,
  className,
  children,
}: FieldFrame & { id: string; children: ReactNode }) {
  return (
    <div className={`space-y-1 ${className ?? ''}`}>
      <label htmlFor={id} className={LABEL}>
        {label}
      </label>
      {children}
      {hint && (
        <span id={`${id}-hint`} className={HINT}>
          {hint}
        </span>
      )}
      {error && (
        <span id={`${id}-error`} role="alert" className={ERROR}>
          {error}
        </span>
      )}
    </div>
  );
}

const describedBy = (id: string, hint?: string, error?: string | null) =>
  [hint ? `${id}-hint` : null, error ? `${id}-error` : null].filter(Boolean).join(' ') || undefined;

export interface TextFieldProps extends FieldFrame {
  readonly id: string;
  readonly name: string;
  readonly defaultValue?: string;
  readonly type?: 'text' | 'search' | 'tel' | 'password' | 'email';
  readonly inputMode?: 'text' | 'numeric' | 'tel' | 'search';
  readonly autoComplete?: string;
  readonly placeholder?: string;
  readonly required?: boolean;
  readonly dir?: 'ltr' | 'rtl';
  /** Digits line up (codes, numbers). */
  readonly figures?: boolean;
}

export function TextField(props: TextFieldProps) {
  return (
    <Frame {...props}>
      <input
        id={props.id}
        name={props.name}
        type={props.type ?? 'text'}
        defaultValue={props.defaultValue}
        inputMode={props.inputMode}
        autoComplete={props.autoComplete}
        placeholder={props.placeholder}
        required={props.required}
        dir={props.dir}
        aria-invalid={props.error ? true : undefined}
        aria-describedby={describedBy(props.id, props.hint, props.error)}
        className={`${inputClass}${props.figures ? ' figures' : ''}`}
      />
    </Frame>
  );
}

export interface TextAreaFieldProps extends FieldFrame {
  readonly id: string;
  readonly name: string;
  readonly defaultValue?: string;
  readonly rows?: number;
  readonly required?: boolean;
  readonly maxLength?: number;
}

/** Several lines of text (a message, a note): the same frame, label, hint and error. */
export function TextAreaField(props: TextAreaFieldProps) {
  return (
    <Frame {...props}>
      <textarea
        id={props.id}
        name={props.name}
        rows={props.rows ?? 4}
        defaultValue={props.defaultValue}
        required={props.required}
        maxLength={props.maxLength}
        aria-invalid={props.error ? true : undefined}
        aria-describedby={describedBy(props.id, props.hint, props.error)}
        className={`${inputClass} py-2`}
      />
    </Frame>
  );
}

/** A yes-or-no choice with its label beside it. */
export function CheckboxField({
  id,
  name,
  label,
  hint,
  defaultChecked,
}: {
  id: string;
  name: string;
  label: string;
  hint?: string;
  defaultChecked?: boolean;
}) {
  return (
    <div className="space-y-1">
      <div className="flex items-center gap-2">
        <input
          id={id}
          name={name}
          type="checkbox"
          value="true"
          defaultChecked={defaultChecked}
          aria-describedby={hint ? `${id}-hint` : undefined}
          className="h-5 w-5 accent-[var(--color-accent)]"
        />
        <label htmlFor={id} className={LABEL}>
          {label}
        </label>
      </div>
      {hint && (
        <span id={`${id}-hint`} className={HINT}>
          {hint}
        </span>
      )}
    </div>
  );
}

export interface SelectOption {
  readonly value: string;
  readonly label: string;
}

export interface SelectFieldProps extends FieldFrame {
  readonly id: string;
  readonly name: string;
  readonly options: readonly SelectOption[];
  readonly defaultValue?: string;
  /** The first, empty choice («همه»); leave out to require a value. */
  readonly emptyLabel?: string;
  /** For client components that follow the choice; forms read the value as it is. */
  readonly onChange?: (value: string) => void;
}

export function SelectField(props: SelectFieldProps) {
  return (
    <Frame {...props}>
      <select
        id={props.id}
        name={props.name}
        defaultValue={props.defaultValue ?? ''}
        {...(props.onChange
          ? { onChange: (e: ChangeEvent<HTMLSelectElement>) => props.onChange?.(e.target.value) }
          : {})}
        aria-invalid={props.error ? true : undefined}
        aria-describedby={describedBy(props.id, props.hint, props.error)}
        className={inputClass}
      >
        {props.emptyLabel !== undefined && <option value="">{props.emptyLabel}</option>}
        {props.options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </Frame>
  );
}

export type Tone = 'neutral' | 'info' | 'success' | 'warning' | 'danger' | 'accent';

const BADGE: Record<Tone, string> = {
  neutral: 'bg-sunken text-ink-muted',
  info: 'bg-info-soft text-info',
  success: 'bg-success-soft text-success',
  warning: 'bg-warning-soft text-warning',
  danger: 'bg-danger-soft text-danger',
  accent: 'bg-accent-soft text-on-accent-soft',
};

/** A status as a word in color; the word alone carries the meaning (WCAG 1.4.1). */
export function StatusBadge({ tone, children }: { tone: Tone; children: ReactNode }) {
  return (
    <span
      className={`inline-flex min-h-6 items-center rounded-sm px-2 text-[length:var(--text-xs)] font-medium ${BADGE[tone]}`}
    >
      {children}
    </span>
  );
}

const NOTICE: Record<Exclude<Tone, 'neutral' | 'accent'>, string> = {
  info: 'border-info bg-info-soft',
  success: 'border-success bg-success-soft',
  warning: 'border-warning bg-warning-soft',
  danger: 'border-danger bg-danger-soft',
};

/** A message on the page; `danger` and `warning` are announced to screen readers. */
export function Notice({
  tone,
  title,
  children,
}: {
  tone: keyof typeof NOTICE;
  title?: string;
  children?: ReactNode;
}) {
  return (
    <div
      role={tone === 'danger' || tone === 'warning' ? 'alert' : 'status'}
      className={`space-y-1 rounded-md border-s-4 p-3 text-[length:var(--text-sm)] text-ink ${NOTICE[tone]}`}
    >
      {title && <p className="font-bold">{title}</p>}
      {children}
    </div>
  );
}

/** Nothing to show, said plainly, with what to do next. */
export function EmptyState({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="space-y-2 rounded-lg border border-dashed border-border-strong p-8 text-center">
      <p className="font-medium text-ink">{title}</p>
      {children && <div className="text-[length:var(--text-sm)] text-ink-muted">{children}</div>}
    </div>
  );
}

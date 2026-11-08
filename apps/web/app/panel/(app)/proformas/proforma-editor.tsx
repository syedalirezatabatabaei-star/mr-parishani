'use client';

import { unwrap } from '@sepehr/api-client';
import { normalizeDigits, parseRial } from '@sepehr/contracts';
import {
  buttonClass,
  errorMessage,
  faDigits,
  inputClass,
  MoneyField,
  Notice,
  SelectField,
  toman,
  useApi,
} from '@sepehr/ui';
import { useRouter } from 'next/navigation';
import { useState } from 'react';

/** A service the workplace offers, with the price in force (rials, as text). */
export interface PricedService {
  readonly code: string;
  readonly name: string;
  readonly minRial: string;
  readonly maxRial: string;
}

/** A line as the form holds it: the price in rials as typed (owner, 1405/07/11). */
export interface DraftLine {
  readonly serviceCode: string;
  readonly quantity: string;
  readonly unitRial: string;
  readonly deviationReason: string;
  readonly toothOrSite: string;
  readonly note: string;
}

/** A line as the API takes it (createProformaSchema), with no empty optional field. */
interface LineBody {
  serviceCode: string;
  quantity: number;
  unitRial?: string;
  deviationReason?: string;
  toothOrSite?: string;
  note?: string;
}

const emptyLine = (serviceCode = ''): DraftLine => ({
  serviceCode,
  quantity: '1',
  unitRial: '',
  deviationReason: '',
  toothOrSite: '',
  note: '',
});

const priceText = (s: PricedService) =>
  s.minRial === s.maxRial ? toman(s.minRial) : `${toman(s.minRial)} تا ${toman(s.maxRial)}`;

/**
 * The doctor's proforma editor (doc 10 §2; task 3-8): services of the workplace's tariff,
 * a count, and a price typed in rials with its tomans beside it (rules 1–2). A price outside the
 * tariff's range needs a reason (rule 2 of doc 10 §2), which the API checks again. The
 * draft is saved, then issued to the patient; an issued one is never edited, only revised
 * into a new version.
 */
export function ProformaEditor({
  target,
  services,
  initial,
}: {
  target: { kind: 'create'; appointmentId: string } | { kind: 'revise'; proformaId: string };
  services: readonly PricedService[];
  initial?: readonly DraftLine[];
}) {
  const api = useApi();
  const router = useRouter();
  const [lines, setLines] = useState<DraftLine[]>(
    initial && initial.length > 0 ? [...initial] : [emptyLine(services[0]?.code)],
  );
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const set = (i: number, patch: Partial<DraftLine>) => {
    setLines((all) => all.map((l, j) => (j === i ? { ...l, ...patch } : l)));
  };

  const outside = (l: DraftLine) => {
    const s = services.find((x) => x.code === l.serviceCode);
    const rial = parseRial(l.unitRial);
    if (!s || rial === null) return false;
    return rial < BigInt(s.minRial) || rial > BigInt(s.maxRial);
  };

  const toInput = (l: DraftLine): LineBody | string => {
    if (!l.serviceCode) return 'خدمت هر ردیف را انتخاب کنید.';
    const quantity = Number(normalizeDigits(l.quantity));
    if (!Number.isInteger(quantity) || quantity < 1 || quantity > 99) {
      return 'تعداد هر ردیف عددی از ۱ تا ۹۹ است.';
    }
    let unitRial: string | undefined;
    if (l.unitRial.trim() !== '') {
      const rial = parseRial(l.unitRial);
      if (rial === null || rial === 0n) return 'قیمت را به ریال و به‌صورت عدد کامل بنویسید.';
      unitRial = rial.toString();
    }
    if (outside(l) && l.deviationReason.trim().length < 3) {
      return 'برای قیمت خارج از تعرفه دلیل بنویسید.';
    }
    return {
      serviceCode: l.serviceCode,
      quantity,
      ...(unitRial ? { unitRial } : {}),
      ...(l.deviationReason.trim() ? { deviationReason: l.deviationReason.trim() } : {}),
      ...(l.toothOrSite.trim() ? { toothOrSite: l.toothOrSite.trim() } : {}),
      ...(l.note.trim() ? { note: l.note.trim() } : {}),
    };
  };

  const save = async (issue: boolean) => {
    const inputs = lines.map(toInput);
    const problem = inputs.find((x): x is string => typeof x === 'string');
    if (problem) {
      setError(problem);
      return;
    }
    const body = inputs as LineBody[];
    setBusy(true);
    setError(null);
    try {
      const draft =
        target.kind === 'create'
          ? await unwrap(
              api.POST('/api/v1/proformas', {
                body: { appointmentId: target.appointmentId, lines: body },
              }),
            )
          : await unwrap(
              api.POST('/api/v1/proformas/{id}/revise', {
                params: { path: { id: target.proformaId } },
                body: { lines: body },
              }),
            );
      if (issue) {
        await unwrap(
          api.POST('/api/v1/proformas/{id}/issue', { params: { path: { id: draft.id } } }),
        );
      }
      router.push(`/panel/proformas/${draft.id}`);
      router.refresh();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  if (services.length === 0) {
    return <Notice tone="warning">برای این محل کار هنوز تعرفه‌ای ثبت نشده است.</Notice>;
  }
  return (
    <form
      className="space-y-4"
      noValidate
      onSubmit={(e) => {
        e.preventDefault();
        void save(false);
      }}
    >
      <ol className="space-y-3" aria-label="ردیف‌های پیش‌فاکتور">
        {lines.map((l, i) => {
          const service = services.find((s) => s.code === l.serviceCode);
          const n = faDigits(i + 1);
          const k = String(i);
          return (
            <li key={i} className="space-y-3 rounded-lg border border-border bg-surface p-4">
              <div className="flex items-center justify-between gap-2">
                <p className="font-bold">ردیف {n}</p>
                {lines.length > 1 && (
                  <button
                    type="button"
                    className={buttonClass('quiet')}
                    onClick={() => {
                      setLines((all) => all.filter((_, j) => j !== i));
                    }}
                  >
                    حذف ردیف {n}
                  </button>
                )}
              </div>
              <div className="grid gap-3 sm:grid-cols-3">
                <SelectField
                  id={`service-${k}`}
                  name={`service-${k}`}
                  label="خدمت"
                  defaultValue={l.serviceCode}
                  onChange={(v) => {
                    set(i, { serviceCode: v });
                  }}
                  options={services.map((s) => ({ value: s.code, label: s.name }))}
                  hint={service ? `تعرفه: ${priceText(service)}` : ''}
                />
                <div className="space-y-1">
                  <label
                    htmlFor={`quantity-${k}`}
                    className="block text-[length:var(--text-sm)] font-medium"
                  >
                    تعداد
                  </label>
                  <input
                    id={`quantity-${k}`}
                    inputMode="numeric"
                    className={`${inputClass} figures`}
                    value={l.quantity}
                    onChange={(e) => {
                      set(i, { quantity: e.target.value });
                    }}
                  />
                </div>
                <MoneyField
                  id={`price-${k}`}
                  name={`price-${k}`}
                  label="قیمت واحد"
                  {...(l.unitRial ? { defaultValue: l.unitRial } : {})}
                  hint="خالی: قیمت تعرفه، اگر یک مبلغ است."
                  onChange={(rial) => {
                    set(i, { unitRial: rial === null ? '' : rial.toString() });
                  }}
                />
              </div>
              {outside(l) && (
                <div className="space-y-1">
                  <Notice tone="warning">این قیمت خارج از تعرفه است و دلیل می‌خواهد.</Notice>
                  <label
                    htmlFor={`deviation-${k}`}
                    className="block text-[length:var(--text-sm)] font-medium"
                  >
                    دلیل قیمت خارج از تعرفه
                  </label>
                  <input
                    id={`deviation-${k}`}
                    className={inputClass}
                    value={l.deviationReason}
                    onChange={(e) => {
                      set(i, { deviationReason: e.target.value });
                    }}
                  />
                </div>
              )}
              <div className="grid gap-3 sm:grid-cols-2">
                <div className="space-y-1">
                  <label
                    htmlFor={`site-${k}`}
                    className="block text-[length:var(--text-sm)] font-medium"
                  >
                    دندان یا محل (اختیاری)
                  </label>
                  <input
                    id={`site-${k}`}
                    className={inputClass}
                    value={l.toothOrSite}
                    onChange={(e) => {
                      set(i, { toothOrSite: e.target.value });
                    }}
                  />
                </div>
                <div className="space-y-1">
                  <label
                    htmlFor={`note-${k}`}
                    className="block text-[length:var(--text-sm)] font-medium"
                  >
                    یادداشت (اختیاری)
                  </label>
                  <input
                    id={`note-${k}`}
                    className={inputClass}
                    value={l.note}
                    onChange={(e) => {
                      set(i, { note: e.target.value });
                    }}
                  />
                </div>
              </div>
            </li>
          );
        })}
      </ol>
      <button
        type="button"
        className={buttonClass('secondary')}
        onClick={() => {
          setLines((all) => [...all, emptyLine(services[0]?.code)]);
        }}
      >
        افزودن ردیف
      </button>
      {error && <Notice tone="danger">{error}</Notice>}
      <div className="flex flex-wrap gap-2">
        <button type="submit" disabled={busy} className={buttonClass('secondary')}>
          ذخیره پیش‌نویس
        </button>
        <button
          type="button"
          disabled={busy}
          className={buttonClass('primary')}
          onClick={() => void save(true)}
        >
          ذخیره و صدور برای بیمار
        </button>
      </div>
    </form>
  );
}

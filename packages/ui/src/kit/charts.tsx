import type { ReactNode } from 'react';

/**
 * Dashboard pieces (task 7-5; doc 17 §3): a stat tile and a bar chart, server-rendered SVG with
 * no script and nothing fetched (rules 17–20). Every chart has its equivalent data table
 * (doc 17 §3), one axis, thin marks with a 4px rounded data end and a 2px gap, a native
 * tooltip per bar, and a legend for two series or more (identity never by color alone).
 */

/**
 * The series colors in fixed order, never cycled (dataviz method). Checked with its validator
 * against the panel's white surface: lightness band, chroma, colorblind separation (ΔE 26.1),
 * normal vision (ΔE 32.1) and 3:1 contrast all pass. The panel accent (#274C8C) is too dark
 * for the band. Text never wears these colors.
 */
export const CHART_SERIES = ['#3B6BC0', '#D97706'] as const;

export function StatTile({
  label,
  value,
  hint,
}: {
  label: string;
  value: ReactNode;
  hint?: ReactNode;
}) {
  return (
    <div className="space-y-1 rounded-lg border border-border bg-surface p-4">
      <dt className="text-[length:var(--text-sm)] text-ink-muted">{label}</dt>
      <dd className="text-[length:var(--text-xl)] font-bold text-ink">{value}</dd>
      {hint && <dd className="text-[length:var(--text-xs)] text-ink-subtle">{hint}</dd>}
    </div>
  );
}

export interface BarChartProps {
  /** Names the chart (its figure caption); a single series needs no legend. */
  readonly title: string;
  /** The categories along the axis, oldest first; drawn right to left (RTL). */
  readonly categories: readonly string[];
  readonly series: readonly { readonly label: string; readonly values: readonly number[] }[];
  /** A value as the reader reads it: the tooltip and the table. */
  readonly format: (value: number) => string;
  /** The axis's labels, if shorter than `format` (millions of tomans, say). */
  readonly axis?: (value: number) => string;
  /** Counts: the axis steps are whole numbers. */
  readonly integer?: boolean;
  /** The table's first column header. */
  readonly categoryHeader: string;
}

// Wide enough that the text stays near its set size on a desktop page; the axis is on the
// right, where an RTL reader starts.
const W = 960;
const H = 260;
const PAD = { top: 12, right: 112, bottom: 30, left: 8 };
const GAP = 2;
/** At most this many category labels along the axis; the rest are in the table. */
const MAX_LABELS = 8;

/** A bar whose top corners are rounded by 4px; anchored square on the baseline. */
function barPath(x: number, y: number, w: number, h: number): string {
  if (h <= 0) return '';
  const r = Math.min(4, w / 2, h);
  return `M${String(x)},${String(y + h)}V${String(y + r)}Q${String(x)},${String(y)} ${String(x + r)},${String(y)}H${String(x + w - r)}Q${String(x + w)},${String(y)} ${String(x + w)},${String(y + r)}V${String(y + h)}Z`;
}

/** Four round steps (1, 2 or 5 times a power of ten) up to at least the largest value. */
function axisSteps(max: number, integer: boolean): number[] {
  const raw = max / 4;
  const power = 10 ** Math.floor(Math.log10(raw));
  let step = ([1, 2, 5, 10].find((m) => m * power >= raw) ?? 10) * power;
  if (integer) step = Math.max(1, Math.ceil(step));
  const top = Math.ceil(max / step) * step;
  const ticks: number[] = [];
  for (let t = 0; t <= top + step / 2; t += step) ticks.push(t);
  return ticks;
}

export function BarChart({
  title,
  categories,
  series,
  format,
  axis,
  integer = false,
  categoryHeader,
}: BarChartProps) {
  const largest = Math.max(0, ...series.flatMap((s) => s.values));
  const ticks = largest > 0 ? axisSteps(largest, integer) : [0];
  const max = ticks[ticks.length - 1] || 1;
  const every = Math.ceil(categories.length / MAX_LABELS);
  const plotW = W - PAD.left - PAD.right;
  const plotH = H - PAD.top - PAD.bottom;
  const group = plotW / Math.max(1, categories.length);
  const barW = Math.max(
    4,
    Math.min(28, (group * 0.6 - GAP * (series.length - 1)) / Math.max(1, series.length)),
  );
  const y = (v: number) => PAD.top + plotH - (v / max) * plotH;
  const label = axis ?? format;
  return (
    <figure className="space-y-3 rounded-lg border border-border bg-surface p-4">
      <figcaption className="font-bold text-ink">{title}</figcaption>
      {series.length > 1 && (
        <ul className="flex flex-wrap gap-4 text-[length:var(--text-sm)] text-ink-muted">
          {series.map((s, i) => (
            <li key={s.label} className="flex items-center gap-2">
              <span
                aria-hidden="true"
                className="inline-block h-3 w-3 rounded-sm"
                style={{ backgroundColor: CHART_SERIES[i] }}
              />
              {s.label}
            </li>
          ))}
        </ul>
      )}
      {largest === 0 ? (
        <p className="text-[length:var(--text-sm)] text-ink-muted">در این بازه داده‌ای نیست.</p>
      ) : (
        <svg
          viewBox={`0 0 ${String(W)} ${String(H)}`}
          role="img"
          aria-label={`${title}؛ جدول داده در زیر`}
          className="h-auto w-full"
        >
          {ticks.map((t) => (
            <g key={t}>
              <line
                x1={PAD.left}
                x2={W - PAD.right}
                y1={y(t)}
                y2={y(t)}
                stroke="currentColor"
                className="text-border"
                strokeWidth={1}
              />
              <text
                x={W - 4}
                y={y(t) + 4}
                textAnchor="start"
                direction="rtl"
                fontSize={13}
                className="fill-ink-subtle"
              >
                {label(t)}
              </text>
            </g>
          ))}
          {categories.map((c, ci) => {
            // Right to left: the first (oldest) category at the right edge.
            const gx = PAD.left + plotW - (ci + 1) * group;
            const inner = series.length * barW + GAP * (series.length - 1);
            const start = gx + (group - inner) / 2;
            return (
              <g key={c}>
                {series.map((s, si) => {
                  const v = s.values[ci] ?? 0;
                  // RTL within the group too: the first series rightmost.
                  const x = start + inner - (si + 1) * barW - si * GAP;
                  const top = y(v);
                  return (
                    <path
                      key={s.label}
                      d={barPath(x, top, barW, PAD.top + plotH - top)}
                      fill={CHART_SERIES[si]}
                    >
                      <title>{`${c} — ${s.label}: ${format(v)}`}</title>
                    </path>
                  );
                })}
                {ci % every === 0 && (
                  <text
                    x={gx + group / 2}
                    y={H - 8}
                    textAnchor="middle"
                    fontSize={13}
                    className="fill-ink-muted"
                  >
                    {c}
                  </text>
                )}
              </g>
            );
          })}
        </svg>
      )}
      <details>
        <summary className="cursor-pointer text-[length:var(--text-sm)] text-accent">
          جدول داده
        </summary>
        <table className="mt-2 w-full text-[length:var(--text-sm)]">
          <caption className="sr-only">{title}</caption>
          <thead>
            <tr className="text-ink-muted">
              <th scope="col" className="p-2 text-start font-medium">
                {categoryHeader}
              </th>
              {series.map((s) => (
                <th key={s.label} scope="col" className="p-2 text-start font-medium">
                  {s.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {categories.map((c, ci) => (
              <tr key={c} className="border-t border-border">
                <th scope="row" className="p-2 text-start font-normal">
                  {c}
                </th>
                {series.map((s) => (
                  <td key={s.label} className="p-2">
                    {format(s.values[ci] ?? 0)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </details>
    </figure>
  );
}

/** A money axis's label: millions of tomans, one decimal at most (۲٫۵ میلیون تومان). */
export function millionTomans(rial: number): string {
  const millions = rial / 10 / 1_000_000;
  const text = Number.isInteger(millions) ? String(millions) : millions.toFixed(1);
  return `${text.replace('.', '٫').replace(/[0-9]/g, (d) => '۰۱۲۳۴۵۶۷۸۹'[Number(d)] ?? d)} میلیون تومان`;
}

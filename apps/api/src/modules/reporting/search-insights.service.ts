import { ForbiddenException, Inject, Injectable } from '@nestjs/common';
import { sql, type SQL } from 'drizzle-orm';
import type { EffectiveAccess } from '../../common/auth/access.port';
import { REPORTING_DATABASE, type ReportingDatabase } from '../../db/reporting.module';
import { rangeOf } from './report-definition';

/**
 * A filter of the public search as `search_entries` answers it (2-7's statement): the column
 * an index would serve and a sample condition to EXPLAIN. The price filters read the prices'
 * table, joined by entry; they are listed but not sampled here.
 */
interface FilterShape {
  readonly column: string | null;
  readonly sample: SQL | null;
  /** The index that would serve it, if none does: a suggestion, never run (doc 17 §6). */
  readonly suggestion: string | null;
}

const FILTERS: Readonly<Record<string, FilterShape>> = {
  cityCode: {
    column: 'city_code',
    sample: sql`e.city_code = 'sample'`,
    suggestion:
      'CREATE INDEX CONCURRENTLY search_entries_city_idx ON search_entries (city_code, next_free_slot_at) WHERE listed AND next_free_slot_at IS NOT NULL;',
  },
  fieldCode: {
    column: 'treatment_field_codes',
    sample: sql`e.treatment_field_codes @> ARRAY['sample']::text[]`,
    suggestion:
      'CREATE INDEX CONCURRENTLY search_entries_field_codes_idx ON search_entries USING gin (treatment_field_codes);',
  },
  serviceCode: {
    column: 'service_codes',
    sample: sql`e.service_codes @> ARRAY['sample']::text[]`,
    suggestion:
      'CREATE INDEX CONCURRENTLY search_entries_service_codes_idx ON search_entries USING gin (service_codes);',
  },
  doctorName: {
    column: 'doctor_name_key',
    sample: sql`e.doctor_name_key LIKE '%sample%'`,
    suggestion:
      'CREATE INDEX CONCURRENTLY search_entries_doctor_name_trgm ON search_entries USING gin (doctor_name_key gin_trgm_ops);',
  },
  centerName: {
    column: 'place_name_key',
    sample: sql`e.place_name_key LIKE '%sample%'`,
    suggestion:
      'CREATE INDEX CONCURRENTLY search_entries_place_name_trgm ON search_entries USING gin (place_name_key gin_trgm_ops);',
  },
  credit: {
    column: 'credit_enabled',
    sample: sql`e.credit_enabled`,
    suggestion:
      'CREATE INDEX CONCURRENTLY search_entries_credit_idx ON search_entries (next_free_slot_at) WHERE listed AND credit_enabled AND next_free_slot_at IS NOT NULL;',
  },
  freeBy: {
    column: 'next_free_slot_at',
    sample: sql`e.next_free_slot_at < now()`,
    suggestion:
      'CREATE INDEX CONCURRENTLY search_entries_next_free_idx ON search_entries (next_free_slot_at) WHERE listed AND next_free_slot_at IS NOT NULL;',
  },
  minPriceRial: { column: null, sample: null, suggestion: null },
  maxPriceRial: { column: null, sample: null, suggestion: null },
};

/** How many combinations the file lists, the most used first. */
const TOP_COMBINATIONS = 10;

const fa = (n: number | string): string =>
  String(n).replace(/[0-9]/g, (d) => '۰۱۲۳۴۵۶۷۸۹'[Number(d)] ?? d);

/**
 * The search log read for index suggestions (task 7-6; doc 17 §6): a Markdown file for a
 * reviewed migration. On the reporting connection, read only; it never creates an index.
 */
@Injectable()
export class SearchInsightsService {
  constructor(@Inject(REPORTING_DATABASE) private readonly reporting: ReportingDatabase) {}

  async markdown(access: EffectiveAccess, now = new Date()): Promise<string> {
    if (!access.permissions.has('reporting.read_search')) {
      throw new ForbiddenException({
        error: 'permission_required',
        permission: 'reporting.read_search',
      });
    }
    const range = rangeOf({ relative: 'last_30_days' }, now);
    const within = sql`created_at >= ${range.from.toISOString()} AND created_at < ${range.to.toISOString()}`;

    const combos = (
      await this.reporting.execute(sql`
        SELECT filter_combo, count(*)::int AS searches,
          round(avg(duration_ms))::int AS avg_ms,
          round(percentile_cont(0.95) WITHIN GROUP (ORDER BY duration_ms))::int AS p95_ms
        FROM search_query_log WHERE ${within}
        GROUP BY filter_combo ORDER BY searches DESC, filter_combo LIMIT ${TOP_COMBINATIONS}
      `)
    ).rows;
    const used = (
      await this.reporting.execute(sql`
        SELECT f AS filter, count(*)::int AS searches,
          round(percentile_cont(0.95) WITHIN GROUP (ORDER BY duration_ms))::int AS p95_ms
        FROM search_query_log, unnest(filters) AS f
        WHERE ${within}
        GROUP BY f ORDER BY searches DESC, f
      `)
    ).rows;
    const indexes = (
      await this.reporting.execute(sql`
        SELECT indexname, indexdef FROM pg_indexes
        WHERE schemaname = 'public' AND tablename = 'search_entries' ORDER BY indexname
      `)
    ).rows.map((r) => ({ name: String(r['indexname']), def: String(r['indexdef']) }));

    const lines: string[] = [
      '# پیشنهاد ایندکس جست‌وجو',
      '',
      `> ساخته‌شده ${now.toISOString()} از لاگ جست‌وجوی ۳۰ روز اخیر (سند ۱۷ §۶).`,
      '> **فقط پیشنهاد است.** هیچ ایندکسی خودکار ساخته نمی‌شود؛ هر پیشنهاد پس از بازبینی، در یک',
      '> مهاجرت افزودنی آورده می‌شود.',
      '',
      '## ترکیب‌های پرکاربرد',
      '',
    ];
    if (combos.length === 0) {
      lines.push('در این بازه جست‌وجویی ثبت نشده است.');
    } else {
      lines.push('| ترکیب | جست‌وجو | میانگین (ms) | صدک ۹۵ (ms) |', '|---|---|---|---|');
      for (const c of combos) {
        lines.push(
          `| \`${String(c['filter_combo'])}\` | ${fa(String(c['searches']))} | ${fa(String(c['avg_ms']))} | ${fa(String(c['p95_ms']))} |`,
        );
      }
    }

    lines.push('', '## ایندکس‌های موجود `search_entries`', '');
    for (const i of indexes) lines.push(`- \`${i.name}\`: \`${i.def}\``);

    lines.push('', '## فیلترهای به‌کاررفته', '');
    if (used.length === 0) lines.push('فیلتری به کار نرفته است.');
    const suggestions: string[] = [];
    for (const u of used) {
      const filter = String(u['filter']);
      const shape = FILTERS[filter];
      lines.push(
        `### \`${filter}\``,
        '',
        `- جست‌وجو: ${fa(String(u['searches']))}؛ صدک ۹۵: ${fa(String(u['p95_ms']))} ms`,
      );
      if (!shape?.column || !shape.sample) {
        lines.push(
          '- روی جدول قیمت‌ها (`search_entry_prices`) است؛ نمونه EXPLAIN گرفته نمی‌شود.',
          '',
        );
        continue;
      }
      const column = shape.column;
      // nosemgrep: detect-non-literal-regexp -- the pattern is built from code constants, never from user input (no ReDoS)
      const covering = indexes.filter((i) => new RegExp(`\\b${column}\\b`).test(i.def));
      lines.push(
        `- ستون: \`${column}\``,
        covering.length > 0
          ? `- ایندکس موجود: ${covering.map((i) => `\`${i.name}\``).join('، ')}`
          : '- ایندکس موجود: **ندارد**',
        '',
        '```',
        await this.explain(shape.sample),
        '```',
        '',
      );
      if (covering.length === 0 && shape.suggestion) suggestions.push(shape.suggestion);
    }

    lines.push('## پیشنهاد', '');
    if (suggestions.length === 0) {
      lines.push('هر فیلتر به‌کاررفته ایندکس متناظر دارد؛ پیشنهادی نیست.');
    } else {
      lines.push('```sql', ...suggestions, '```');
    }
    return `${lines.join('\n')}\n`;
  }

  /** The plan of a sample search on one filter; EXPLAIN only, nothing run. */
  private async explain(condition: SQL): Promise<string> {
    const rows = (
      await this.reporting.execute(sql`
        EXPLAIN SELECT e.workplace_id FROM search_entries e
        WHERE e.listed AND e.next_free_slot_at IS NOT NULL AND ${condition}
      `)
    ).rows;
    return rows.map((r) => String(r['QUERY PLAN'])).join('\n');
  }
}

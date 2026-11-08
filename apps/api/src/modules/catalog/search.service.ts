import {
  ForbiddenException,
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
  Logger,
} from '@nestjs/common';
import {
  fromJalali,
  gregorianToJalali,
  nextJalaliDay,
  SEARCH_FEATURED_LABEL,
  type SearchOrder,
  type SearchQuery,
  type SearchResponse,
  type SearchResult,
} from '@sepehr/contracts';
import { sql, type SQL } from 'drizzle-orm';
import type { Redis } from 'ioredis';
import { BOOKABLE_SLOTS, type BookableSlots } from '../../common/booking/bookable-slots.port';
import { CONFIG, type ConfigPort } from '../../common/config/config.port';
import { DATABASE, type Database } from '../../db/database.module';
import { REDIS } from '../../infra/redis.module';

const DEFAULT_PAGE_SIZE = 10;
const RATE_WINDOW_SECONDS = 60;

/** `%`, `_` and `\` are literal in a search term. */
const likeEscaped = (term: string) => term.replace(/[\\%_]/g, (c) => `\\${c}`);

/**
 * What of a term may reach the log (task 2-7, doc 08 §9): the public patient search logs
 * its phrase, but never personal data, so any run of five or more digits (a mobile, a
 * national ID) becomes #.
 */
export const loggableTerm = (term: string) => term.replace(/\d{5,}/g, '#').slice(0, 100);

/** The instant a Tehran day (Gregorian YYYY-MM-DD) ends: the next Tehran midnight. */
function endOfTehranDay(day: string): Date {
  const [year, month, date] = day.split('-').map(Number) as [number, number, number];
  return fromJalali(nextJalaliDay(gregorianToJalali({ year, month, day: date })));
}

/**
 * The public search of doctors and centers (task 2-7, doc 08 §9, ADR-028), behind the
 * `catalog.search_enabled` flag and a per-IP rate limit.
 *
 * - Reads only the index (search_entries): listed workplaces, whose center is active, with
 *   a free time within the booking horizon (a hint the refresher keeps current).
 * - Free text and names match the normalized keys with pg_trgm (substring, or word
 *   similarity for a misspelling); the order is the documented one (SEARCH_ORDERS) and
 *   nothing paid or featured changes it.
 * - The slots shown with each result are computed now through BOOKABLE_SLOTS, exactly as
 *   the booking page would; booking still decides when one is taken.
 * - The featured section is apart, labelled, and empty while nothing fills it.
 * - One structured log line per search: which filters, how many results, how long; the
 *   phrase itself only without long digit runs.
 */
@Injectable()
export class SearchService {
  private readonly logger = new Logger('Search');

  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(CONFIG) private readonly config: ConfigPort,
    @Inject(REDIS) private readonly redis: Redis,
    @Inject(BOOKABLE_SLOTS) private readonly slots: BookableSlots,
  ) {}

  async search(query: SearchQuery, ip: string | null, now = new Date()): Promise<SearchResponse> {
    const started = performance.now();
    const [enabled, featuredEnabled, policy] = await Promise.all([
      this.config.resolve('catalog.search_enabled'),
      this.config.resolve('catalog.search_featured_enabled'),
      this.config.resolve('catalog.search_policy'),
    ]);
    if (!enabled.value) throw new ForbiddenException({ error: 'feature_disabled' });
    if (!(await this.withinRate(ip ?? 'unknown', policy.value.perIpPerMinute))) {
      throw new HttpException({ error: 'rate_limited' }, HttpStatus.TOO_MANY_REQUESTS);
    }

    const page = query.page ?? 1;
    const pageSize = query.pageSize ?? DEFAULT_PAGE_SIZE;
    const order: SearchOrder = query.q === undefined ? 'soonest' : 'relevance';
    const { rows } = await this.db.execute(this.statement(query, order, page, pageSize));
    const total = rows.length === 0 ? 0 : Number(rows[0]?.['total']);
    const names = await this.pageNames(rows);

    const results: SearchResult[] = await Promise.all(
      rows.map(async (row) => {
        const workplaceId = String(row['workplace_id']);
        const slots =
          policy.value.slotsPerResult === 0
            ? []
            : await this.slots.upcoming(workplaceId, {
                limit: policy.value.slotsPerResult,
                now,
                ...(query.serviceCode === undefined ? {} : { serviceCode: query.serviceCode }),
              });
        const priceCode = row['price_service_code'] as string | null;
        const nextFree = row['next_free_slot_at'] as Date | string | null;
        return {
          workplaceId,
          doctor: { id: String(row['doctor_id']), name: String(row['doctor_name']) },
          profileSlug: names.slugs.get(String(row['doctor_id'])) ?? null,
          placeName: (row['place_name'] as string | null) ?? null,
          cityCode: String(row['city_code']),
          treatmentFields: row['treatment_fields'] as { code: string; name: string }[],
          price:
            priceCode === null
              ? null
              : {
                  serviceCode: priceCode,
                  serviceName: names.services.get(priceCode) ?? priceCode,
                  isFree: row['price_is_free'] === true,
                  minRial: String(row['price_min_rial']),
                  maxRial: String(row['price_max_rial']),
                },
          creditEnabled: row['credit_enabled'] === true,
          nextFreeSlotHintAt: nextFree === null ? null : new Date(nextFree).toISOString(),
          slots: slots.map((s) => ({
            startsAt: s.startsAt.toISOString(),
            endsAt: s.endsAt.toISOString(),
            serviceCodes: [...s.serviceCodes],
          })),
        };
      }),
    );

    const filters = Object.keys(query)
      .filter((k) => k !== 'q' && k !== 'page' && k !== 'pageSize')
      .sort();
    const ms = Math.round(performance.now() - started);
    this.logger.log(
      JSON.stringify({
        event: 'catalog.search',
        audience: 'public',
        order,
        filters,
        term: query.q === undefined ? null : loggableTerm(query.q),
        page,
        pageSize,
        total,
        returned: results.length,
        ms,
      }),
    );
    // Task 7-6 (doc 17 §6): kept for the search log's analysis, never the term itself; a
    // failure to keep it never fails the search.
    await this.db
      .execute(
        sql`
          INSERT INTO search_query_log (audience, order_by, filters, filter_combo, has_term,
            page, page_size, total, returned, duration_ms)
          VALUES ('public', ${order}, ${`{${filters.join(',')}}`}::text[],
            ${filters.length > 0 ? filters.join('+') : 'none'}, ${query.q !== undefined},
            ${page}, ${pageSize}, ${total}, ${results.length}, ${ms})
        `,
      )
      .catch((error: unknown) => {
        this.logger.warn(
          `search log not kept: ${error instanceof Error ? error.constructor.name : 'error'}`,
        );
      });

    return {
      order,
      page,
      pageSize,
      total,
      results,
      // TODO(decision): what fills the featured section; empty until then (decision 3).
      featured: featuredEnabled.value ? { label: SEARCH_FEATURED_LABEL, results: [] } : null,
    };
  }

  /**
   * What a page of results links to and shows besides the index: each doctor's published
   * profile address and the services' names. One small query for the page (at most
   * SEARCH_MAX_PAGE_SIZE rows), so the measured search query itself stays as it is.
   */
  private async pageNames(rows: readonly Record<string, unknown>[]) {
    const doctorIds = [...new Set(rows.map((r) => String(r['doctor_id'])))];
    const codes = [
      ...new Set(
        rows.map((r) => r['price_service_code']).filter((c): c is string => typeof c === 'string'),
      ),
    ];
    const slugs = new Map<string, string>();
    const services = new Map<string, string>();
    if (doctorIds.length > 0) {
      const { rows: found } = await this.db.execute(sql`
        SELECT doctor_id, slug FROM doctor_profiles
        WHERE published_version_id IS NOT NULL AND doctor_id IN ${doctorIds}
      `);
      for (const r of found) slugs.set(String(r['doctor_id']), String(r['slug']));
    }
    if (codes.length > 0) {
      const { rows: found } = await this.db.execute(
        sql`SELECT code, name FROM services WHERE deleted_at IS NULL AND code IN ${codes}`,
      );
      for (const r of found) services.set(String(r['code']), String(r['name']));
    }
    return { slugs, services };
  }

  /** The one query of a search page; EXPLAIN of it is part of the acceptance (doc 09). */
  statement(query: SearchQuery, order: SearchOrder, page: number, pageSize: number): SQL {
    const where: SQL[] = [sql`e.listed`, sql`e.next_free_slot_at IS NOT NULL`];
    if (query.q !== undefined) {
      where.push(
        sql`(e.search_key LIKE ${`%${likeEscaped(query.q)}%`} OR ${query.q} <% e.search_key)`,
      );
    }
    if (query.cityCode !== undefined) where.push(sql`e.city_code = ${query.cityCode}`);
    if (query.fieldCode !== undefined) {
      where.push(sql`e.treatment_field_codes @> ARRAY[${query.fieldCode}]::text[]`);
    }
    if (query.serviceCode !== undefined) {
      where.push(sql`e.service_codes @> ARRAY[${query.serviceCode}]::text[]`);
    }
    if (query.doctorName !== undefined) {
      where.push(sql`e.doctor_name_key LIKE ${`%${likeEscaped(query.doctorName)}%`}`);
    }
    if (query.centerName !== undefined) {
      where.push(sql`e.place_name_key LIKE ${`%${likeEscaped(query.centerName)}%`}`);
    }
    if (query.credit === 'true') where.push(sql`e.credit_enabled`);
    if (query.freeBy !== undefined) {
      where.push(sql`e.next_free_slot_at < ${endOfTehranDay(query.freeBy)}`);
    }
    if (query.minPriceRial !== undefined || query.maxPriceRial !== undefined) {
      where.push(sql`p.service_code IS NOT NULL`);
      if (query.minPriceRial !== undefined) {
        where.push(sql`p.max_amount_rial >= ${query.minPriceRial.toString()}::bigint`);
      }
      if (query.maxPriceRial !== undefined) {
        where.push(sql`p.min_amount_rial <= ${query.maxPriceRial.toString()}::bigint`);
      }
    }
    const priceOf =
      query.serviceCode === undefined
        ? sql`sp.is_visit`
        : sql`sp.service_code = ${query.serviceCode}`;
    const orderBy =
      order === 'relevance'
        ? sql`word_similarity(${query.q ?? ''}, e.search_key) DESC, e.next_free_slot_at, e.doctor_name_key, e.workplace_id`
        : sql`e.next_free_slot_at, e.doctor_name_key, e.workplace_id`;
    return sql`
      SELECT e.workplace_id, e.doctor_id, e.doctor_name, e.place_name, e.city_code,
             e.treatment_fields, e.credit_enabled, e.next_free_slot_at,
             p.service_code AS price_service_code, p.is_free AS price_is_free,
             p.min_amount_rial::text AS price_min_rial, p.max_amount_rial::text AS price_max_rial,
             count(*) OVER () AS total
      FROM search_entries e
      LEFT JOIN LATERAL (
        SELECT sp.service_code, sp.is_free, sp.min_amount_rial, sp.max_amount_rial
        FROM search_entry_prices sp
        WHERE sp.entry_id = e.id AND sp.offered AND ${priceOf}
        LIMIT 1
      ) p ON true
      WHERE ${sql.join(where, sql` AND `)}
      ORDER BY ${orderBy}
      LIMIT ${pageSize} OFFSET ${(page - 1) * pageSize}
    `;
  }

  /** Counts one search of this client in a fixed window; false once over the limit. */
  private async withinRate(ip: string, limit: number): Promise<boolean> {
    const key = `catalog:search:ip:${ip}`;
    const results = await this.redis
      .multi()
      .incr(key)
      .expire(key, RATE_WINDOW_SECONDS, 'NX')
      .exec();
    if (!results) throw new Error('rate limiter transaction was aborted');
    const [[error, count]] = results as [[Error | null, number]];
    if (error) throw error;
    return count <= limit;
  }
}

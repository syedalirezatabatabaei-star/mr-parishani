import * as z from 'zod';
import { normalizeDigits } from '../text/digits.js';
import { normalizePersianText } from '../text/persian.js';
import { rialAmountSchema } from './tariffs.js';

/**
 * The public search of doctors and centers (task 2-7, doc 08 §9, ADR-028).
 */

/**
 * The form in which text is indexed and searched: the rule-23 normalization (ی/ك and the
 * digits, doc 08 §15 test 12), then lower case, with a half-space treated as a space (so
 * «علی‌رضا» also finds «علی رضا») and one space between words. Applied both when an index
 * entry is written and to every search term, and nowhere else.
 */
export function searchKey(text: string): string {
  return normalizePersianText(text)
    .toLowerCase()
    .replace(/[‌\s]+/g, ' ')
    .trim();
}

/** Results per page, at most; each result also computes its live slots. */
export const SEARCH_MAX_PAGE_SIZE = 20;
export const SEARCH_MAX_PAGE = 50;

const code = z.string().regex(/^[a-z][a-z0-9_]{1,62}$/);
const term = z.string().max(200).transform(searchKey).pipe(z.string().min(2).max(100));
const positive = (max: number) =>
  z
    .string()
    .transform(normalizeDigits)
    .pipe(z.string().regex(/^[1-9][0-9]{0,3}$/))
    .transform(Number)
    .pipe(z.number().int().min(1).max(max));

/**
 * The query string of `GET /search/doctors`. Every text is normalized here (rule 23), so
 * «علي» and «علی», «۱۴۰۵» and «1405» are the same search. Prices are whole rials; tomans
 * exist only in the UI (rule 2).
 */
export const searchQuerySchema = z
  .object({
    /** Free text: a doctor's or center's name, a treatment field or service. */
    q: term.optional(),
    cityCode: code.optional(),
    fieldCode: code.optional(),
    /** The service to book; also the service whose price the price range filters. */
    serviceCode: code.optional(),
    doctorName: term.optional(),
    centerName: term.optional(),
    /** A price range that overlaps [minPriceRial, maxPriceRial] (the visit's by default). */
    minPriceRial: rialAmountSchema.optional(),
    maxPriceRial: rialAmountSchema.optional(),
    /** A free time on this Tehran day or earlier (Gregorian YYYY-MM-DD). */
    freeBy: z.iso.date().optional(),
    /** Only workplaces that take Sepehr credit. */
    credit: z.enum(['true', 'false']).optional(),
    page: positive(SEARCH_MAX_PAGE).optional(),
    pageSize: positive(SEARCH_MAX_PAGE_SIZE).optional(),
  })
  .refine(
    (q) =>
      q.minPriceRial === undefined ||
      q.maxPriceRial === undefined ||
      q.minPriceRial <= q.maxPriceRial,
    { message: 'minPriceRial must not exceed maxPriceRial', path: ['minPriceRial'] },
  );
export type SearchQuery = z.output<typeof searchQuerySchema>;

/**
 * The documented default order (doc 08 §9, «رتبه‌بندی شفاف»), never changed by payment or
 * placement:
 *
 * - `relevance` (with free text): how well the text matches (pg_trgm word similarity),
 *   then the earliest free time, then the doctor's name;
 * - `soonest` (without): the earliest free time, then the doctor's name.
 *
 * Ties end on the workplace id, so a page never repeats or skips a result.
 */
export const SEARCH_ORDERS = ['relevance', 'soonest'] as const;
export type SearchOrder = (typeof SEARCH_ORDERS)[number];

/** The label shown on the featured section (task 2-7 decision 3). */
export const SEARCH_FEATURED_LABEL = 'پیشنهاد سپهر';

const isoInstant = z.iso.datetime({ offset: true });
const rial = z.string().regex(/^\d+$/);

export const searchSlotSchema = z.object({
  startsAt: isoInstant,
  endsAt: isoInstant,
  serviceCodes: z.array(z.string()),
});
export type SearchSlot = z.infer<typeof searchSlotSchema>;

export const searchResultSchema = z.object({
  workplaceId: z.uuid(),
  /**
   * The doctor as on their public profile (doc 08 §10). Not `doctorName`: that name is the
   * treatment field class of doc 04 §4 (a patient's doctor), stripped from every response
   * of a caller without access.view_treatment.
   */
  doctor: z.object({ id: z.uuid(), name: z.string() }),
  /** The address of the doctor's published profile (`/doctors/<slug>`); null if none. */
  profileSlug: z.string().nullable(),
  /** The center's name; null for a private practice. */
  placeName: z.string().nullable(),
  cityCode: z.string(),
  treatmentFields: z.array(z.object({ code: z.string(), name: z.string() })),
  /** The visit's price, or the searched service's; whole rials as strings. */
  price: z
    .object({
      serviceCode: z.string(),
      serviceName: z.string(),
      isFree: z.boolean(),
      minRial: rial,
      maxRial: rial,
    })
    .nullable(),
  creditEnabled: z.boolean(),
  /**
   * The next free time as last indexed: a hint that may be minutes old. The slots below are
   * computed now and are what the patient can take (booking still decides, ADR-027).
   */
  nextFreeSlotHintAt: isoInstant.nullable(),
  slots: z.array(searchSlotSchema),
});
export type SearchResult = z.infer<typeof searchResultSchema>;

/** `GET /search/doctors`. */
export const searchResponseSchema = z.object({
  order: z.enum(SEARCH_ORDERS),
  page: z.int().positive(),
  pageSize: z.int().positive(),
  total: z.int().nonnegative(),
  results: z.array(searchResultSchema),
  /** The featured section, apart from the results and labelled; null while its flag is off. */
  featured: z.object({ label: z.string(), results: z.array(searchResultSchema) }).nullable(),
});
export type SearchResponse = z.infer<typeof searchResponseSchema>;

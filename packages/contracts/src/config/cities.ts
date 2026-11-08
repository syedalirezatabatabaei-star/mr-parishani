import * as z from 'zod';

/**
 * `GET /config/cities` (public): every city the system knows, with its Persian name (task
 * 2-11; ADR-010). `active`: the network works there, and the search offers it.
 */
export const cityListSchema = z.array(
  z.object({ code: z.string(), name: z.string(), active: z.boolean() }),
);
export type City = z.infer<typeof cityListSchema>[number];

/** A city's name from the list, else its code: a new city never breaks a page. */
export const cityNameIn = (list: readonly City[], code: string): string =>
  list.find((c) => c.code === code)?.name ?? code;

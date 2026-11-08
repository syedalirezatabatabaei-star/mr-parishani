/**
 * Smooth weighted round-robin (doc 05 §6: «نوبت‌دهی چرخشی وزن‌دار», never random). Every
 * pick, each eligible agent's running credit grows by their share; the one with the most
 * credit (the furthest behind their target) is picked, and pays the total share of those
 * eligible. Over any run the counts follow the shares to within one assignment per agent.
 *
 * Only eligible agents (present, below their cap, a share above zero) take part: someone
 * away gathers no credit, so after coming back they get their share, never a catch-up
 * (task 2-5b decision 4). Pure: the caller loads and stores the credits under a lock.
 */
export interface Contender {
  readonly accountId: string;
  /** Whole percent, 1..100. */
  readonly percent: number;
  /** Credit carried from earlier picks of the same version. */
  readonly credit: number;
}

export interface Pick {
  readonly accountId: string;
  /** Every contender's credit after this pick, to be stored. */
  readonly credits: ReadonlyMap<string, number>;
}

export function pickWeighted(contenders: readonly Contender[]): Pick | null {
  const eligible = contenders.filter((c) => c.percent > 0);
  if (eligible.length === 0) return null;
  const total = eligible.reduce((sum, c) => sum + c.percent, 0);
  const credits = new Map<string, number>();
  let best: { accountId: string; credit: number } | null = null;
  for (const c of eligible) {
    const credit = c.credit + c.percent;
    credits.set(c.accountId, credit);
    // Ties go to the smaller id, so a pick never depends on the order rows came in.
    if (
      best === null ||
      credit > best.credit ||
      (credit === best.credit && c.accountId < best.accountId)
    ) {
      best = { accountId: c.accountId, credit };
    }
  }
  if (best === null) return null;
  credits.set(best.accountId, best.credit - total);
  return { accountId: best.accountId, credits };
}

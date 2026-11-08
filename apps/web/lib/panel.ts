import { unwrap } from '@sepehr/api-client';
import type { ScopedWorkplace } from '@sepehr/contracts';
import { cache } from 'react';
import { one, type SearchParams } from './params';
import { serverApi } from './server-api';

/** The workplaces the signed-in staff member covers, once per request. */
export const getWorkplaces = cache(async (): Promise<ScopedWorkplace[]> => {
  const api = await serverApi();
  return unwrap(api.GET('/api/v1/catalog/workplaces'));
});

/** How a workplace is named in the panel: the doctor, and the place unless it is a practice. */
export const workplaceLabel = (w: ScopedWorkplace) =>
  [w.doctor.name, w.placeName, w.branchName && w.branchName !== w.placeName ? w.branchName : null]
    .filter(Boolean)
    .join(' · ');

/** The workplace the URL names (`?workplace=`), if the caller covers it; else the first. */
export function chosenWorkplace(
  workplaces: readonly ScopedWorkplace[],
  params: SearchParams,
): ScopedWorkplace | null {
  const wanted = one(params, 'workplace');
  return workplaces.find((w) => w.workplaceId === wanted) ?? workplaces[0] ?? null;
}

import { unwrap } from '@sepehr/api-client';
import { cityNameIn, type City } from '@sepehr/contracts';
import { cache } from 'react';
import { serverApi } from './server-api';

/** The cities (migration 0020), once per request; empty if the API cannot be reached. */
export const getCities = cache(async (): Promise<City[]> => {
  const api = await serverApi();
  return unwrap(api.GET('/api/v1/config/cities')).catch(() => []);
});

/** A function that names a city code, from the cities of this request. */
export async function cityNamer(): Promise<(code: string) => string> {
  const list = await getCities();
  return (code) => cityNameIn(list, code);
}

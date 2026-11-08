import { unwrap } from '@sepehr/api-client';
import { serverApi } from '../../../../lib/server-api';
import type { PricedService } from './proforma-editor';

/**
 * The services a workplace offers now, with the price in force: what a proforma line may
 * name (doc 10 §2 rule 2). A free or withdrawn service is not offered for credit.
 */
export async function pricedServices(workplaceId: string): Promise<PricedService[]> {
  const api = await serverApi();
  const [tariffs, services] = await Promise.all([
    unwrap(api.GET('/api/v1/catalog/tariffs', { params: { query: { workplaceId } } })),
    unwrap(api.GET('/api/v1/catalog/services')),
  ]);
  const priced: PricedService[] = [];
  for (const t of tariffs) {
    const v = t.current;
    if (!v || v.status === 'withdrawn' || v.isFree || !v.minAmountRial || !v.maxAmountRial)
      continue;
    priced.push({
      code: t.serviceCode,
      name: services.find((s) => s.code === t.serviceCode)?.name ?? t.serviceCode,
      minRial: v.minAmountRial,
      maxRial: v.maxAmountRial,
    });
  }
  return priced;
}

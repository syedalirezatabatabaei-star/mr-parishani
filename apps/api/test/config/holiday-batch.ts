import { gregorianDayOf, type JalaliDate } from '@sepehr/contracts';
import { call, type Harness, type LoggedInAccount } from '../identity/harness';

type Body = Record<string, unknown>;

/**
 * A holiday as it is saved now (owner 1405/07/27): no single-day path, a batch of one day asked
 * by `asker` and approved by `approver`, two holders of config.manage_holidays (ADR-043). The
 * answer is the saved holiday (201), or the refusal of the asking or the approving; a batch
 * refused on approval is rejected, so the year has no open batch left behind.
 */
export async function addHolidayByBatch(
  h: Harness,
  asker: LoggedInAccount,
  approver: LoggedInAccount,
  input: { on: JalaliDate; title?: string; cityCode?: string; reason?: string },
): Promise<{ status: number; body: Body }> {
  const asked = await call(h, 'POST', '/calendar/holidays/batches', {
    bearer: asker.access,
    body: {
      year: input.on.year,
      days: [
        {
          on: input.on,
          title: input.title ?? 'تعطیلی آزمون',
          ...(input.cityCode ? { cityCode: input.cityCode } : {}),
        },
      ],
      reason: input.reason ?? 'تقویم رسمی',
    },
  });
  if (asked.status !== 201) return asked;
  const id = asked.body['id'] as string;
  const approved = await call(h, 'POST', `/calendar/holidays/batches/${id}/approve`, {
    bearer: approver.access,
  });
  if (approved.status !== 201) {
    await call(h, 'POST', `/calendar/holidays/batches/${id}/reject`, { bearer: approver.access });
    return approved;
  }
  const on = gregorianDayOf(input.on);
  const city = input.cityCode ? `&cityCode=${input.cityCode}` : '';
  const listed = await call(h, 'GET', `/calendar/holidays?from=${on}&to=${on}${city}`);
  const saved = (listed.body as unknown as Body[]).find(
    (d) => d['on'] === on && (d['cityCode'] ?? null) === (input.cityCode ?? null),
  );
  if (!saved) throw new Error('the approved holiday is not listed');
  return { status: 201, body: saved };
}

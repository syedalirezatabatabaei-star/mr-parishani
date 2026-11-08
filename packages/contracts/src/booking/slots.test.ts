import { describe, expect, it } from 'vitest';
import { createExceptionSchema, replaceScheduleSchema, slotQuerySchema } from './schedule.js';
import { computeSlots, type DayException, type SlotInput, type WeeklyRange } from './slots.js';

// 1405/07/04 = Saturday 26 September 2026; Tehran is UTC+03:30 all year since 2022.
const SATURDAY = '2026-09-26';
const SUNDAY = '2026-09-27';
const FRIDAY = '2026-10-02';

const range = (
  weekday: WeeklyRange['weekday'],
  start: number,
  end: number,
  slotMinutes = 30,
): WeeklyRange => ({
  weekday,
  startMinute: start * 60,
  endMinute: end * 60,
  slotMinutes,
  serviceCodes: ['visit'],
});

const exception = (on: string, kind: DayException['kind'], extra: Partial<DayException> = {}) => ({
  on,
  kind,
  startMinute: null,
  endMinute: null,
  slotMinutes: null,
  serviceCodes: [],
  ...extra,
});

const slots = (input: Partial<SlotInput>) =>
  computeSlots({
    from: SATURDAY,
    to: SATURDAY,
    cityCode: 'tehran',
    weekly: [range('saturday', 8, 10)],
    exceptions: [],
    holidays: [],
    busy: [],
    notBefore: new Date('2026-01-01T00:00:00Z'),
    notAfter: new Date('2027-01-01T00:00:00Z'),
    ...input,
  }).map((s) => s.startsAt.toISOString());

describe('computeSlots', () => {
  it('cuts the weekly schedule into slots at Tehran wall-clock times', () => {
    const result = computeSlots({
      from: SATURDAY,
      to: SATURDAY,
      cityCode: 'tehran',
      weekly: [range('saturday', 8, 10)],
      exceptions: [],
      holidays: [],
      busy: [],
      notBefore: new Date('2026-01-01T00:00:00Z'),
      notAfter: new Date('2027-01-01T00:00:00Z'),
    });
    expect(result.map((s) => [s.startsAt.toISOString(), s.endsAt.toISOString()])).toEqual([
      ['2026-09-26T04:30:00.000Z', '2026-09-26T05:00:00.000Z'],
      ['2026-09-26T05:00:00.000Z', '2026-09-26T05:30:00.000Z'],
      ['2026-09-26T05:30:00.000Z', '2026-09-26T06:00:00.000Z'],
      ['2026-09-26T06:00:00.000Z', '2026-09-26T06:30:00.000Z'],
    ]);
    expect(result[0]?.serviceCodes).toEqual(['visit']);
  });

  it('a holiday gives no slot unless the doctor opened it (doc 08 §15 test 3)', () => {
    const national = [{ on: SATURDAY, cityCode: null }];
    expect(slots({ holidays: national })).toEqual([]);
    expect(
      slots({ holidays: national, exceptions: [exception(SATURDAY, 'open_holiday')] }),
    ).toHaveLength(4);
    // A holiday of the workplace's city closes it too; another city's does not.
    expect(slots({ holidays: [{ on: SATURDAY, cityCode: 'tehran' }] })).toEqual([]);
    expect(slots({ holidays: [{ on: SATURDAY, cityCode: 'tabriz' }] })).toHaveLength(4);
  });

  it('the system’s weekly days off do not close a doctor’s schedule (task 2-5 decision)', () => {
    expect(slots({ from: FRIDAY, to: FRIDAY, weekly: [range('friday', 9, 10)] })).toEqual([
      '2026-10-02T05:30:00.000Z',
      '2026-10-02T06:00:00.000Z',
    ]);
  });

  it('closed takes the day or a range out; extra adds hours, even on a holiday', () => {
    expect(slots({ exceptions: [exception(SATURDAY, 'closed')] })).toEqual([]);
    expect(
      slots({ exceptions: [exception(SATURDAY, 'closed', { startMinute: 510, endMinute: 570 })] }),
    ).toEqual(['2026-09-26T04:30:00.000Z', '2026-09-26T06:00:00.000Z']);
    const evening = exception(SATURDAY, 'extra', {
      startMinute: 18 * 60,
      endMinute: 19 * 60,
      slotMinutes: 60,
      serviceCodes: ['implant'],
    });
    expect(slots({ exceptions: [exception(SATURDAY, 'closed'), evening] })).toEqual([
      '2026-09-26T14:30:00.000Z',
    ]);
    expect(slots({ holidays: [{ on: SATURDAY, cityCode: null }], exceptions: [evening] })).toEqual([
      '2026-09-26T14:30:00.000Z',
    ]);
  });

  it('where extra hours meet the weekly schedule, the schedule wins', () => {
    const overlapping = exception(SATURDAY, 'extra', {
      startMinute: 9 * 60,
      endMinute: 11 * 60,
      slotMinutes: 60,
      serviceCodes: ['implant'],
    });
    const result = computeSlots({
      from: SATURDAY,
      to: SATURDAY,
      cityCode: 'tehran',
      weekly: [range('saturday', 8, 10)],
      exceptions: [overlapping],
      holidays: [],
      busy: [],
      notBefore: new Date('2026-01-01T00:00:00Z'),
      notAfter: new Date('2027-01-01T00:00:00Z'),
    });
    expect(result.map((s) => [s.startsAt.toISOString(), s.serviceCodes[0]])).toEqual([
      ['2026-09-26T04:30:00.000Z', 'visit'],
      ['2026-09-26T05:00:00.000Z', 'visit'],
      ['2026-09-26T05:30:00.000Z', 'visit'],
      ['2026-09-26T06:00:00.000Z', 'visit'],
      ['2026-09-26T06:30:00.000Z', 'implant'],
    ]);
  });

  it('days are Tehran days at midnight, not UTC ones (doc 08 §15 test 13)', () => {
    const weekly = [range('saturday', 22, 24, 60), range('sunday', 0, 2, 60)];
    // Tehran's Sunday 00:00 is still Saturday 20:30 in UTC.
    expect(slots({ from: SATURDAY, to: SUNDAY, weekly })).toEqual([
      '2026-09-26T18:30:00.000Z',
      '2026-09-26T19:30:00.000Z',
      '2026-09-26T20:30:00.000Z',
      '2026-09-26T21:30:00.000Z',
    ]);
    // A holiday on Tehran's Sunday closes exactly Sunday's slots, which UTC calls Saturday.
    expect(
      slots({ from: SATURDAY, to: SUNDAY, weekly, holidays: [{ on: SUNDAY, cityCode: null }] }),
    ).toEqual(['2026-09-26T18:30:00.000Z', '2026-09-26T19:30:00.000Z']);
    // Asking for Sunday alone gives Sunday's slots, though they start on a UTC Saturday.
    expect(slots({ from: SUNDAY, to: SUNDAY, weekly })).toEqual([
      '2026-09-26T20:30:00.000Z',
      '2026-09-26T21:30:00.000Z',
    ]);
    // A range ending at 24:00 ends at the next Tehran midnight.
    const [late] = computeSlots({
      from: SATURDAY,
      to: SATURDAY,
      cityCode: 'tehran',
      weekly: [range('saturday', 23, 24, 60)],
      exceptions: [],
      holidays: [],
      busy: [],
      notBefore: new Date(0),
      notAfter: new Date('2027-01-01T00:00:00Z'),
    });
    expect(late?.endsAt.toISOString()).toBe('2026-09-26T20:30:00.000Z');
  });

  it('leaves out the past, what lies beyond the horizon, and busy time', () => {
    expect(slots({ notBefore: new Date('2026-09-26T05:00:00Z') })).toEqual([
      '2026-09-26T05:00:00.000Z',
      '2026-09-26T05:30:00.000Z',
      '2026-09-26T06:00:00.000Z',
    ]);
    expect(slots({ notAfter: new Date('2026-09-26T05:00:00Z') })).toEqual([
      '2026-09-26T04:30:00.000Z',
    ]);
    expect(
      slots({
        busy: [
          { startsAt: new Date('2026-09-26T04:45:00Z'), endsAt: new Date('2026-09-26T05:15:00Z') },
        ],
      }),
    ).toEqual(['2026-09-26T05:30:00.000Z', '2026-09-26T06:00:00.000Z']);
  });

  it('a month of a full schedule is computed well within the budget', () => {
    const weekly = (
      ['saturday', 'sunday', 'monday', 'tuesday', 'wednesday', 'thursday'] as const
    ).flatMap((weekday) => [range(weekday, 8, 13, 15), range(weekday, 16, 21, 15)]);
    const started = performance.now();
    const result = computeSlots({
      from: '2026-10-01',
      to: '2026-10-31',
      cityCode: 'tehran',
      weekly,
      exceptions: [exception('2026-10-10', 'closed')],
      holidays: [{ on: '2026-10-15', cityCode: null }],
      busy: [],
      notBefore: new Date(0),
      notAfter: new Date('2027-01-01T00:00:00Z'),
    });
    expect(performance.now() - started).toBeLessThan(50);
    // 31 days, 5 Fridays with no schedule, one closed day and one holiday: 24 days × 40.
    expect(result).toHaveLength(24 * 40);
  });
});

describe('calendar requests', () => {
  it('reads HH:MM times, Persian digits included, and needs whole slots', () => {
    const parsed = replaceScheduleSchema.parse({
      ranges: [
        {
          weekday: 'saturday',
          start: '۰۸:۰۰',
          end: '24:00',
          slotMinutes: 30,
          serviceCodes: ['visit'],
        },
      ],
      reason: 'برنامه هفتگی',
    });
    expect(parsed.ranges[0]).toMatchObject({ start: 480, end: 1440 });
    const uneven = replaceScheduleSchema.safeParse({
      ranges: [
        {
          weekday: 'saturday',
          start: '08:00',
          end: '09:10',
          slotMinutes: 30,
          serviceCodes: ['visit'],
        },
      ],
      reason: 'برنامه هفتگی',
    });
    expect(uneven.success).toBe(false);
    expect(
      replaceScheduleSchema.safeParse({
        ranges: [
          {
            weekday: 'saturday',
            start: '24:30',
            end: '25:00',
            slotMinutes: 30,
            serviceCodes: ['visit'],
          },
        ],
        reason: 'برنامه هفتگی',
      }).success,
    ).toBe(false);
  });

  it('a closed range needs both ends or neither', () => {
    const on = { year: 1405, month: 7, day: 4 };
    expect(createExceptionSchema.safeParse({ kind: 'closed', on, reason: 'مرخصی' }).success).toBe(
      true,
    );
    expect(
      createExceptionSchema.safeParse({ kind: 'closed', on, start: '10:00', reason: 'مرخصی' })
        .success,
    ).toBe(false);
  });

  it('limits a slot request to two months', () => {
    expect(slotQuerySchema.safeParse({ from: '2026-10-01', to: '2026-12-01' }).success).toBe(true);
    expect(slotQuerySchema.safeParse({ from: '2026-10-01', to: '2026-12-02' }).success).toBe(false);
    expect(slotQuerySchema.safeParse({ from: '2026-10-02', to: '2026-10-01' }).success).toBe(false);
  });
});

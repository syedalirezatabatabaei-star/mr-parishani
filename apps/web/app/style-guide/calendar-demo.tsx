'use client';

import { addJalaliDays, gregorianDayOf, toJalali, type JalaliDate } from '@sepehr/contracts';
import { Calendar, DateField, type Capacity, type DateRange, type DaySlot } from '@sepehr/ui';
import { useMemo, useState } from 'react';

/** Sample data for the style guide only: capacities and times around today. */
function sample(today: JalaliDate) {
  const capacity: Record<string, Capacity> = {};
  const slots: Record<string, DaySlot[]> = {};
  const levels: Capacity[] = ['free', 'limited', 'full', 'free', 'free', 'limited', 'free'];
  for (let i = 1; i <= 21; i++) {
    const day = addJalaliDays(today, i);
    const key = gregorianDayOf(day);
    capacity[key] = levels[i % levels.length] ?? 'free';
    slots[key] = ['09:00', '09:30', '10:00', '10:30', '11:00'].map((time, j) => ({
      startsAt: `${key}T${time}`,
      time,
      available: (i + j) % 3 !== 0,
    }));
  }
  return { capacity, slots, holiday: gregorianDayOf(addJalaliDays(today, 4)) };
}

export function CalendarDemo() {
  const today = useMemo(() => toJalali(new Date()), []);
  const { capacity, slots, holiday } = useMemo(() => sample(today), [today]);
  const holidays = [{ on: holiday, title: 'تعطیلی نمونه' }];
  const [day, setDay] = useState<JalaliDate | null>(null);
  const [picked, setPicked] = useState<string | null>(null);
  const [range, setRange] = useState<DateRange | null>(null);
  const [birth, setBirth] = useState<JalaliDate | null>(null);

  return (
    <div className="grid gap-6 xl:grid-cols-2">
      <div data-tone="patient" className="space-y-3 rounded-lg bg-canvas p-6">
        <h3 className="text-[length:var(--text-md)] font-bold text-ink">
          نوبت‌دهی بیمار (ظرفیت و ساعت)
        </h3>
        <Calendar
          mode="single"
          label="تاریخ نوبت"
          value={day}
          today={today}
          min={today}
          holidays={holidays}
          capacity={capacity}
          slots={slots}
          onChange={(d) => {
            setDay(d);
            setPicked(null);
          }}
          onPickTime={(s) => {
            setPicked(s.time);
          }}
        />
        <p className="text-[length:var(--text-sm)] text-ink-muted" aria-live="polite">
          {picked ? `ساعت انتخاب‌شده: ${picked}` : 'یک روز و سپس یک ساعت را انتخاب کنید.'}
        </p>
        <DateField
          mode="single"
          label="تاریخ تولد (ورود دستی)"
          value={birth}
          today={today}
          onChange={setBirth}
        />
      </div>
      <div data-tone="panel" className="space-y-3 rounded-lg bg-canvas p-6">
        <h3 className="text-[length:var(--text-md)] font-bold text-ink">
          تقویم مرکز (ماه، هفته، روز) و بازه گزارش
        </h3>
        <Calendar
          mode="single"
          label="تقویم مرکز"
          value={day}
          today={today}
          views={['month', 'week', 'day']}
          holidays={holidays}
          slots={slots}
          onChange={setDay}
        />
        <Calendar
          mode="range"
          shortcuts
          label="بازه گزارش"
          value={range}
          today={today}
          holidays={holidays}
          onChange={setRange}
        />
        <DateField
          mode="range"
          label="بازه (ورود دستی)"
          value={range}
          today={today}
          onChange={setRange}
        />
      </div>
    </div>
  );
}

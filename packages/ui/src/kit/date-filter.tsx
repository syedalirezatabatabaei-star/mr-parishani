'use client';

import type { JalaliDate } from '@sepehr/contracts';
import { useState } from 'react';
import { DateField } from '../calendar/date-field.js';
import type { DateRange, HolidayMark } from '../calendar/model.js';
import { jalaliParam } from './format.js';

interface Common {
  readonly label: string;
  readonly today: JalaliDate;
  readonly holidays?: readonly HolidayMark[];
  readonly min?: JalaliDate;
  readonly max?: JalaliDate;
  readonly hint?: string;
}

export type DateFilterProps =
  | (Common & {
      readonly mode: 'single';
      readonly name: string;
      readonly defaultValue: JalaliDate | null;
    })
  | (Common & {
      readonly mode: 'range';
      /** The two query keys, e.g. `{ from: 'from', to: 'to' }`. */
      readonly names: { readonly from: string; readonly to: string };
      readonly defaultValue: DateRange | null;
    });

/** The shared DateField inside a GET form (FilterBar): the value travels as hidden fields. */
export function DateFilter(props: DateFilterProps) {
  const { label, today, holidays, min, max, hint } = props;
  const common = {
    label,
    today,
    ...(holidays ? { holidays } : {}),
    ...(min ? { min } : {}),
    ...(max ? { max } : {}),
    ...(hint !== undefined ? { hint } : {}),
  };
  // nosemgrep: react-props-in-state -- the initial value of an uncontrolled field, by design
  const [single, setSingle] = useState(props.mode === 'single' ? props.defaultValue : null);
  // nosemgrep: react-props-in-state -- the initial value of an uncontrolled field, by design
  const [range, setRange] = useState(props.mode === 'range' ? props.defaultValue : null);

  if (props.mode === 'single') {
    return (
      <div className="min-w-56">
        <DateField mode="single" value={single} onChange={setSingle} {...common} />
        {single && <input type="hidden" name={props.name} value={jalaliParam(single)} />}
      </div>
    );
  }
  return (
    <div className="min-w-72">
      <DateField mode="range" value={range} onChange={setRange} {...common} />
      {range && (
        <>
          <input type="hidden" name={props.names.from} value={jalaliParam(range.from)} />
          <input type="hidden" name={props.names.to} value={jalaliParam(range.to)} />
        </>
      )}
    </div>
  );
}

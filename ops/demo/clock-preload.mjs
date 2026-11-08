// The demo stack's clock (owner 1405/08/07), loaded into the API, the worker, the two web apps
// and the seed with `node --import`: Date reads the same offset, in seconds, as the database's
// libfaketime (ops/demo/clock/faketimerc, e.g. "-15552000" or "+0"), so the application and
// the database agree on "now" while the seed writes six months of history through the real
// services. Demo only; it is never loaded unless DEMO_CLOCK_FILE is set.
import { readFileSync } from 'node:fs';

const file = process.env.DEMO_CLOCK_FILE;
if (file) {
  const RealDate = Date;
  const realNow = RealDate.now.bind(RealDate);
  let offsetMs = 0;
  let readAt = -Infinity;
  const offset = () => {
    const at = realNow();
    // Re-read at most twice a second: the seed moves the clock between steps, not within one.
    if (at - readAt > 500) {
      readAt = at;
      try {
        const seconds = Number(readFileSync(file, 'utf8').trim());
        offsetMs = Number.isFinite(seconds) ? seconds * 1000 : 0;
      } catch {
        offsetMs = 0;
      }
    }
    return offsetMs;
  };
  const now = () => realNow() + offset();

  class DemoDate extends RealDate {
    constructor(...args) {
      if (args.length === 0) super(now());
      else super(...args);
    }
    static now() {
      return now();
    }
    // Dates made by Node itself (structuredClone, fs) are still dates to `instanceof Date`.
    static [Symbol.hasInstance](value) {
      return value instanceof RealDate;
    }
  }
  // Date.UTC and Date.parse as its own: Next.js wraps Date by copying the own properties only
  // (next/dist/server/node-environment-extensions/date.js), so inherited ones were lost there.
  for (const key of ['UTC', 'parse'])
    Object.defineProperty(DemoDate, key, Object.getOwnPropertyDescriptor(RealDate, key));
  // A call without `new` returns the current time as text, as Date does.
  const Demo = new Proxy(DemoDate, {
    apply: () => new RealDate(now()).toString(),
  });
  globalThis.Date = Demo;
}

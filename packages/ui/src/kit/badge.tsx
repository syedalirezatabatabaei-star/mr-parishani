import { faDigits } from './format.js';

/** A count as a small badge; its item's name carries it for screen readers (`itemName`). */
export function CountBadge({ count, className = '' }: { count: number; className?: string }) {
  return (
    <span
      aria-hidden="true"
      className={`figures inline-flex min-w-5 items-center justify-center rounded-full bg-highlight px-1.5 text-[length:var(--text-xs)] leading-5 font-bold text-on-highlight ${className}`}
    >
      {faDigits(count > 99 ? '99+' : count)}
    </span>
  );
}

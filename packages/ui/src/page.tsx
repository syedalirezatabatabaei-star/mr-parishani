import type { ReactNode } from 'react';

export interface PageProps {
  title: string;
  children?: ReactNode;
}

/** Page shell shared by web and admin. Layout direction comes from the root `dir="rtl"`. */
export function Page({ title, children }: PageProps) {
  return (
    <main>
      <h1>{title}</h1>
      {children}
    </main>
  );
}

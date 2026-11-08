import type { Metadata } from 'next';
import { connection } from 'next/server';
import type { ReactNode } from 'react';
import { displayFont, textFont } from './fonts';
import './globals.css';

export const metadata: Metadata = {
  title: 'سپهر سلامتی',
};

// Fonts are self-hosted only; never next/font/google (CLAUDE.md rule 18).
export default async function RootLayout({ children }: { children: ReactNode }) {
  // Every page per request: the CSP nonce of proxy.ts reaches only pages rendered at request
  // time, never prerendered ones (rules 17–20).
  await connection();
  return (
    <html lang="fa" dir="rtl" className={`${textFont.variable} ${displayFont.variable}`}>
      <body>{children}</body>
    </html>
  );
}

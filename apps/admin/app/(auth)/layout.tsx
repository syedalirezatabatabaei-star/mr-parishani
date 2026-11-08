import { ApiProvider } from '@sepehr/ui';
import type { ReactNode } from 'react';

/** Signing in to the internal panel: the page draws its own frame (`AuthFrame`). */
export default function AuthLayout({ children }: { children: ReactNode }) {
  return <ApiProvider csrfToken={null}>{children}</ApiProvider>;
}

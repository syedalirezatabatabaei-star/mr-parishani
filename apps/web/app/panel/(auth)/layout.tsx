import { ApiProvider } from '@sepehr/ui';
import type { ReactNode } from 'react';

/** Signing in to the center panel: the page draws its own frame (`AuthFrame`). */
export default function PanelAuthLayout({ children }: { children: ReactNode }) {
  return <ApiProvider csrfToken={null}>{children}</ApiProvider>;
}

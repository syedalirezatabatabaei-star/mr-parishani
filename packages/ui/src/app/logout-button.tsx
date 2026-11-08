'use client';

import { authApi } from '@sepehr/api-client';
import { buttonClass } from '../kit/controls.js';
import { useState } from 'react';
import { useApi } from './browser-api.js';

/** Ends this session on the server, then goes to `to` with a fresh page. */
export function LogoutButton({ to }: { to: string }) {
  const auth = authApi(useApi());
  const [busy, setBusy] = useState(false);
  return (
    <button
      type="button"
      disabled={busy}
      className={buttonClass('quiet')}
      onClick={() => {
        setBusy(true);
        // Even if the server could not be reached, the visitor asked to leave.
        void auth
          .logout()
          .catch(() => undefined)
          .finally(() => {
            window.location.assign(to);
          });
      }}
    >
      خروج
    </button>
  );
}

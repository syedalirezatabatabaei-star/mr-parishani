'use client';

import { createApiClient, type ApiClient } from '@sepehr/api-client';
import { createContext, useContext, useMemo, type ReactNode } from 'react';
import { reauthFetch, ReauthDialog, useReauthPrompt } from './reauth.js';
import { stepUpFetch, StepUpDialog, useStepUpPrompt } from './step-up.js';

const CsrfContext = createContext<string | null>(null);

/**
 * Gives the client components below it the session's CSRF token (from the server page), and
 * the «confirm it is you» dialog a sensitive action asks for (task 9-3, R1).
 */
export function ApiProvider({
  csrfToken,
  children,
}: {
  csrfToken: string | null;
  children: ReactNode;
}) {
  return (
    <CsrfContext value={csrfToken}>
      <ReauthDialog csrfToken={csrfToken}>
        <StepUpDialog csrfToken={csrfToken}>{children}</StepUpDialog>
      </ReauthDialog>
    </CsrfContext>
  );
}

/**
 * The API from the browser: this app's own origin (base URL '', paths start /api/v1, rewritten to the API), with
 * the CSRF token on every state-changing request. `csrfToken` overrides the context, for the
 * request right after sign-in. Under an {@link ApiProvider}, an action refused for want of a
 * fresh TOTP code asks for one and is sent again, once (task 9-3, R1).
 */
export function useApi(csrfToken?: string | null): ApiClient {
  const fromContext = useContext(CsrfContext);
  const prompt = useReauthPrompt();
  const stepUp = useStepUpPrompt();
  const token = csrfToken ?? fromContext;
  return useMemo(
    () =>
      createApiClient({
        baseUrl: '',
        csrfToken: () => token,
        // ADR-052: a financial signature asks for its SMS code; then a fresh TOTP if needed.
        ...(prompt || stepUp ? { fetch: stepUpFetch(stepUp, reauthFetch(prompt)) } : {}),
      }),
    [token, prompt, stepUp],
  );
}

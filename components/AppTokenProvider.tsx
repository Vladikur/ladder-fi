'use client';

import { createContext, useContext } from 'react';

const AppTokenContext = createContext<string>('');

/**
 * The APP_TOKEN CSRF secret (TZ §5) is embedded server-side into this page's initial
 * render (see app/layout.tsx, a Server Component that reads it from getServerEnv()).
 * Same-origin policy means another origin's page cannot read our DOM/React tree to
 * extract it, which is exactly the threat this token defends against; our own client
 * code reads it from context and attaches it to every mutating fetch.
 */
export function AppTokenProvider({ token, children }: { token: string; children: React.ReactNode }) {
  return <AppTokenContext.Provider value={token}>{children}</AppTokenContext.Provider>;
}

export function useAppToken(): string {
  return useContext(AppTokenContext);
}

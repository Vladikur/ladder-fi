import type { Metadata } from 'next';
import './globals.css';
import { getServerEnv } from '@/lib/env';
import { AppTokenProvider } from '@/components/AppTokenProvider';
import { QueryProvider } from '@/components/QueryProvider';

export const metadata: Metadata = {
  title: 'Liquidity Ladder',
  description: 'Bid-Ask concentrated liquidity ladders for Robinhood Chain',
};

// APP_TOKEN is a secret read at render time (see below) - if this page were statically
// prerendered at build time, that value would be baked into the static HTML and would
// silently go stale for anyone who builds once and injects APP_TOKEN at deploy/runtime
// (the standard container pattern). Forcing dynamic rendering keeps it correct.
export const dynamic = 'force-dynamic';

export default function RootLayout({ children }: { children: React.ReactNode }) {
  // Reading the server env here (a Server Component) is what lets the CSRF token reach
  // the browser without ever being a NEXT_PUBLIC_ variable - see AppTokenProvider.
  const appToken = getServerEnv().APP_TOKEN;

  return (
    <html lang="en">
      <body>
        <QueryProvider>
          <AppTokenProvider token={appToken}>{children}</AppTokenProvider>
        </QueryProvider>
      </body>
    </html>
  );
}

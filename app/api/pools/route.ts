import 'server-only';
import { jsonResponse } from '@/lib/json';
import { assertRequestAuthorized, CsrfError } from '@/lib/guards/csrf';
import { assertRateLimited, RateLimitError } from '@/lib/guards/rate-limit';
import { fetchGeckoTerminalPools } from '@/lib/geckoterminal';

/** Proxies GeckoTerminal's public pools API server-side - see lib/geckoterminal.ts for
 *  why (CORS, shared caching). Used by the /pools discovery page, not by anything on
 *  the plan/execute path. */
export async function GET(request: Request) {
  try {
    assertRequestAuthorized(request);
    assertRateLimited(request, 'pools');
  } catch (err) {
    if (err instanceof CsrfError) return jsonResponse({ error: err.message }, { status: 401 });
    if (err instanceof RateLimitError) {
      return jsonResponse({ error: err.message }, { status: 429, headers: { 'Retry-After': String(Math.ceil(err.retryAfterMs / 1000)) } });
    }
    throw err;
  }

  try {
    const pools = await fetchGeckoTerminalPools();
    return jsonResponse({ pools });
  } catch (err) {
    return jsonResponse({ error: err instanceof Error ? err.message : 'Failed to fetch pools' }, { status: 502 });
  }
}

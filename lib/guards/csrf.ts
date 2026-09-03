import 'server-only';
import { getServerEnv } from '@/lib/env';

export class CsrfError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CsrfError';
  }
}

/**
 * TZ §5: any page open in the browser can POST to localhost and trigger signing. Both
 * checks are required, not either/or: Origin/Sec-Fetch-Site rejects cross-site requests
 * outright, and the APP_TOKEN header defends against same-origin-looking requests from
 * tools that spoof headers freely (curl, other local processes) - a bare 401 with no
 * token is not "CSRF", it's "unauthenticated".
 */
export function assertRequestAuthorized(request: Request): void {
  const env = getServerEnv();

  const token = request.headers.get('x-app-token');
  if (token !== env.APP_TOKEN) {
    throw new CsrfError('Missing or invalid X-App-Token header');
  }

  const secFetchSite = request.headers.get('sec-fetch-site');
  if (secFetchSite && secFetchSite !== 'same-origin' && secFetchSite !== 'none') {
    throw new CsrfError(`Rejected cross-site request (Sec-Fetch-Site: ${secFetchSite})`);
  }

  const origin = request.headers.get('origin');
  if (origin) {
    // Compare against the incoming Host header, not `new URL(request.url).host` - in
    // Next's dev server request.url's host can be normalized to "localhost" even when
    // the browser actually connected (and sent Host / Origin) via "127.0.0.1", which
    // are the same server per middleware.ts's LOCAL_HOSTS but different origin strings.
    const host = request.headers.get('host');
    const originUrl = new URL(origin);
    if (!host || originUrl.host !== host) {
      throw new CsrfError(`Origin ${origin} does not match request Host ${host ?? '(missing)'}`);
    }
  }
}

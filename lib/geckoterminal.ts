import 'server-only';

import { resolvePoolRef } from './adapters/resolve-pool';
import { CHAIN_ID } from './constants';

// Server-side fetch for GeckoTerminal's free public pools API (no key required).
// GeckoTerminal doesn't send CORS headers on every response (notably on throttled
// requests), so browsers report those as an opaque "blocked by CORS policy" failure
// instead of a normal HTTP error - fetching from the server sidesteps that entirely,
// and lets every visitor share one cached result instead of each browser hitting
// GeckoTerminal's own rate limit independently.
//
// Used only for discovery/display (trading volume, liquidity, price change) - the
// on-chain adapters (lib/adapters/*) remain the source of truth for anything that
// feeds into plan/execute math.
const GECKOTERMINAL_BASE = 'https://api.geckoterminal.com/api/v2';
const NETWORK = 'robinhood';
const MAX_PAGES = 3;
const CACHE_TTL_MS = 30_000;

export interface GeckoPoolSummary {
  /** GeckoTerminal's own composite id, e.g. "robinhood_0xabc...". Not an on-chain id. */
  id: string;
  /** The pool/pair contract address as GeckoTerminal indexed it - matches a v3-fork
   *  pool's on-chain address, but v4's singleton architecture means this may not
   *  resolve to a valid PoolId; callers should validate before using it. */
  address: string;
  name: string;
  dex: string;
  volumeUsd5m: number;
  reserveUsd: number;
  priceChangePercentage5m: number | null;
  txCount5m: number | null;
}

interface RawPoolAttributes {
  address?: unknown;
  name?: unknown;
  volume_usd?: { m5?: unknown } | null;
  reserve_in_usd?: unknown;
  price_change_percentage?: { m5?: unknown } | null;
  transactions?: { m5?: { buys?: unknown; sells?: unknown } | null } | null;
}

function toNumber(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

/** True for a DEX id whose "-"-separated slug names a v3 or v4 pool (e.g.
 *  "uniswap-v3-robinhood", "orvex-v4") - the app only supports adding liquidity
 *  to those, so v2 and unversioned/unknown DEXes are filtered out of the list. */
function isV3OrV4Dex(dexId: string): boolean {
  return dexId.split('-').some((segment) => segment === 'v3' || segment === 'v4');
}

const V4_ADDRESS_RE = /^0x[a-fA-F0-9]{64}$/;

/** v3-fork pools always use wrapped tokens and have no hooks, so they're always usable.
 *  v4 pools can be native-currency or hooked, which resolvePoolRef itself refuses (see
 *  its "not supported by this app" guards) - re-run that same check here so the list
 *  doesn't link to pools that error out the moment you click them. */
async function isUsableV4Pool(address: string): Promise<boolean> {
  if (!V4_ADDRESS_RE.test(address)) return false;
  try {
    await resolvePoolRef(CHAIN_ID, 'uniswap-v4', address as `0x${string}`);
    return true;
  } catch {
    return false;
  }
}

/** One silent retry - GeckoTerminal's free tier occasionally drops a request outright
 *  under its rate limiting, and a bare reload shouldn't be the only recovery path. */
async function fetchWithRetry(url: string): Promise<Response> {
  try {
    return await fetch(url, { headers: { accept: 'application/json' } });
  } catch {
    await new Promise((resolve) => setTimeout(resolve, 800));
    return fetch(url, { headers: { accept: 'application/json' } });
  }
}

let cache: { at: number; pools: GeckoPoolSummary[] } | null = null;
let inFlight: Promise<GeckoPoolSummary[]> | null = null;

async function fetchGeckoTerminalPoolsUncached(): Promise<GeckoPoolSummary[]> {
  const results: GeckoPoolSummary[] = [];

  for (let page = 1; page <= MAX_PAGES; page++) {
    // GeckoTerminal's pools endpoint only supports sorting by h24 volume/tx count
    // server-side (sort=m5_* is rejected with a 400) - we fetch in that order and
    // let the table's own client-side sort (default: 5m volume desc) reorder it.
    const url = `${GECKOTERMINAL_BASE}/networks/${NETWORK}/pools?page=${page}&sort=h24_volume_usd_desc`;
    const res = await fetchWithRetry(url);
    if (!res.ok) {
      if (page === 1) throw new Error(`GeckoTerminal request failed (${res.status})`);
      break;
    }
    const json = await res.json();
    const data: unknown[] = Array.isArray(json?.data) ? json.data : [];
    if (data.length === 0) break;

    for (const raw of data) {
      const item = raw as { id?: unknown; attributes?: RawPoolAttributes; relationships?: { dex?: { data?: { id?: unknown } } } };
      const attrs = item.attributes ?? {};
      const address = typeof attrs.address === 'string' ? attrs.address : '';
      const name = typeof attrs.name === 'string' && attrs.name ? attrs.name : address || 'Unknown pool';
      const dexId = item.relationships?.dex?.data?.id;
      const dex = typeof dexId === 'string' ? dexId : 'unknown';
      if (!isV3OrV4Dex(dex)) continue;
      results.push({
        id: typeof item.id === 'string' ? item.id : address,
        address,
        name,
        dex,
        volumeUsd5m: toNumber(attrs.volume_usd?.m5),
        reserveUsd: toNumber(attrs.reserve_in_usd),
        priceChangePercentage5m: attrs.price_change_percentage?.m5 != null ? toNumber(attrs.price_change_percentage.m5) : null,
        txCount5m: attrs.transactions?.m5
          ? toNumber(attrs.transactions.m5.buys) + toNumber(attrs.transactions.m5.sells)
          : null,
      });
    }

    if (data.length < 20) break; // short page - nothing more to fetch
  }

  const usable = await Promise.all(
    results.map(async (pool) => ((pool.dex.split('-').includes('v4') ? await isUsableV4Pool(pool.address) : true))),
  );
  return results.filter((_, i) => usable[i]);
}

/** Fetches up to MAX_PAGES of the network's pools (fetch order is h24 volume, see the
 *  sort comment above; display uses 5m figures). Cached for
 *  CACHE_TTL_MS and de-duplicated across concurrent callers (module-level singleton -
 *  see lib/guards/rate-limit.ts's `buckets` for the same one-process assumption) so a
 *  burst of visitors to /pools shares one upstream request instead of each triggering
 *  their own round trip against GeckoTerminal's own rate limit. */
export async function fetchGeckoTerminalPools(): Promise<GeckoPoolSummary[]> {
  if (cache && Date.now() - cache.at < CACHE_TTL_MS) return cache.pools;
  if (inFlight) return inFlight;

  inFlight = fetchGeckoTerminalPoolsUncached()
    .then((pools) => {
      cache = { at: Date.now(), pools };
      return pools;
    })
    .finally(() => {
      inFlight = null;
    });

  return inFlight;
}

import 'server-only';

export class RateLimitError extends Error {
  constructor(
    message: string,
    public readonly retryAfterMs: number,
  ) {
    super(message);
    this.name = 'RateLimitError';
  }
}

/**
 * Per-route budgets - not a science, just a starting point. `plan` needs to tolerate
 * the 400ms-debounced live-preview burst while a user drags a slider
 * (app/page.tsx's plan useEffect); `execute`/`collect`/`withdraw` are one-shot actions
 * so a small burst (retry after fixing a validation error) is enough; `balance` is two
 * cheap reads called often (MAX button). Pool search moved client-side
 * (lib/adapters/pool-search.ts) so it no longer has a tier here.
 */
const TIERS = {
  execute: { capacity: 8, refillPerSec: 6 / 60 },
  plan: { capacity: 20, refillPerSec: 30 / 60 },
  balance: { capacity: 30, refillPerSec: 60 / 60 },
  collect: { capacity: 10, refillPerSec: 10 / 60 },
  withdraw: { capacity: 10, refillPerSec: 10 / 60 },
  // Backed by lib/geckoterminal.ts's own cache, so this tier only needs to survive a
  // client retry burst, not steady polling.
  pools: { capacity: 20, refillPerSec: 20 / 60 },
} satisfies Record<string, { capacity: number; refillPerSec: number }>;

type Tier = keyof typeof TIERS;

interface Bucket {
  tokens: number;
  updatedAt: number;
}

/**
 * Module-level singleton, same pattern as lib/rpc/client.ts's clientCache - this app
 * runs as one long-lived Node process (`next start`), so an in-memory Map is correct
 * here. Would need a shared store (Redis) if this ever runs as multiple instances
 * behind a load balancer.
 */
const buckets = new Map<string, Bucket>();

const SWEEP_INTERVAL_MS = 5 * 60_000;
let lastSweepAt = Date.now();

/** Piggybacked on each call instead of a separate timer - bounds memory growth from
 *  unique IPs on a long-running public-facing process without needing its own interval. */
function sweep(now: number): void {
  if (now - lastSweepAt < SWEEP_INTERVAL_MS) return;
  lastSweepAt = now;
  for (const [key, bucket] of buckets) {
    if (now - bucket.updatedAt > SWEEP_INTERVAL_MS) buckets.delete(key);
  }
}

/**
 * Only meaningful once this instance is actually reverse-proxied - which
 * ALLOW_PUBLIC_BIND=true already requires (see .env.local.example) - and depends on
 * that proxy overwriting, not appending to, a client-supplied X-Forwarded-For. Same
 * trust assumption lib/guards/csrf.ts already places on Origin/Host. With no proxy
 * (local-only mode) everything collapses into one 'unknown' bucket, which is harmless
 * there - there's no multi-tenant concern to defend against in that mode.
 */
function clientKey(request: Request): string {
  const xff = request.headers.get('x-forwarded-for');
  const ip = xff?.split(',')[0]?.trim();
  return ip || 'unknown';
}

/** Token bucket per (tier, client IP): allows short legitimate bursts while capping
 *  sustained load. Throws RateLimitError (mirrors CsrfError's shape) when exhausted. */
export function assertRateLimited(request: Request, tier: Tier): void {
  const { capacity, refillPerSec } = TIERS[tier];
  const now = Date.now();
  sweep(now);

  const key = `${tier}:${clientKey(request)}`;
  const bucket = buckets.get(key) ?? { tokens: capacity, updatedAt: now };
  const elapsedSec = Math.max(0, (now - bucket.updatedAt) / 1000);
  const refilled = Math.min(capacity, bucket.tokens + elapsedSec * refillPerSec);

  if (refilled < 1) {
    buckets.set(key, { tokens: refilled, updatedAt: now });
    const retryAfterMs = Math.ceil(((1 - refilled) / refillPerSec) * 1000);
    throw new RateLimitError('Too many requests - please slow down.', retryAfterMs);
  }

  buckets.set(key, { tokens: refilled - 1, updatedAt: now });
}

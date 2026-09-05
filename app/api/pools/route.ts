import 'server-only';
import { z } from 'zod';
import { jsonResponse } from '@/lib/json';
import { assertRequestAuthorized, CsrfError } from '@/lib/guards/csrf';
import { assertRateLimited, RateLimitError } from '@/lib/guards/rate-limit';
import { getChain } from '@/lib/registry/resolve';
import { getAdapter } from '@/lib/adapters';
import { resolvePoolRef } from '@/lib/adapters/resolve-pool';
import { addressSchema, poolIdSchema } from '@/lib/schemas';
import { describeError } from '@/lib/rpc/errors';

const querySchema = z.object({
  chainId: z.coerce.number().int().positive(),
  protocol: z.string().min(1),
  token: addressSchema.optional(),
  poolId: poolIdSchema.optional(),
});

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

  const url = new URL(request.url);
  const parsed = querySchema.safeParse(Object.fromEntries(url.searchParams));
  if (!parsed.success) {
    return jsonResponse({ error: 'Invalid query', issues: parsed.error.issues }, { status: 400 });
  }
  const { chainId, protocol: protocolKey, token, poolId } = parsed.data;

  if (!token && !poolId) {
    return jsonResponse({ error: 'Provide either ?token= or ?poolId=' }, { status: 400 });
  }

  const chain = getChain(chainId);
  const adapter = getAdapter(chainId, protocolKey);

  try {
    if (poolId) {
      const ref = await resolvePoolRef(chainId, protocolKey, poolId);
      const state = await adapter.getPoolState(ref);
      return jsonResponse({ pools: [{ ref, state }] });
    }

    const refs = await adapter.findPools(token!, chain.quoteCandidates);
    // allSettled: one pool's state read failing (flaky RPC) shouldn't blank out the
    // whole result set - return whichever pools resolved successfully. But if every
    // pool's state read failed, that's not "zero pools" - surface the error so the
    // client's retry/error handling kicks in instead of silently reporting nothing.
    const settled = await Promise.allSettled(refs.map(async (ref) => ({ ref, state: await adapter.getPoolState(ref) })));
    const pools = settled.flatMap((r) => (r.status === 'fulfilled' ? [r.value] : []));
    if (pools.length === 0 && refs.length > 0 && settled.some((r) => r.status === 'rejected')) {
      throw (settled.find((r): r is PromiseRejectedResult => r.status === 'rejected')!).reason;
    }

    // Sort by on-chain liquidity descending, highest first.
    pools.sort((a, b) => (b.state.liquidity > a.state.liquidity ? 1 : b.state.liquidity < a.state.liquidity ? -1 : 0));

    return jsonResponse({ pools });
  } catch (err) {
    return jsonResponse({ error: describeError(err) }, { status: 500 });
  }
}

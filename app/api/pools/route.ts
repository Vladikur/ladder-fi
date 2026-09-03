import 'server-only';
import { z } from 'zod';
import { jsonResponse } from '@/lib/json';
import { assertRequestAuthorized, CsrfError } from '@/lib/guards/csrf';
import { getChain } from '@/lib/registry/resolve';
import { getAdapter } from '@/lib/adapters';
import { resolvePoolRef } from '@/lib/adapters/resolve-pool';
import { addressSchema, poolIdSchema } from '@/lib/schemas';

const querySchema = z.object({
  chainId: z.coerce.number().int().positive(),
  protocol: z.string().min(1),
  token: addressSchema.optional(),
  poolId: poolIdSchema.optional(),
});

export async function GET(request: Request) {
  try {
    assertRequestAuthorized(request);
  } catch (err) {
    if (err instanceof CsrfError) return jsonResponse({ error: err.message }, { status: 401 });
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
    const pools = await Promise.all(refs.map(async (ref) => ({ ref, state: await adapter.getPoolState(ref) })));

    // Sort by on-chain liquidity descending, highest first.
    pools.sort((a, b) => (b.state.liquidity > a.state.liquidity ? 1 : b.state.liquidity < a.state.liquidity ? -1 : 0));

    return jsonResponse({ pools });
  } catch (err) {
    return jsonResponse({ error: err instanceof Error ? err.message : 'Unknown error' }, { status: 500 });
  }
}

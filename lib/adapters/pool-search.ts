import type { Address } from '@/lib/core';
import { getChain } from '@/lib/registry/chains';
import { getAdapter } from './index';
import { resolvePoolRef } from './resolve-pool';
import type { PoolRef, PoolState } from './types';

export interface PoolListItem {
  ref: PoolRef;
  state: PoolState;
}

/** Client-safe replacement for the old GET /api/pools?token= branch. */
export async function searchPoolsByToken(chainId: number, protocolKey: string, token: Address): Promise<PoolListItem[]> {
  const chain = getChain(chainId);
  const adapter = getAdapter(chainId, protocolKey);
  const refs = await adapter.findPools(token, chain.quoteCandidates);

  // allSettled: one pool's state read failing (flaky RPC) shouldn't blank out the
  // whole result set - return whichever pools resolved successfully. But if every
  // pool's state read failed, that's not "zero pools" - surface the error so the
  // caller's retry/error handling kicks in instead of silently reporting nothing.
  const settled = await Promise.allSettled(refs.map(async (ref) => ({ ref, state: await adapter.getPoolState(ref) })));
  const pools = settled.flatMap((r) => (r.status === 'fulfilled' ? [r.value] : []));
  if (pools.length === 0 && refs.length > 0 && settled.some((r) => r.status === 'rejected')) {
    throw (settled.find((r): r is PromiseRejectedResult => r.status === 'rejected')!).reason;
  }

  pools.sort((a, b) => (b.state.liquidity > a.state.liquidity ? 1 : b.state.liquidity < a.state.liquidity ? -1 : 0));
  return pools;
}

/** Client-safe replacement for the old GET /api/pools?poolId= branch. */
export async function lookupPoolById(chainId: number, protocolKey: string, poolId: `0x${string}`): Promise<PoolListItem> {
  const adapter = getAdapter(chainId, protocolKey);
  const ref = await resolvePoolRef(chainId, protocolKey, poolId);
  const state = await adapter.getPoolState(ref);
  return { ref, state };
}

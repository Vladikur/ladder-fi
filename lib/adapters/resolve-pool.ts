import { zeroAddress } from 'viem';
import { getPublicClient } from '@/lib/rpc/client';
import { listProtocolsForChain } from '@/lib/registry/protocols';
import { univ3PoolAbi, v4PoolManagerInitializeEvent } from './abis';
import type { PoolRef } from './types';

/**
 * No 'server-only' tag: pure public-RPC reads, no secret (same reasoning as
 * lib/rpc/errors.ts). Also called client-side now (lib/adapters/pool-search.ts, for
 * manual pool/PoolId lookup) - that doesn't weaken the trust rule below, since
 * /api/plan and /api/execute still call this themselves server-side before building
 * calldata, never accepting a client-supplied ref.
 *
 * Re-derives a PoolRef (token0/token1/fee/tickSpacing) directly from on-chain source of
 * truth, given only a pool identifier (a contract address for v3, a 32-byte PoolId for
 * v4). Used by /api/plan and /api/execute so a client-supplied token0/token1/fee is
 * never trusted - "Пересчёт плана на сервере из исходных параметров - готовый calldata
 * от клиента не принимать" (TZ §3.4).
 */
export async function resolvePoolRef(chainId: number, protocolKey: string, poolId: `0x${string}`): Promise<PoolRef> {
  const client = getPublicClient(chainId);
  const protocol = listProtocolsForChain(chainId).find((p) => p.key === protocolKey);
  if (!protocol) throw new Error(`Unknown protocol "${protocolKey}" for chain ${chainId}`);

  if (protocol.family === 'univ3-fork') {
    const [token0, token1, fee, tickSpacing] = await Promise.all([
      client.readContract({ address: poolId, abi: univ3PoolAbi, functionName: 'token0' }),
      client.readContract({ address: poolId, abi: univ3PoolAbi, functionName: 'token1' }),
      client.readContract({ address: poolId, abi: univ3PoolAbi, functionName: 'fee' }),
      client.readContract({ address: poolId, abi: univ3PoolAbi, functionName: 'tickSpacing' }),
    ]);
    if (token0 === zeroAddress || token1 === zeroAddress) throw new Error('Address is not a valid pool');
    return { id: poolId, protocolKey, chainId, token0, token1, fee, tickSpacing };
  }

  if (protocol.family === 'univ4') {
    const poolManager = protocol.contracts.poolManager;
    if (!poolManager) throw new Error(`${protocol.key}: poolManager not configured`);
    if (poolId.length !== 66) throw new Error('v4 pool identifier must be a 32-byte PoolId (0x + 64 hex chars)');

    // A poolId-indexed filter matches at most one log across all of history (each id can
    // only ever be initialized once), so this is fast and safe to run unbounded - unlike
    // a currency-indexed scan (see findPools), which this chain's Initialize-event volume
    // makes impractical over the full block range.
    const logs = await client.getLogs({
      address: poolManager,
      event: v4PoolManagerInitializeEvent[0],
      args: { id: poolId },
      fromBlock: 0n,
      toBlock: 'latest',
    });
    const log = logs[0];
    if (!log) throw new Error('No v4 pool initialized with this PoolId');
    const { currency0, currency1, fee, tickSpacing, hooks } = log.args;
    if (currency0 === undefined || currency1 === undefined || fee === undefined || tickSpacing === undefined) {
      throw new Error('Malformed Initialize event');
    }
    if (currency0 === zeroAddress) throw new Error('Native-currency v4 pools are not supported by this app');
    if (hooks !== zeroAddress) throw new Error('Hooked v4 pools are not supported by this app');
    return { id: poolId, protocolKey, chainId, token0: currency0, token1: currency1, fee, tickSpacing };
  }

  throw new Error(`Pool lookup not supported for protocol family ${protocol.family}`);
}

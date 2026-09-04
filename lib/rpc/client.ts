import { createPublicClient, http, type PublicClient } from 'viem';
import { getChain } from '@/lib/registry/chains';

const clientCache = new Map<number, PublicClient>();

/**
 * Returns a cached viem PublicClient for the given chain.
 *
 * Batching: the public RPC is rate-limited (see TZ §1), so reads must be batched.
 * This chain has no genuine on-chain Multicall3 (every candidate found via Blockscout
 * name search - the canonical cross-chain address included - returned a stale/fake
 * block number, see lib/registry/chains.ts). Instead of trusting an unverifiable
 * on-chain aggregator, we batch at the HTTP transport level: viem coalesces JSON-RPC
 * requests issued within `wait` ms into a single HTTP POST (standard JSON-RPC batch),
 * which cuts round-trips without depending on any contract address.
 *
 * If a future chain in the registry does have a verified multicall3 address, viem's
 * native on-chain multicall batching is enabled for it automatically.
 */
export function getPublicClient(chainId: number): PublicClient {
  const cached = clientCache.get(chainId);
  if (cached) return cached;

  const chain = getChain(chainId);
  const rpcUrl = chain.rpcUrls[0];
  if (!rpcUrl) throw new Error(`No RPC URL configured for chain ${chainId}`);

  const client = createPublicClient({
    chain: {
      id: chain.id,
      name: chain.name,
      nativeCurrency: {
        name: chain.nativeCurrency.symbol,
        symbol: chain.nativeCurrency.symbol,
        decimals: chain.nativeCurrency.decimals,
      },
      rpcUrls: { default: { http: chain.rpcUrls } },
      contracts: chain.multicall3 ? { multicall3: { address: chain.multicall3 } } : undefined,
    },
    transport: http(rpcUrl, {
      // Smaller batches: this RPC node has been observed truncating large JSON-RPC
      // batch responses under load, which crashes viem's batch scheduler (it indexes
      // the response array by request order and assumes one entry per request).
      batch: { batchSize: 10, wait: 20 },
      retryCount: 4,
      retryDelay: 300, // viem applies exponential backoff with jitter on top of this base
      timeout: 15_000,
    }),
    batch: chain.multicall3 ? { multicall: true } : undefined,
  });

  clientCache.set(chainId, client);
  return client;
}

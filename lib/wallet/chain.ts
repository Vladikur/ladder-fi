import { defineChain } from 'viem';
import { CHAIN_ID } from '@/lib/constants';
import { getChain } from '@/lib/registry/chains';

// Client-safe: lib/registry/chains.ts carries no 'server-only' guard. Building the
// wagmi/viem Chain from the same descriptor the server reads keeps RPC URL/explorer/
// native currency in one source of truth instead of a second hardcoded copy.
const descriptor = getChain(CHAIN_ID);

export const robinhoodChain = defineChain({
  // CHAIN_ID (not descriptor.id, which widens to plain `number` via ChainDescriptor's
  // type) so wagmi's per-chain generics can narrow on the literal 4663 - passing a
  // plain `number` as `chainId` to actions like sendTransaction otherwise collapses
  // their parameter types to `never`.
  id: CHAIN_ID,
  name: descriptor.name,
  nativeCurrency: {
    name: descriptor.nativeCurrency.symbol,
    symbol: descriptor.nativeCurrency.symbol,
    decimals: descriptor.nativeCurrency.decimals,
  },
  rpcUrls: {
    default: { http: descriptor.rpcUrls },
  },
  blockExplorers: {
    default: { name: descriptor.explorer.kind, url: descriptor.explorer.url },
  },
});

import type { Address } from '@/lib/core';

export interface ChainDescriptor {
  id: number;
  key: string;
  name: string;
  nativeCurrency: { symbol: string; decimals: number };
  rpcUrls: string[];
  explorer: { url: string; kind: 'blockscout' | 'etherscan' };
  /**
   * A genuine, on-chain-verified Multicall3 deployment. Optional by design: on
   * Robinhood Chain the canonical cross-chain address (0xcA11...CA11) is occupied by a
   * decoy that returns a frozen block number - verified via eth_call, see README. Do
   * NOT fill this in from a "canonical address" list without independently confirming
   * behaviour on-chain (getBlockNumber() vs eth_blockNumber, twice, a few seconds apart).
   */
  multicall3?: Address;
  gasStrategy: 'eip1559' | 'legacy';
  /** Robinhood Chain's sequencer is FCFS (first-come-first-served), so priority fee has no effect on ordering. */
  priorityFeeMatters: boolean;
  blockTimeMs: number;
  confirmations: number;
  wrappedNative: Address;
  quoteCandidates: Address[];
  /**
   * The stable, dollar-denominated token used as the unit for the MAX_NOTIONAL_PER_RUN
   * / MAX_NOTIONAL_PER_DAY guards (there is no price oracle in this app - see TZ §7 -
   * so notional exposure can only be measured directly in a stable token, not converted
   * from arbitrary tokens). A deposit that doesn't touch this token on either leg is
   * exempt from the two notional checks specifically; every other guard still applies.
   */
  notionalToken: Address;
}

export const chains: Record<number, ChainDescriptor> = {
  4663: {
    id: 4663,
    key: 'robinhood',
    name: 'Robinhood Chain',
    nativeCurrency: { symbol: 'ETH', decimals: 18 },
    rpcUrls: ['https://rpc.mainnet.chain.robinhood.com'],
    explorer: { url: 'https://robinhoodchain.blockscout.com', kind: 'blockscout' },
    // No genuine Multicall3 exists on this chain - every "Multicall3"-named contract
    // and token found via Blockscout search returned a stale/fake getBlockNumber().
    // Reads are batched at the HTTP transport level instead (see lib/rpc/client.ts).
    multicall3: undefined,
    gasStrategy: 'eip1559',
    priorityFeeMatters: false,
    blockTimeMs: 100,
    confirmations: 1,
    wrappedNative: '0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73',
    quoteCandidates: [
      '0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73', // WETH
      '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168', // USDG
    ],
    notionalToken: '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168', // USDG, 6 decimals
  },
};

export function getChain(chainId: number): ChainDescriptor {
  const chain = chains[chainId];
  if (!chain) throw new Error(`Unknown chain id ${chainId}`);
  return chain;
}

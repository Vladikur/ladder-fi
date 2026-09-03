import type { Address } from '@/lib/core';

export interface ProtocolDescriptor {
  key: string;
  chainId: number;
  family: 'univ3-fork' | 'univ4';
  contracts: {
    /** per-pool-contract factory (v3-fork only) */
    factory?: Address;
    positionManager?: Address;
    router?: Address;
    quoter?: Address;
    permit2?: Address;
    /** v4 singleton pool ledger */
    poolManager?: Address;
    /** v4 read-only lens over PoolManager's storage (StateView) */
    stateView?: Address;
    tickLens?: Address;
  };
  feeTiers: { fee: number; tickSpacing: number }[];
  poolInitCodeHash?: `0x${string}`;
  capabilities: {
    batchMint: boolean;
    maxPositionsPerTx: number;
    supportsNativeToken: boolean;
    requiresPermit2: boolean;
  };
}

/**
 * All addresses below were independently verified on-chain (not just taken from a
 * name search or a docs page) before being hardcoded here:
 *  - factory.feeAmountTickSpacing(fee) called for each tier and matched the expected
 *    Uniswap V3 defaults exactly.
 *  - NonfungiblePositionManager.factory() and .WETH9() cross-checked against the
 *    factory and WETH addresses below.
 *  - v4 PositionManager.poolManager() and StateView.poolManager() both cross-checked
 *    against the PoolManager address below; PositionManager.permit2() cross-checked
 *    against the Permit2 address below. All four v4 contracts (PoolManager,
 *    PositionManager, StateView, Permit2) carry substantial verified bytecode (tens of
 *    KB, not thin proxy stubs).
 * See README.md "Verified addresses" for the full methodology - this matters because
 * this chain has multiple decoy contracts squatting canonical cross-chain addresses
 * (e.g. the well-known 0x1F98431c8aD98523631AE4a59f267346ea31F984 UniswapV3Factory
 * address here is a StubContract, not the real factory).
 */
export const protocols: Record<string, ProtocolDescriptor> = {
  'robinhood:uniswap-v3': {
    key: 'uniswap-v3',
    chainId: 4663,
    family: 'univ3-fork',
    contracts: {
      factory: '0x1f7d7550B1b028f7571E69A784071F0205FD2EfA',
      positionManager: '0x73991a25C818Bf1f1128dEAaB1492D45638DE0D3',
      quoter: '0x33e885eD0Ec9bF04EcfB19341582aADCb4c8A9E7',
      tickLens: '0x7DfD4F31be6814D2906BDE155c3e1B146EAc1468',
      // Permit2 deliberately not wired up - see capabilities.requiresPermit2.
    },
    feeTiers: [
      { fee: 100, tickSpacing: 1 },
      { fee: 500, tickSpacing: 10 },
      { fee: 3000, tickSpacing: 60 },
      { fee: 10000, tickSpacing: 200 },
    ],
    capabilities: {
      batchMint: true,
      maxPositionsPerTx: 10,
      supportsNativeToken: false,
      requiresPermit2: false,
    },
  },
  'robinhood:uniswap-v4': {
    key: 'uniswap-v4',
    chainId: 4663,
    family: 'univ4',
    contracts: {
      poolManager: '0x8366a39CC670B4001A1121B8F6A443A643e40951',
      positionManager: '0x58daec3116aae6D93017bAAea7749052E8a04fA7',
      stateView: '0xF3334192D15450CdD385c8B70e03f9A6bD9E673b',
      permit2: '0x000000000022D473030F116dDEE9F6B43aC78BA3',
    },
    // Informational only for v4 - unlike v3, fee/tickSpacing aren't factory-enforced
    // pairs, they're independent fields of each pool's key. The adapter always reads
    // the real tickSpacing for a given pool off-chain (from its Initialize event),
    // never assumes it from this table.
    feeTiers: [
      { fee: 100, tickSpacing: 1 },
      { fee: 500, tickSpacing: 10 },
      { fee: 3000, tickSpacing: 60 },
      { fee: 10000, tickSpacing: 200 },
    ],
    capabilities: {
      batchMint: true,
      maxPositionsPerTx: 10,
      supportsNativeToken: false,
      requiresPermit2: true,
    },
  },
};

export function getProtocol(chainId: number, key: string): ProtocolDescriptor {
  const protocol = protocols[`${lookupChainKey(chainId)}:${key}`];
  if (!protocol) throw new Error(`Unknown protocol "${key}" for chain ${chainId}`);
  return protocol;
}

export function listProtocolsForChain(chainId: number): ProtocolDescriptor[] {
  return Object.values(protocols).filter((p) => p.chainId === chainId);
}

function lookupChainKey(chainId: number): string {
  // kept local/small on purpose - the chains.ts `key` field is the single source of
  // truth, this just avoids a circular import between chains.ts and protocols.ts.
  if (chainId === 4663) return 'robinhood';
  throw new Error(`Unknown chain id ${chainId}`);
}

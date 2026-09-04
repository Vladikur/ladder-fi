import type { Address, PlanBin, RawPoolState, TokenMeta } from '@/lib/core';

export interface Call {
  to: Address;
  data: `0x${string}`;
  value?: bigint;
}

export interface PoolRef {
  /** contract address for a per-pool-contract protocol (v3-fork); the 32-byte PoolId for a singleton protocol (v4) */
  id: `0x${string}`;
  protocolKey: string;
  chainId: number;
  token0: Address;
  token1: Address;
  fee: number;
  tickSpacing: number;
}

export interface PoolSummary {
  ref: PoolRef;
  state: RawPoolState;
  /** rough liquidity-based ranking metric, protocol-specific units - only used to sort results */
  liquidityMetric: bigint;
}

export interface PositionView {
  tokenId: bigint;
  ref: PoolRef;
  token0: TokenMeta;
  token1: TokenMeta;
  fee: number;
  tickLower: number;
  tickUpper: number;
  currentTick: number;
  liquidity: bigint;
  inRange: boolean;
  tokensOwed0: bigint;
  tokensOwed1: bigint;
}

/** One bin-ladder mint - the only liquidity-provision shape this app builds (concentrated, tick-ranged). */
export interface MintPlan {
  kind: 'v3-bins';
  ref: PoolRef;
  owner: Address;
  deadline: bigint;
  bins: PlanBin[];
  /** needed by v4 to size Permit2/amount-max slippage buffers; ignored by the v3-fork adapter */
  slippageBps: number;
}

/** No discriminant needed - every supported protocol (v3-fork, v4) uses the same concentrated-liquidity shape. */
export type PoolState = RawPoolState;

export interface ILiquidityAdapter {
  findPools(token: Address, candidates: Address[]): Promise<PoolRef[]>;
  getPoolState(ref: PoolRef): Promise<PoolState>;
  buildApproveCalls(plan: MintPlan): Promise<Call[]>;
  /** already chunked - each inner array must be sent together as one transaction */
  buildMintCalls(plan: MintPlan): Promise<Call[][]>;
  listPositions(owner: Address, ref?: PoolRef): Promise<PositionView[]>;
  buildCollectCalls(owner: Address, tokenIds: bigint[]): Promise<Call[][]>;
  /** already chunked (see buildMintCalls) - each inner array batches up to maxPositionsPerTx tokenIds into one transaction */
  buildWithdrawCalls(owner: Address, tokenIds: bigint[], bps: number): Promise<Call[][]>;
  /** token0/token1/tickLower/tickUpper for a position, for audit-log purposes (collect/withdraw routes) */
  getPositionSummary(tokenId: bigint): Promise<{ token0: Address; token1: Address; tickLower: number; tickUpper: number }>;
}

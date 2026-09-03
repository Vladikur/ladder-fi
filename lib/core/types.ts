// Pure types for the core math layer. No React, no viem, no network.

export type Address = `0x${string}`;

export type Strategy = 'bid-ask' | 'spot' | 'curve';

export type DepositMode = 'both' | 'base-only' | 'quote-only';

/** Internal tick-space side. 'upper' = ticks above the active tick, holds pure token0.
 *  'lower' = ticks below the active tick, holds pure token1.
 *  This is independent of which token the user calls "base" - see orientation.ts. */
export type LadderSide = 'upper' | 'lower';

export interface TokenMeta {
  address: Address;
  decimals: number;
  symbol: string;
}

export interface RawPoolState {
  token0: TokenMeta;
  token1: TokenMeta;
  fee: number;
  tickSpacing: number;
  sqrtPriceX96: bigint;
  tick: number;
  liquidity: bigint;
}

export interface BinSpec {
  /** 0 = nearest to the active tick, increasing with distance */
  index: number;
  side: LadderSide;
  tickLower: number;
  tickUpper: number;
}

export interface WeightParams {
  n: number;
  alpha: number;
  strategy: Strategy;
}

export interface RangeSliceInput {
  tickLowerG: number;
  tickUpperG: number;
  n: number;
  tickSpacing: number;
}

export interface RangeSliceResult {
  binWidth: number;
  /** leftover tickSpacing units (0..n-1) after flooring; consumed by widening the bins nearest tickUpperG by one tickSpacing each, so the top boundary always lands exactly on tickUpperG. */
  remainderSpacings: number;
  actualTickUpperG: number;
}

export interface LadderBuildInput {
  tickLowerG: number;
  binWidth: number;
  remainderSpacings: number;
  n: number;
  tickSpacing: number;
  currentTick: number;
  /** gap between the active tick and the first bin on each side, in units of tickSpacing. Default 1. */
  gapSpacings: number;
}

export interface LadderBuildResult {
  upper: BinSpec[];
  lower: BinSpec[];
  warnings: PlanWarning[];
}

export type PlanWarningCode =
  | 'n-reduced'
  | 'dust-amount'
  | 'bin-width-floor';

export interface PlanWarning {
  code: PlanWarningCode;
  message: string;
}

export interface BinAmount {
  bin: BinSpec;
  /** raw token0 amount for an 'upper' bin, 0n for 'lower' bins */
  amount0: bigint;
  /** raw token1 amount for a 'lower' bin, 0n for 'upper' bins */
  amount1: bigint;
}

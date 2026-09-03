import JSBI from 'jsbi';
import { Pool, Position, TICK_SPACINGS } from '@uniswap/v3-sdk';
import { Percent, Token } from '@uniswap/sdk-core';
import { toIntegerWeights } from './weights';
import type { BinAmount, BinSpec, LadderSide, RawPoolState } from './types';

function toToken(chainId: number, meta: RawPoolState['token0']): Token {
  return new Token(chainId, meta.address, meta.decimals, meta.symbol);
}

function buildPool(chainId: number, state: RawPoolState): Pool {
  // v3-sdk's Pool.tickSpacing getter derives spacing purely from TICK_SPACINGS[fee],
  // a table of the four standard v3 fee tiers. v4 pools decouple fee from tickSpacing
  // (arbitrary pairs), so for any other fee that lookup is undefined and every
  // invariant that mods by it (TICK_LOWER/TICK_UPPER, incl. inside the SDK's own
  // internally-reconstructed pools in mintAmountsWithSlippage/burnAmountsWithSlippage,
  // which build fresh `new Pool(...)` instances we never touch directly) breaks.
  // Registering the real spacing in the table fixes every Pool built from this fee,
  // including those the SDK constructs internally - a per-instance override wouldn't
  // reach them. Two distinct v4 pools could in principle share a fee with different
  // spacing, but everything that reads this value (buildPool -> sizePositions,
  // including the SDK's internal counterfactual pools in mintAmountsWithSlippage/
  // burnAmountsWithSlippage) runs synchronously with no `await` in between, so a
  // concurrent request for a different pool can never observe this value mid-use.
  (TICK_SPACINGS as Record<number, number>)[state.fee] = state.tickSpacing;

  const token0 = toToken(chainId, state.token0);
  const token1 = toToken(chainId, state.token1);
  return new Pool(
    token0,
    token1,
    state.fee,
    JSBI.BigInt(state.sqrtPriceX96.toString()),
    JSBI.BigInt(state.liquidity.toString()),
    state.tick,
  );
}

/**
 * Splits `totalAmount` across bins according to `weights` (same order, index 0 =
 * nearest to price). Bigint only, floor division; the rounding remainder is added to
 * the bin nearest the price. Invariant: sum(result) === totalAmount <= totalAmount.
 */
export function splitAmountByWeights(totalAmount: bigint, weights: number[]): bigint[] {
  if (weights.length === 0) return [];
  if (totalAmount < 0n) throw new Error('totalAmount must be non-negative');
  const { numerators } = toIntegerWeights(weights);
  const numeratorSum = numerators.reduce((a, b) => a + b, 0n);
  if (numeratorSum === 0n) return weights.map(() => 0n);

  const amounts = numerators.map((num) => (totalAmount * num) / numeratorSum);
  const distributed = amounts.reduce((a, b) => a + b, 0n);
  const remainder = totalAmount - distributed;
  if (remainder > 0n && amounts.length > 0) {
    amounts[0] = (amounts[0] ?? 0n) + remainder;
  }
  return amounts;
}

export interface SizedBin extends BinAmount {
  liquidity: bigint;
  amount0Min: bigint;
  amount1Min: bigint;
}

/**
 * Sizes each bin's position via Position.fromAmount0/fromAmount1 (liquidity math is the
 * SDK's, never hand-rolled) and derives slippage-adjusted minimums via
 * mintAmountsWithSlippage - the same call that feeds amount0Min/amount1Min for the mint.
 */
export function sizePositions(params: {
  chainId: number;
  pool: RawPoolState;
  bins: BinSpec[];
  side: LadderSide;
  desiredAmounts: bigint[];
  slippageBps: number;
}): SizedBin[] {
  const { chainId, pool, bins, side, desiredAmounts, slippageBps } = params;
  if (bins.length !== desiredAmounts.length) {
    throw new Error('bins and desiredAmounts must have the same length');
  }
  const poolEntity = buildPool(chainId, pool);
  const slippage = new Percent(String(Math.round(slippageBps)), '10000');

  return bins.map((bin, i) => {
    const desired = desiredAmounts[i] ?? 0n;
    if (desired === 0n) {
      return { bin, amount0: 0n, amount1: 0n, liquidity: 0n, amount0Min: 0n, amount1Min: 0n };
    }

    const position =
      side === 'upper'
        ? Position.fromAmount0({
            pool: poolEntity,
            tickLower: bin.tickLower,
            tickUpper: bin.tickUpper,
            amount0: desired.toString(),
            useFullPrecision: true,
          })
        : Position.fromAmount1({
            pool: poolEntity,
            tickLower: bin.tickLower,
            tickUpper: bin.tickUpper,
            amount1: desired.toString(),
          });

    const mint = position.mintAmounts;
    const mintWithSlippage = position.mintAmountsWithSlippage(slippage);

    return {
      bin,
      amount0: BigInt(mint.amount0.toString()),
      amount1: BigInt(mint.amount1.toString()),
      liquidity: BigInt(position.liquidity.toString()),
      amount0Min: BigInt(mintWithSlippage.amount0.toString()),
      amount1Min: BigInt(mintWithSlippage.amount1.toString()),
    };
  });
}

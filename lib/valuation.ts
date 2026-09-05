import JSBI from 'jsbi';
import { Pool, Position, TickMath, TICK_SPACINGS } from '@uniswap/v3-sdk';
import { Token } from '@uniswap/sdk-core';
import { formatUnits } from 'viem';
import { tickToPrice } from './core/ticks';
import { toUserFacingPrice } from './core/orientation';
import type { Address, TokenMeta } from './core/types';

/**
 * Best-effort $ estimate, valid only for pairs that include the chain's stable
 * notional token (no price oracle in this app - see README "Deviations"/TZ §7). Returns
 * null for pairs that don't touch it - the caller should fall back to showing raw
 * liquidity units.
 */
function notionalSide(token0: Address, token1: Address, notionalToken: Address): 0 | 1 | null {
  const n = notionalToken.toLowerCase();
  if (token0.toLowerCase() === n) return 0;
  if (token1.toLowerCase() === n) return 1;
  return null;
}

const Q96 = 1n << 96n;

/** $ value of a raw (amount0, amount1) pair, valuing the non-notional leg at the
 *  pool's current price. Shared by estimatePositionLiquidityUsd and estimateFeesUsd. */
function valueAmountsUsd(
  amount0: bigint,
  amount1: bigint,
  token0Decimals: number,
  token1Decimals: number,
  currentTick: number,
  side: 0 | 1,
): number {
  const amount0Human = Number(formatUnits(amount0, token0Decimals));
  const amount1Human = Number(formatUnits(amount1, token1Decimals));

  // tickToPrice always returns token1-per-token0; invert (exact bigint fraction, see
  // orientation.ts) rather than swap the decimals args, which would silently reuse the
  // same raw ratio instead of computing a reciprocal.
  const price1Per0 = tickToPrice(currentTick, token0Decimals, token1Decimals);
  if (side === 1) {
    return amount1Human + amount0Human * Number(price1Per0);
  }
  const price0Per1 = toUserFacingPrice(price1Per0, false);
  return amount0Human + amount1Human * Number(price0Per1);
}

/**
 * $ value of a pool's raw `liquidity` at its current tick - the standard "virtual
 * reserves" approximation (amount0 = L/sqrtP, amount1 = L*sqrtP), which by construction
 * splits value evenly between the two legs. Used for the pool-search list, which has no
 * bounded range to speak of.
 */
export function estimatePoolLiquidityUsd(
  state: { token0: TokenMeta; token1: TokenMeta; sqrtPriceX96: bigint; liquidity: bigint },
  notionalToken: Address,
): number | null {
  const side = notionalSide(state.token0.address, state.token1.address, notionalToken);
  if (side === null) return null;

  // The API's bigint serializer (lib/json.ts) sends these as decimal strings - the
  // declared `bigint` type only holds once a request has round-tripped through JSON,
  // so coerce explicitly rather than assume a real bigint.
  const liquidity = BigInt(state.liquidity);
  if (liquidity === 0n) return 0;
  const sqrtPriceX96 = BigInt(state.sqrtPriceX96);

  if (side === 1) {
    const amount1Raw = (liquidity * sqrtPriceX96) / Q96;
    return 2 * Number(formatUnits(amount1Raw, state.token1.decimals));
  }
  const amount0Raw = (liquidity * Q96) / sqrtPriceX96;
  return 2 * Number(formatUnits(amount0Raw, state.token0.decimals));
}

/**
 * $ value of a bounded [tickLower, tickUpper] position's actual current amounts
 * (via Position.mintAmounts, the same SDK call used to size mints in lib/core/amounts.ts),
 * valuing the non-notional leg at the pool's current price.
 */
export function estimatePositionLiquidityUsd(position: {
  token0: TokenMeta;
  token1: TokenMeta;
  fee: number;
  tickSpacing: number;
  tickLower: number;
  tickUpper: number;
  currentTick: number;
  liquidity: bigint;
}, notionalToken: Address): number | null {
  const { token0, token1, fee, tickSpacing, tickLower, tickUpper, currentTick } = position;
  const side = notionalSide(token0.address, token1.address, notionalToken);
  if (side === null) return null;
  // Same string-vs-bigint caveat as estimatePoolLiquidityUsd - coerce before comparing.
  const liquidity = BigInt(position.liquidity);
  if (liquidity === 0n) return 0;

  // See lib/core/amounts.ts buildPool: v3-sdk derives Pool.tickSpacing from a fixed
  // fee->spacing table that doesn't know v4's independent fee/spacing pairs.
  (TICK_SPACINGS as Record<number, number>)[fee] = tickSpacing;

  const sqrtRatioX96 = TickMath.getSqrtRatioAtTick(currentTick);
  const pool = new Pool(
    new Token(1, token0.address, token0.decimals),
    new Token(1, token1.address, token1.decimals),
    fee,
    sqrtRatioX96,
    JSBI.BigInt(0), // pool.liquidity doesn't affect a single position's own mintAmounts
    currentTick,
  );
  const { amount0, amount1 } = new Position({ pool, liquidity: JSBI.BigInt(liquidity.toString()), tickLower, tickUpper }).mintAmounts;

  return valueAmountsUsd(BigInt(amount0.toString()), BigInt(amount1.toString()), token0.decimals, token1.decimals, currentTick, side);
}

/**
 * $ value of a position's uncollected fees (tokensOwed0/1), valuing the non-notional
 * leg at the pool's current price. Unlike estimatePositionLiquidityUsd, no Pool/Position
 * math is needed - the owed amounts are already the actual amounts, just priced.
 */
export function estimateFeesUsd(
  fees: { token0: TokenMeta; token1: TokenMeta; currentTick: number; tokensOwed0: bigint; tokensOwed1: bigint },
  notionalToken: Address,
): number | null {
  const { token0, token1, currentTick } = fees;
  const side = notionalSide(token0.address, token1.address, notionalToken);
  if (side === null) return null;

  const tokensOwed0 = BigInt(fees.tokensOwed0);
  const tokensOwed1 = BigInt(fees.tokensOwed1);
  if (tokensOwed0 === 0n && tokensOwed1 === 0n) return 0;

  return valueAmountsUsd(tokensOwed0, tokensOwed1, token0.decimals, token1.decimals, currentTick, side);
}

export function formatUsd(value: number): string {
  if (value === 0) return '$0';
  if (value < 0.01) return '<$0.01';
  return `$${value.toLocaleString('en-US', { maximumFractionDigits: 2 })}`;
}

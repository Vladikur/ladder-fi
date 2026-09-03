import type { Address } from './types';
import { parseDecimalToFraction } from './ticks';

export interface OrientationResult {
  /** true if the user's chosen "base" token is token0 of the pool */
  baseIsToken0: boolean;
}

/**
 * token0 = the smaller address, price = token1/token0 (Uniswap convention). The user
 * thinks in base/quote, which may be inverted relative to token0/token1 - this is the
 * single point where that inversion is resolved. All math elsewhere stays in
 * token0/token1 coordinates.
 */
export function resolveOrientation(token0: Address, token1: Address, baseToken: Address): OrientationResult {
  const base = baseToken.toLowerCase();
  const t0 = token0.toLowerCase();
  const t1 = token1.toLowerCase();
  if (base === t0) return { baseIsToken0: true };
  if (base === t1) return { baseIsToken0: false };
  throw new Error('baseToken must be either token0 or token1 of the pool');
}

/**
 * Maps the user-facing "ask" (selling base as its price rises) / "bid" (buying base as
 * its price falls) intent to the internal tick-space side ('upper' = above active tick,
 * pure token0; 'lower' = below, pure token1). When base = token1, the price of base in
 * quote terms is the *inverse* of the pool's token1/token0 price, so rising base-price
 * corresponds to the pool price falling - the ask ladder sits below the active tick.
 */
export function ladderSideFor(intent: 'ask' | 'bid', baseIsToken0: boolean): 'upper' | 'lower' {
  if (baseIsToken0) {
    return intent === 'ask' ? 'upper' : 'lower';
  }
  return intent === 'ask' ? 'lower' : 'upper';
}

/**
 * Converts a token1/token0 price string into the user-facing quote-per-base price.
 * Identity when base = token0; reciprocal (computed as an exact bigint fraction, no
 * floats) when base = token1.
 */
export function toUserFacingPrice(token1PerToken0: string, baseIsToken0: boolean, precision = 18): string {
  if (baseIsToken0) return token1PerToken0;
  const { num, den } = parseDecimalToFraction(token1PerToken0);
  if (num === 0n) throw new Error('Cannot invert a zero price');
  const scale = 10n ** BigInt(precision);
  const scaled = (den * scale) / num;
  return formatScaledFraction(scaled, precision);
}

/** Converts a user-facing quote-per-base price string back into token1/token0 terms. */
export function fromUserFacingPrice(quotePerBase: string, baseIsToken0: boolean, precision = 18): string {
  // Inversion is its own inverse.
  return baseIsToken0 ? quotePerBase : toUserFacingPrice(quotePerBase, false, precision);
}

function formatScaledFraction(value: bigint, precision: number): string {
  const s = value.toString().padStart(precision + 1, '0');
  const intPart = s.slice(0, s.length - precision) || '0';
  const fracPart = s.slice(s.length - precision).replace(/0+$/, '');
  return fracPart.length > 0 ? `${intPart}.${fracPart}` : intPart;
}

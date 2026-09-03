import JSBI from 'jsbi';
import { TickMath, encodeSqrtRatioX96, nearestUsableTick as sdkNearestUsableTick } from '@uniswap/v3-sdk';

export { sdkNearestUsableTick as nearestUsableTick };

/**
 * Parses a decimal string into an exact (numerator, denominator) bigint fraction.
 * Avoids floating point entirely - required because tick math must be exact.
 */
export function parseDecimalToFraction(input: string): { num: bigint; den: bigint } {
  const trimmed = input.trim();
  if (!/^\d+(\.\d+)?$/.test(trimmed)) {
    throw new Error(`Invalid decimal price: "${input}"`);
  }
  const [intPart, fracPart = ''] = trimmed.split('.');
  const den = 10n ** BigInt(fracPart.length);
  const num = BigInt(intPart + fracPart);
  return { num, den };
}

/**
 * Converts a human-readable price (token1 per 1 token0, decimal-adjusted) to the
 * nearest raw tick. Uses exact bigint fractions throughout, only the final
 * getTickAtSqrtRatio step uses the SDK's bit-trick approximation (as intended).
 */
export function priceToTick(humanPrice: string | number, decimals0: number, decimals1: number): number {
  const { num, den } = parseDecimalToFraction(String(humanPrice));
  // rawPrice (raw1/raw0) = humanPrice * 10^(dec1 - dec0) = (num * 10^dec1) / (den * 10^dec0)
  const rawNumerator = num * 10n ** BigInt(decimals1);
  const rawDenominator = den * 10n ** BigInt(decimals0);
  const sqrtRatioX96 = encodeSqrtRatioX96(
    JSBI.BigInt(rawNumerator.toString()),
    JSBI.BigInt(rawDenominator.toString()),
  );
  return TickMath.getTickAtSqrtRatio(sqrtRatioX96);
}

/**
 * Converts a raw tick back to a human-readable price string (token1 per 1 token0),
 * decimal-adjusted, formatted with `precision` significant fractional digits.
 * Uses bigint fixed-point arithmetic throughout - no floats.
 */
export function tickToPrice(tick: number, decimals0: number, decimals1: number, precision = 18): string {
  const sqrtX96 = TickMath.getSqrtRatioAtTick(tick);
  const sqrt = BigInt(sqrtX96.toString());
  const Q96 = 1n << 96n;
  // rawPrice = (sqrt/2^96)^2 = sqrt^2 / 2^192
  // humanPrice = rawPrice * 10^(dec0 - dec1)
  // We scale by 10^precision before dividing to keep fractional precision, then format.
  const scale = 10n ** BigInt(precision);
  const decAdjustNum = decimals0 >= decimals1 ? 10n ** BigInt(decimals0 - decimals1) : 1n;
  const decAdjustDen = decimals1 > decimals0 ? 10n ** BigInt(decimals1 - decimals0) : 1n;

  const numerator = sqrt * sqrt * decAdjustNum * scale;
  const denominator = (Q96 * Q96) * decAdjustDen;
  const scaledResult = numerator / denominator;

  return formatScaled(scaledResult, precision);
}

function formatScaled(value: bigint, precision: number): string {
  const negative = value < 0n;
  const abs = negative ? -value : value;
  const s = abs.toString().padStart(precision + 1, '0');
  const intPart = s.slice(0, s.length - precision) || '0';
  const fracPart = s.slice(s.length - precision).replace(/0+$/, '');
  const sign = negative ? '-' : '';
  return fracPart.length > 0 ? `${sign}${intPart}.${fracPart}` : `${sign}${intPart}`;
}

/** Clamps a tick to the valid SDK range before rounding, so callers never hit the nearestUsableTick invariant. */
export function clampTick(tick: number): number {
  if (tick < TickMath.MIN_TICK) return TickMath.MIN_TICK;
  if (tick > TickMath.MAX_TICK) return TickMath.MAX_TICK;
  return tick;
}

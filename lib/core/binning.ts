import { nearestUsableTick } from './ticks';
import type { BinSpec, LadderBuildInput, LadderBuildResult, PlanWarning, RangeSliceInput, RangeSliceResult } from './types';

export class RangeTooNarrowError extends Error {
  constructor(public readonly maxN: number) {
    super(`Range is too narrow for the requested bin count. Maximum N for this range/spacing is ${maxN}.`);
    this.name = 'RangeTooNarrowError';
  }
}

/**
 * tickLowerG = nearestUsableTick(priceToTick(Pmin), spacing)
 * tickUpperG = nearestUsableTick(priceToTick(Pmax), spacing)
 * span is always a whole number of tickSpacing units (both bounds are already
 * spacing-aligned), so slicing it into N bins leaves a 0..N-1 unit remainder. That
 * remainder is handed back as remainderSpacings rather than dropped: buildLadder widens
 * the N bins nearest tickUpperG by one tickSpacing each to absorb it, so the top
 * boundary always lands exactly on tickUpperG instead of undershooting it.
 */
export function sliceRange(input: RangeSliceInput): RangeSliceResult {
  const { tickLowerG, tickUpperG, n, tickSpacing } = input;
  if (tickUpperG <= tickLowerG) {
    throw new Error('tickUpperG must be greater than tickLowerG');
  }
  if (n <= 0) {
    throw new Error('n must be positive');
  }
  const span = tickUpperG - tickLowerG;
  const spacingUnits = Math.floor(span / tickSpacing);
  const binWidth = Math.floor(spacingUnits / n) * tickSpacing;
  if (binWidth < tickSpacing) {
    throw new RangeTooNarrowError(Math.max(1, spacingUnits));
  }
  const remainderSpacings = spacingUnits % n;
  const actualTickUpperG = tickLowerG + n * binWidth + remainderSpacings * tickSpacing;
  return { binWidth, remainderSpacings, actualTickUpperG };
}

/**
 * Splits the sliced [tickLowerG, actualTickUpperG] range into N bins - binWidth wide,
 * except the remainderSpacings bins nearest tickUpperG which are one tickSpacing wider
 * (see sliceRange) - then classifies each as 'upper' (ask, pure token0) or 'lower'
 * (bid, pure token1) relative to the active tick, dropping any bin that overlaps the
 * configurable gap around the active price ("Активный бин пропускается").
 *
 * Bins on each side are re-indexed by distance from the active tick, 0 = nearest.
 */
export function buildLadder(input: LadderBuildInput): LadderBuildResult {
  const { tickLowerG, binWidth, remainderSpacings, n, tickSpacing, currentTick, gapSpacings } = input;
  const warnings: PlanWarning[] = [];

  const clampedCurrentTick = Math.max(-887272, Math.min(887272, currentTick));
  const activeRounded = nearestUsableTick(clampedCurrentTick, tickSpacing);
  const gapTicks = Math.max(1, gapSpacings) * tickSpacing;
  const gapLowerBound = activeRounded - gapTicks; // lower-side bins must end at or before this
  const gapUpperBound = activeRounded + gapTicks; // upper-side bins must start at or above this

  const upperRaw: Omit<BinSpec, 'index'>[] = [];
  const lowerRaw: Omit<BinSpec, 'index'>[] = [];
  let dropped = 0;

  // The remainderSpacings bins nearest tickUpperG (highest j) each get one extra
  // tickSpacing so the cumulative width exactly consumes the leftover from sliceRange.
  let tickLower = tickLowerG;
  for (let j = 0; j < n; j++) {
    const width = j >= n - remainderSpacings ? binWidth + tickSpacing : binWidth;
    const tickUpper = tickLower + width;
    if (tickLower >= gapUpperBound) {
      upperRaw.push({ side: 'upper', tickLower, tickUpper });
    } else if (tickUpper <= gapLowerBound) {
      lowerRaw.push({ side: 'lower', tickLower, tickUpper });
    } else {
      dropped++;
    }
    tickLower = tickUpper;
  }

  if (dropped > 0) {
    warnings.push({
      code: 'n-reduced',
      message: `${dropped} bin(s) overlapping the active-price gap were dropped; ${upperRaw.length} ask + ${lowerRaw.length} bid bins remain.`,
    });
  }

  // upper: nearest to price = smallest tickLower = index 0 -> already ascending by construction
  const upper: BinSpec[] = upperRaw.map((b, i) => ({ ...b, index: i }));
  // lower: nearest to price = largest tickUpper = last pushed -> reverse for index 0 = nearest
  const lower: BinSpec[] = [...lowerRaw].reverse().map((b, i) => ({ ...b, index: i }));

  return { upper, lower, warnings };
}

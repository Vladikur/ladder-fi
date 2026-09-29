import { buildLadder, sliceRange, RangeTooNarrowError } from './binning';
import { splitAmountByWeights, sizePositions } from './amounts';
import { clampTick, nearestUsableTick, priceToTick, tickToPrice } from './ticks';
import { computeWeights } from './weights';
import { fromUserFacingPrice, ladderSideFor, resolveOrientation, toUserFacingPrice } from './orientation';
import type { Address, DepositMode, LadderSide, PlanWarning, RawPoolState, Strategy } from './types';

export { RangeTooNarrowError };

export interface PlanInput {
  chainId: number;
  pool: RawPoolState;
  /** which of token0/token1 the user calls "base" */
  baseToken: Address;
  strategy: Strategy;
  alpha: number;
  depositMode: DepositMode;
  /** total bins across the whole [priceMin, priceMax] range, before the active-gap split */
  n: number;
  /** user-facing quote-per-base prices, decimal strings */
  priceMin: string;
  priceMax: string;
  /** gap around the active price, in units of tickSpacing */
  gapSpacings: number;
  /** raw amount of the base token to deposit, 0n if depositMode excludes it */
  baseAmount: bigint;
  /** raw amount of the quote token to deposit, 0n if depositMode excludes it */
  quoteAmount: bigint;
  slippageBps: number;
}

export interface PlanBin {
  index: number;
  side: LadderSide;
  /** 'ask' = selling base as its price rises, 'bid' = buying base as its price falls */
  label: 'ask' | 'bid';
  tickLower: number;
  tickUpper: number;
  priceLower: string;
  priceUpper: string;
  amount0: bigint;
  amount1: bigint;
  amount0Min: bigint;
  amount1Min: bigint;
  liquidity: bigint;
}

export interface PlanResult {
  bins: PlanBin[];
  tickLowerG: number;
  actualTickUpperG: number;
  actualPriceLower: string;
  actualPriceUpper: string;
  /** current pool price, in the same user-facing quote-per-base terms as actualPriceLower/Upper */
  currentPrice: string;
  binWidth: number;
  warnings: PlanWarning[];
  totals: { amount0: bigint; amount1: bigint };
  /** true if the user's chosen "base" token is token0 of the pool; needed to map amount0/amount1 back to base/quote */
  baseIsToken0: boolean;
}

function computeGlobalTickRange(
  priceMinUser: string,
  priceMaxUser: string,
  baseIsToken0: boolean,
  decimals0: number,
  decimals1: number,
  spacing: number,
): { tickLowerG: number; tickUpperG: number } {
  const t1t0Min = fromUserFacingPrice(priceMinUser, baseIsToken0);
  const t1t0Max = fromUserFacingPrice(priceMaxUser, baseIsToken0);
  const tickA = nearestUsableTick(clampTick(priceToTick(t1t0Min, decimals0, decimals1)), spacing);
  const tickB = nearestUsableTick(clampTick(priceToTick(t1t0Max, decimals0, decimals1)), spacing);
  return { tickLowerG: Math.min(tickA, tickB), tickUpperG: Math.max(tickA, tickB) };
}

export function buildPlan(input: PlanInput): PlanResult {
  const { chainId, pool, baseToken, strategy, alpha, n, priceMin, priceMax, gapSpacings, baseAmount, quoteAmount, slippageBps } =
    input;

  const { baseIsToken0 } = resolveOrientation(pool.token0.address, pool.token1.address, baseToken);
  const dec0 = pool.token0.decimals;
  const dec1 = pool.token1.decimals;

  const { tickLowerG, tickUpperG } = computeGlobalTickRange(priceMin, priceMax, baseIsToken0, dec0, dec1, pool.tickSpacing);
  const { binWidth, remainderSpacings, actualTickUpperG } = sliceRange({ tickLowerG, tickUpperG, n, tickSpacing: pool.tickSpacing });

  const ladder = buildLadder({
    tickLowerG,
    binWidth,
    remainderSpacings,
    n,
    tickSpacing: pool.tickSpacing,
    currentTick: pool.tick,
    gapSpacings,
  });

  const token0Amount = baseIsToken0 ? baseAmount : quoteAmount;
  const token1Amount = baseIsToken0 ? quoteAmount : baseAmount;

  const upperWeights = computeWeights(ladder.upper.length, alpha, strategy);
  const lowerWeights = computeWeights(ladder.lower.length, alpha, strategy);

  const upperDesired = splitAmountByWeights(token0Amount, upperWeights);
  const lowerDesired = splitAmountByWeights(token1Amount, lowerWeights);

  const sizedUpper = sizePositions({
    chainId,
    pool,
    bins: ladder.upper,
    side: 'upper',
    desiredAmounts: upperDesired,
    slippageBps,
  });
  const sizedLower = sizePositions({
    chainId,
    pool,
    bins: ladder.lower,
    side: 'lower',
    desiredAmounts: lowerDesired,
    slippageBps,
  });

  const warnings = [...ladder.warnings];

  const askSide = ladderSideFor('ask', baseIsToken0);
  const upperLabel = askSide === 'upper' ? 'ask' : 'bid';
  const lowerLabel = askSide === 'lower' ? 'ask' : 'bid';
  const baseSymbol = baseIsToken0 ? pool.token0.symbol : pool.token1.symbol;
  const quoteSymbol = baseIsToken0 ? pool.token1.symbol : pool.token0.symbol;

  // An ask bin only ever holds the base token and a bid bin only the quote token, so a
  // range sitting wholly on one side of the active price cannot be funded from the other
  // - the resulting all-zero plan is correct but reads like a rounding failure.
  const warnUnfunded = (label: 'ask' | 'bid', count: number) => {
    const [needed, other] = label === 'ask' ? [baseSymbol, quoteSymbol] : [quoteSymbol, baseSymbol];
    const [here, there] = label === 'ask' ? ['above', 'below'] : ['below', 'above'];
    warnings.push({
      code: 'side-unfunded',
      message: `${count} ${label} bin(s) sit ${here} the current price and can only hold ${needed}, but the deposit contains no ${needed}. Deposit ${needed}, or move the price range ${there} the current price to fund it with ${other}.`,
    });
  };

  const dustBins: string[] = [];
  if (sizedUpper.length > 0 && token0Amount === 0n) {
    warnUnfunded(upperLabel, sizedUpper.length);
  } else {
    sizedUpper.forEach((b, i) => {
      if ((upperWeights[i] ?? 0) > 0 && b.amount0 === 0n) dustBins.push(`${upperLabel} #${i}`);
    });
  }
  if (sizedLower.length > 0 && token1Amount === 0n) {
    warnUnfunded(lowerLabel, sizedLower.length);
  } else {
    sizedLower.forEach((b, i) => {
      if ((lowerWeights[i] ?? 0) > 0 && b.amount1 === 0n) dustBins.push(`${lowerLabel} #${i}`);
    });
  }
  if (dustBins.length > 0) {
    warnings.push({
      code: 'dust-amount',
      message: `${dustBins.length} bin(s) rounded to zero after distribution: ${dustBins.join(', ')}.`,
    });
  }

  const toBin = (side: LadderSide) => (b: (typeof sizedUpper)[number]): PlanBin => ({
    index: b.bin.index,
    side,
    label: askSide === side ? 'ask' : 'bid',
    tickLower: b.bin.tickLower,
    tickUpper: b.bin.tickUpper,
    priceLower: toUserFacingPrice(tickToPrice(b.bin.tickLower, dec0, dec1), baseIsToken0),
    priceUpper: toUserFacingPrice(tickToPrice(b.bin.tickUpper, dec0, dec1), baseIsToken0),
    amount0: b.amount0,
    amount1: b.amount1,
    amount0Min: b.amount0Min,
    amount1Min: b.amount1Min,
    liquidity: b.liquidity,
  });

  const bins = [...sizedUpper.map(toBin('upper')), ...sizedLower.map(toBin('lower'))];

  const totals = bins.reduce(
    (acc, b) => ({ amount0: acc.amount0 + b.amount0, amount1: acc.amount1 + b.amount1 }),
    { amount0: 0n, amount1: 0n },
  );

  const rawPriceLower = tickToPrice(tickLowerG, dec0, dec1);
  const rawPriceUpper = tickToPrice(actualTickUpperG, dec0, dec1);
  const priceA = toUserFacingPrice(rawPriceLower, baseIsToken0);
  const priceB = toUserFacingPrice(rawPriceUpper, baseIsToken0);
  const currentPrice = toUserFacingPrice(tickToPrice(pool.tick, dec0, dec1), baseIsToken0);

  return {
    bins,
    tickLowerG,
    actualTickUpperG,
    // baseIsToken0=false inverts ordering, so re-sort for display
    actualPriceLower: baseIsToken0 ? priceA : priceB,
    actualPriceUpper: baseIsToken0 ? priceB : priceA,
    currentPrice,
    binWidth,
    warnings,
    totals,
    baseIsToken0,
  };
}

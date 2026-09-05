import type { PositionView } from './types';

export type RangedPosition = PositionView & { rangeStatus: 'in-range' | 'above-range' | 'below-range' };

/** Shared by the client-side positions fetch and (formerly) the /api/positions route. */
export function toPositionsResult(rawPositions: PositionView[]): { positions: RangedPosition[]; aggregate: Record<string, unknown> } {
  const positions = rawPositions.map((p) => {
    const rangeStatus: RangedPosition['rangeStatus'] = p.inRange ? 'in-range' : p.currentTick >= p.tickUpper ? 'above-range' : 'below-range';
    return { ...p, rangeStatus };
  });

  const aggregate = {
    total: positions.length,
    inRange: positions.filter((p) => p.rangeStatus === 'in-range').length,
  };

  return { positions, aggregate };
}

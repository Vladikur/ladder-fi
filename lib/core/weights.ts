import type { Strategy } from './types';

/**
 * Returns normalized weights ŵ_j for j = 0..n-1 (0 = nearest to the active price).
 * Weight *shape* is inherently a real-number computation (fractional alpha exponent),
 * so this returns floats. Money arithmetic that consumes these weights must convert
 * them to an exact bigint fraction first - see toIntegerWeights below.
 */
export function computeWeights(n: number, alpha: number, strategy: Strategy): number[] {
  if (n <= 0) return [];
  const raw: number[] = [];
  for (let j = 0; j < n; j++) {
    let w: number;
    switch (strategy) {
      case 'bid-ask':
        w = Math.pow((j + 1) / n, alpha);
        break;
      case 'spot':
        w = 1;
        break;
      case 'curve':
        w = Math.pow((n - j) / n, alpha);
        break;
    }
    raw.push(w);
  }
  const sum = raw.reduce((a, b) => a + b, 0);
  if (sum === 0) return raw.map(() => 1 / n);
  return raw.map((w) => w / sum);
}

/**
 * Converts normalized float weights into an exact bigint fraction (numerators over a
 * shared power-of-ten denominator) so downstream amount math stays in bigint only.
 */
export function toIntegerWeights(weights: number[], precisionDigits = 15): { numerators: bigint[]; denominator: bigint } {
  const denominator = 10n ** BigInt(precisionDigits);
  const numerators = weights.map((w) => BigInt(Math.round(w * Number(denominator))));
  return { numerators, denominator };
}

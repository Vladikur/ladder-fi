/** Truncates (not rounds) a decimal string to at most `maxDecimals` digits after the
 *  point - display-only, never used for on-chain math. tickToPrice can return up to 18
 *  fractional digits (or a huge integer part for an edge/empty-pool tick), which reads
 *  as noise in a table. */
export function truncateDecimals(value: string, maxDecimals = 10): string {
  const dot = value.indexOf('.');
  if (dot === -1) return value;
  const fracLen = value.length - dot - 1;
  if (fracLen <= maxDecimals) return value;
  return value.slice(0, dot + 1 + maxDecimals);
}

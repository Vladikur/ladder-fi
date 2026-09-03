'use client';

import { useEffect, useState } from 'react';
import { useAppToken } from './AppTokenProvider';
import { searchPools, type PoolListItem } from '@/lib/api-client';
import { tickToPrice } from '@/lib/core';
import { getChain } from '@/lib/registry/chains';
import { estimatePoolLiquidityUsd, formatUsd } from '@/lib/valuation';
import { truncateDecimals } from '@/lib/format';

const FEE_LABELS: Record<number, string> = { 100: '0.01%', 500: '0.05%', 3000: '0.3%', 10000: '1%' };

export function PoolSearch({
  chainId,
  protocol,
  explorerUrl,
  token,
  onTokenChange,
  onSelect,
}: {
  chainId: number;
  protocol: string;
  explorerUrl: string;
  token: string;
  onTokenChange: (value: string) => void;
  onSelect: (pool: PoolListItem) => void;
}) {
  const appToken = useAppToken();
  const notionalToken = getChain(chainId).notionalToken;
  const [manualPool, setManualPool] = useState('');
  const [results, setResults] = useState<PoolListItem[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function runSearch() {
    setLoading(true);
    setError(null);
    try {
      const pools = await searchPools(appToken, { chainId, protocol, token: token.trim() });
      setResults(pools);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Search failed');
      setResults(null);
    } finally {
      setLoading(false);
    }
  }

  // Restore results after a reload that carried the token over via query params.
  useEffect(() => {
    if (token.trim()) void runSearch();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function runManualLookup(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError(null);
    try {
      const pools = await searchPools(appToken, { chainId, protocol, poolId: manualPool.trim() });
      setResults(pools);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Lookup failed');
      setResults(null);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="space-y-4 rounded-lg border border-neutral-800 bg-neutral-900 p-4">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void runSearch();
        }}
        className="flex flex-wrap items-end gap-2"
      >
        <label className="flex flex-col gap-1 text-sm">
          Token address
          <input
            value={token}
            onChange={(e) => onTokenChange(e.target.value)}
            placeholder="0x..."
            className="w-96 rounded border border-neutral-700 bg-neutral-950 px-2 py-1 font-mono text-xs"
          />
        </label>
        <button type="submit" disabled={loading || !token} className="rounded bg-blue-600 px-3 py-1.5 text-sm font-medium disabled:opacity-40">
          Search pools
        </button>
        {loading && (
          <span className="flex items-center gap-1 text-xs text-neutral-400">
            <span className="h-3 w-3 animate-spin rounded-full border-2 border-neutral-500 border-t-transparent" />
            Loading…
          </span>
        )}
      </form>

      <form onSubmit={runManualLookup} className="flex items-end gap-2">
        <label className="flex flex-col gap-1 text-sm">
          Manual pool address or PoolId (fallback)
          <input
            value={manualPool}
            onChange={(e) => setManualPool(e.target.value)}
            placeholder="0x... (address for v3, 32-byte PoolId for v4)"
            className="w-96 rounded border border-neutral-700 bg-neutral-950 px-2 py-1 font-mono text-xs"
          />
        </label>
        <button type="submit" disabled={loading || !manualPool} className="rounded bg-neutral-700 px-3 py-1.5 text-sm font-medium disabled:opacity-40">
          Look up
        </button>
      </form>

      {error && <p className="text-sm text-red-400">{error}</p>}

      {results && (
        <div className="max-h-[13rem] overflow-y-auto">
          <table className="w-full text-sm">
            <thead className="sticky top-0 bg-neutral-900 text-left text-neutral-400">
              <tr>
                <th className="pb-1">Pair</th>
                <th className="pb-1">Fee</th>
                <th className="pb-1">Price (token1/token0)</th>
                <th className="pb-1">Liquidity</th>
                <th className="pb-1">Explorer</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {results.map((p) => {
                const price = truncateDecimals(tickToPrice(p.state.tick, p.state.token0.decimals, p.state.token1.decimals));
                // p.ref.id is a real contract address for v3 (40 hex chars) but a 32-byte
                // PoolId for v4 (64 hex chars) - only the former has its own explorer page.
                const isContractAddress = p.ref.id.length === 42;
                const usd = estimatePoolLiquidityUsd(p.state, notionalToken);
                return (
                  <tr key={p.ref.id} className="cursor-pointer border-t border-neutral-800 hover:bg-neutral-800/50" onClick={() => onSelect(p)}>
                    <td className="py-1.5 font-mono">
                      {p.state.token0.symbol}/{p.state.token1.symbol}
                    </td>
                    <td className="py-1.5">{FEE_LABELS[p.state.fee] ?? `${p.state.fee / 10000}%`}</td>
                    <td className="py-1.5 font-mono">{price}</td>
                    <td className="py-1.5 font-mono">{usd !== null ? formatUsd(usd) : p.state.liquidity.toString()}</td>
                    <td className="py-1.5">
                      {isContractAddress ? (
                        <a
                          href={`${explorerUrl}/address/${p.ref.id}`}
                          target="_blank"
                          rel="noreferrer"
                          onClick={(e) => e.stopPropagation()}
                          className="text-blue-400 underline"
                        >
                          view
                        </a>
                      ) : (
                        '-'
                      )}
                    </td>
                    <td className="py-1.5 text-right text-blue-400">select →</td>
                  </tr>
                );
              })}
              {results.length === 0 && (
                <tr>
                  <td colSpan={6} className="py-2 text-neutral-500">
                    No pools found for this token.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

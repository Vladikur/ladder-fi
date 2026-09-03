'use client';

import { useEffect, useState } from 'react';
import { useAppToken } from './AppTokenProvider';
import { listPositions, collectPositions, withdrawPositions } from '@/lib/api-client';
import type { PositionView } from '@/lib/adapters/types';
import { getChain } from '@/lib/registry/chains';
import { estimatePositionLiquidityUsd, estimateFeesUsd, formatUsd } from '@/lib/valuation';
import { tickToPrice } from '@/lib/core';
import { truncateDecimals } from '@/lib/format';

type Row = PositionView & { rangeStatus: string; worked: boolean | null; label: string | null };

export function PositionsPanel({ chainId, protocol, poolId }: { chainId: number; protocol: string; poolId?: string }) {
  const appToken = useAppToken();
  const notionalToken = getChain(chainId).notionalToken;
  const [rows, setRows] = useState<Row[]>([]);
  const [aggregate, setAggregate] = useState<Record<string, unknown> | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function refresh() {
    setLoading(true);
    try {
      const data = await listPositions(appToken, { chainId, protocol, poolId });
      setRows(data.positions);
      setAggregate(data.aggregate);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load positions');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void refresh();
    const interval = setInterval(() => void refresh(), 10_000);
    return () => clearInterval(interval);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chainId, protocol, poolId]);

  const firstRow = rows[0];
  const currentPrice = firstRow ? tickToPrice(firstRow.currentTick, firstRow.token0.decimals, firstRow.token1.decimals) : null;

  function toggle(tokenId: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(tokenId)) next.delete(tokenId);
      else next.add(tokenId);
      return next;
    });
  }

  function toggleAll() {
    setSelected((prev) => (prev.size === rows.length ? new Set() : new Set(rows.map((r) => r.tokenId.toString()))));
  }

  async function doCollect() {
    setBusy(true);
    setError(null);
    try {
      await collectPositions(appToken, { chainId, protocol, tokenIds: [...selected] });
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Collect failed');
    } finally {
      setBusy(false);
    }
  }

  async function doWithdraw(bps: number) {
    setBusy(true);
    setError(null);
    try {
      await withdrawPositions(appToken, { chainId, protocol, tokenIds: [...selected], bps });
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Withdraw failed');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-3 rounded-lg border border-neutral-800 bg-neutral-900 p-4">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-medium">Positions</h2>
        <div className="flex items-center gap-2">
          {loading && (
            <span className="flex items-center gap-1 text-xs text-neutral-400">
              <span className="h-3 w-3 animate-spin rounded-full border-2 border-neutral-500 border-t-transparent" />
              Loading…
            </span>
          )}
          <button onClick={() => void refresh()} className="rounded bg-neutral-700 px-2 py-1 text-xs">
            Refresh
          </button>
        </div>
      </div>

      {aggregate && (
        <div className="flex gap-4 text-sm text-neutral-400">
          <span>Total: {String(aggregate.total)}</span>
          <span>In range: {String(aggregate.inRange)}</span>
          {currentPrice !== null && firstRow && (
            <span>
              Current price: <span className="font-mono">{truncateDecimals(currentPrice)}</span> ({firstRow.token1.symbol}/{firstRow.token0.symbol})
            </span>
          )}
          <span>
            Worked fraction (DCA):{' '}
            {aggregate.workedFraction === null ? 'n/a' : `${(Number(aggregate.workedFraction) * 100).toFixed(0)}%`} ({String(aggregate.workedKnown)}{' '}
            known)
          </span>
        </div>
      )}

      {error && <p className="text-sm text-red-400">{error}</p>}

      <table className="w-full text-xs">
        <thead className="text-left text-neutral-400">
          <tr>
            <th>
              <input type="checkbox" checked={rows.length > 0 && selected.size === rows.length} onChange={toggleAll} />
            </th>
            <th>Token ID</th>
            <th>Pair</th>
            <th>Price range</th>
            <th>Status</th>
            <th>Label</th>
            <th>Worked</th>
            <th>Liquidity</th>
            <th>Fees owed</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.tokenId.toString()} className="border-t border-neutral-800">
              <td>
                <input type="checkbox" checked={selected.has(r.tokenId.toString())} onChange={() => toggle(r.tokenId.toString())} />
              </td>
              <td className="font-mono">{r.tokenId.toString()}</td>
              <td>
                {r.token0.symbol}/{r.token1.symbol}
              </td>
              <td className="font-mono">
                {truncateDecimals(tickToPrice(r.tickLower, r.token0.decimals, r.token1.decimals))} →{' '}
                {truncateDecimals(tickToPrice(r.tickUpper, r.token0.decimals, r.token1.decimals))}
              </td>
              <td>{r.rangeStatus}</td>
              <td>{r.label ?? '-'}</td>
              <td>{r.worked === null ? '-' : r.worked ? 'yes' : 'no'}</td>
              <td className="font-mono">
                {(() => {
                  const usd = estimatePositionLiquidityUsd(
                    {
                      token0: r.token0,
                      token1: r.token1,
                      fee: r.fee,
                      tickSpacing: r.ref.tickSpacing,
                      tickLower: r.tickLower,
                      tickUpper: r.tickUpper,
                      currentTick: r.currentTick,
                      liquidity: r.liquidity,
                    },
                    notionalToken,
                  );
                  return usd !== null ? formatUsd(usd) : r.liquidity.toString();
                })()}
              </td>
              <td className="font-mono">
                {(() => {
                  const usd = estimateFeesUsd(
                    { token0: r.token0, token1: r.token1, currentTick: r.currentTick, tokensOwed0: r.tokensOwed0, tokensOwed1: r.tokensOwed1 },
                    notionalToken,
                  );
                  return usd !== null ? formatUsd(usd) : `${r.tokensOwed0} / ${r.tokensOwed1}`;
                })()}
              </td>
            </tr>
          ))}
          {rows.length === 0 && (
            <tr>
              <td colSpan={9} className="py-2 text-neutral-500">
                No positions found.
              </td>
            </tr>
          )}
        </tbody>
      </table>

      <div className="flex gap-2">
        <button disabled={busy || selected.size === 0} onClick={doCollect} className="rounded bg-blue-600 px-3 py-1.5 text-sm disabled:opacity-40">
          Collect fees
        </button>
        <button disabled={busy || selected.size === 0} onClick={() => doWithdraw(10_000)} className="rounded bg-red-700 px-3 py-1.5 text-sm disabled:opacity-40">
          Withdraw full (burn)
        </button>
        <button disabled={busy || selected.size === 0} onClick={() => doWithdraw(5_000)} className="rounded bg-neutral-700 px-3 py-1.5 text-sm disabled:opacity-40">
          Withdraw 50%
        </button>
      </div>
    </div>
  );
}

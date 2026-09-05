'use client';

import { useEffect, useState } from 'react';
import { useAccount } from 'wagmi';
import { sendTransaction, waitForTransactionReceipt } from 'wagmi/actions';
import { useAppToken } from './AppTokenProvider';
import { prepareCollect, prepareWithdraw, type SerializedCall } from '@/lib/api-client';
import { getAdapter } from '@/lib/adapters';
import type { PoolRef } from '@/lib/adapters/types';
import { toPositionsResult, type RangedPosition } from '@/lib/adapters/position-view';
import { getChain } from '@/lib/registry/chains';
import { estimatePositionLiquidityUsd, estimateFeesUsd, formatUsd } from '@/lib/valuation';
import { tickToPrice } from '@/lib/core';
import { truncateDecimals } from '@/lib/format';
import { wagmiConfig } from '@/lib/wallet/config';
import { useIsMounted } from '@/lib/wallet/use-mounted';
import { RPC_HICCUP_MESSAGE } from '@/lib/rpc/hiccup';
import { describeError } from '@/lib/rpc/errors';

type Row = RangedPosition;
type OpResult = { tokenId: string; hash: string; success: boolean; error?: string };

/** Mirrors lib/api-client.ts's withRpcHiccupRetry: one silent retry for the chain's
 *  known-flaky-RPC hiccup, since this read now hits the RPC directly instead of going
 *  through a server route that used to apply this retry on its own reads. */
async function withRpcHiccupRetry<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (describeError(err) === RPC_HICCUP_MESSAGE) {
      await new Promise((resolve) => setTimeout(resolve, 600));
      return fn();
    }
    throw err;
  }
}

// chainId deliberately not passed to either action below: wagmiConfig only ever
// registers one chain, and both actions' generics want that chain's literal id, which
// this component's plain `number` prop (chainId, threaded through only for the
// non-wagmi /api/* calls) can't satisfy - omitting it just uses the config's one chain.
async function sendCall(call: SerializedCall, onSubmitted: (hash: `0x${string}`) => void): Promise<{ hash: `0x${string}`; success: boolean }> {
  const hash = await sendTransaction(wagmiConfig, {
    to: call.to,
    data: call.data,
    value: call.value ? BigInt(call.value) : undefined,
  });
  onSubmitted(hash);
  const receipt = await waitForTransactionReceipt(wagmiConfig, { hash });
  return { hash, success: receipt.status === 'success' };
}

export function PositionsPanel({ chainId, protocol, poolRef }: { chainId: number; protocol: string; poolRef?: PoolRef }) {
  const appToken = useAppToken();
  const mounted = useIsMounted();
  const { address, isConnected } = useAccount();
  const notionalToken = getChain(chainId).notionalToken;
  const [rows, setRows] = useState<Row[]>([]);
  const [aggregate, setAggregate] = useState<Record<string, unknown> | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function refresh() {
    if (!address) return;
    setLoading(true);
    try {
      const rawPositions = await withRpcHiccupRetry(() => getAdapter(chainId, protocol).listPositions(address, poolRef));
      const { positions, aggregate } = toPositionsResult(rawPositions);
      setRows(positions);
      setAggregate(aggregate);
      setError(null);
    } catch (err) {
      setError(describeError(err));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    if (!address) {
      setRows([]);
      setAggregate(null);
      return;
    }
    void refresh();
    const interval = setInterval(() => void refresh(), 10_000);
    return () => clearInterval(interval);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chainId, protocol, poolRef, address]);

  const firstRow = rows[0];
  const currentPrice = firstRow ? tickToPrice(firstRow.currentTick, firstRow.token0.decimals, firstRow.token1.decimals) : null;

  const valued = rows.map((r) => {
    const liquidityUsd = estimatePositionLiquidityUsd(
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
    const feesUsd = estimateFeesUsd(
      { token0: r.token0, token1: r.token1, currentTick: r.currentTick, tokensOwed0: r.tokensOwed0, tokensOwed1: r.tokensOwed1 },
      notionalToken,
    );
    const yieldPct = liquidityUsd !== null && feesUsd !== null && liquidityUsd > 0 ? (feesUsd / liquidityUsd) * 100 : null;
    return { row: r, liquidityUsd, feesUsd, yieldPct };
  });

  const totalLiquidityUsd = valued.reduce((sum, v) => (v.liquidityUsd !== null ? sum + v.liquidityUsd : sum), 0);
  const totalFeesUsd = valued.reduce((sum, v) => (v.feesUsd !== null ? sum + v.feesUsd : sum), 0);
  const aggregateYieldPct = totalLiquidityUsd > 0 ? (totalFeesUsd / totalLiquidityUsd) * 100 : null;

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

  function describeFailures(results: { tokenId: string; success: boolean; error?: string }[]): string | null {
    const failed = results.filter((r) => !r.success);
    if (failed.length === 0) return null;
    const detail = failed.map((f) => `#${f.tokenId}${f.error ? ` (${f.error})` : ''}`).join(', ');
    return `${failed.length} of ${results.length} failed: ${detail}`;
  }

  async function doCollect() {
    if (!address) return;
    setBusy(true);
    setError(null);
    try {
      const tokenIds = [...selected];
      const { chunks } = await prepareCollect(appToken, { chainId, protocol, owner: address, tokenIds });
      const results: OpResult[] = [];
      for (let i = 0; i < chunks.length; i++) {
        const tokenId = tokenIds[i]!;
        setProgress(`Sending ${i + 1} of ${chunks.length}…`);
        try {
          const { hash, success } = await sendCall(chunks[i]![0]!, (hash) => setProgress(`Waiting for confirmation… ${hash}`));
          results.push({ tokenId, hash, success });
        } catch (err) {
          results.push({ tokenId, hash: '', success: false, error: err instanceof Error ? err.message : 'Unknown error' });
        }
      }
      await refresh();
      setError(describeFailures(results));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Collect failed');
    } finally {
      setProgress(null);
      setBusy(false);
    }
  }

  async function doWithdraw(bps: number) {
    if (!address) return;
    setBusy(true);
    setError(null);
    try {
      const tokenIds = [...selected];
      const { chunks, chunkSize } = await prepareWithdraw(appToken, { chainId, protocol, owner: address, tokenIds, bps });
      const results: OpResult[] = [];
      for (let i = 0; i < chunks.length; i++) {
        const tokenIdsInChunk = tokenIds.slice(i * chunkSize, (i + 1) * chunkSize);
        setProgress(`Sending ${i + 1} of ${chunks.length}…`);
        try {
          const { hash, success } = await sendCall(chunks[i]![0]!, (hash) => setProgress(`Waiting for confirmation… ${hash}`));
          for (const tokenId of tokenIdsInChunk) results.push({ tokenId, hash, success });
        } catch (err) {
          const message = err instanceof Error ? err.message : 'Unknown error';
          for (const tokenId of tokenIdsInChunk) results.push({ tokenId, hash: '', success: false, error: message });
        }
      }
      await refresh();
      setError(describeFailures(results));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Withdraw failed');
    } finally {
      setProgress(null);
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
          <span>Current yield: {aggregateYieldPct !== null ? `${aggregateYieldPct.toFixed(2)}%` : 'n/a'}</span>
        </div>
      )}

      {progress && <p className="text-sm text-neutral-400">{progress}</p>}
      {error && <p className="text-sm text-red-400">{error}</p>}

      {!mounted || !isConnected ? (
        <p className="text-sm text-amber-400">Connect a wallet to view and manage positions.</p>
      ) : (
        <>
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
                <th>Liquidity</th>
                <th>Fees owed</th>
                <th>Yield</th>
              </tr>
            </thead>
            <tbody>
              {valued.map(({ row: r, liquidityUsd, feesUsd, yieldPct }) => (
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
                  <td className="font-mono">{liquidityUsd !== null ? formatUsd(liquidityUsd) : r.liquidity.toString()}</td>
                  <td className="font-mono">{feesUsd !== null ? formatUsd(feesUsd) : `${r.tokensOwed0} / ${r.tokensOwed1}`}</td>
                  <td className="font-mono">{yieldPct !== null ? `${yieldPct.toFixed(2)}%` : '-'}</td>
                </tr>
              ))}
              {rows.length === 0 && (
                <tr>
                  <td colSpan={8} className="py-2 text-neutral-500">
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
        </>
      )}
    </div>
  );
}

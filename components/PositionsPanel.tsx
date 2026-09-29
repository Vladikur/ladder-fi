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
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Spinner } from '@/components/ui/spinner';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';

type Row = RangedPosition;
type OpResult = { tokenId: string; hash: string; success: boolean; error?: string };

const REFRESH_INTERVAL_MS = 30_000;

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
  const [secondsUntilRefresh, setSecondsUntilRefresh] = useState<number | null>(null);

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
      setSecondsUntilRefresh(REFRESH_INTERVAL_MS / 1000);
    }
  }

  useEffect(() => {
    if (!address) {
      setRows([]);
      setAggregate(null);
      setSecondsUntilRefresh(null);
      return;
    }
    void refresh();

    // Only poll while the tab is visible, to avoid hammering the shared public RPC
    // from backgrounded tabs; refresh immediately when the tab regains focus instead.
    // The 1s tick just drives the "next update in Ns" countdown shown next to Refresh.
    let pollInterval: ReturnType<typeof setInterval> | null = null;
    let tickInterval: ReturnType<typeof setInterval> | null = null;
    function startTimers() {
      if (pollInterval) return;
      pollInterval = setInterval(() => void refresh(), REFRESH_INTERVAL_MS);
      tickInterval = setInterval(() => {
        setSecondsUntilRefresh((s) => (s === null ? null : Math.max(0, s - 1)));
      }, 1000);
    }
    function stopTimers() {
      if (pollInterval) {
        clearInterval(pollInterval);
        pollInterval = null;
      }
      if (tickInterval) {
        clearInterval(tickInterval);
        tickInterval = null;
      }
    }
    function handleVisibilityChange() {
      if (document.visibilityState === 'visible') {
        void refresh();
        startTimers();
      } else {
        stopTimers();
      }
    }

    if (document.visibilityState === 'visible') startTimers();
    document.addEventListener('visibilitychange', handleVisibilityChange);

    return () => {
      stopTimers();
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
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
    <Card>
      <CardContent className="space-y-3">
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-medium">Positions</h2>
          <div className="flex items-center gap-2">
            {loading && (
              <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
                <Spinner className="size-3" />
                Loading…
              </span>
            )}
            {!loading && secondsUntilRefresh !== null && (
              <span className="text-xs text-muted-foreground">Next update in {secondsUntilRefresh}s</span>
            )}
            <Button onClick={() => void refresh()} size="sm" variant="secondary">
              Refresh
            </Button>
          </div>
        </div>

        {aggregate && (
          <div className="flex gap-4 text-sm text-muted-foreground">
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

        {progress && <p className="text-sm text-muted-foreground">{progress}</p>}
        {error && (
          <Alert variant="destructive">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}

        {!mounted || !isConnected ? (
          <Alert>
            <AlertDescription>Connect a wallet to view and manage positions.</AlertDescription>
          </Alert>
        ) : (
          <>
            <div className="rounded-md border">
              <Table className="text-xs">
                <TableHeader>
                  <TableRow>
                    <TableHead>
                      <Checkbox checked={rows.length > 0 && selected.size === rows.length} onCheckedChange={toggleAll} />
                    </TableHead>
                    <TableHead>Token ID</TableHead>
                    <TableHead>Pair</TableHead>
                    <TableHead>Price range</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead>Liquidity</TableHead>
                    <TableHead>Fees owed</TableHead>
                    <TableHead>Yield</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {valued.map(({ row: r, liquidityUsd, feesUsd, yieldPct }) => (
                    <TableRow key={r.tokenId.toString()}>
                      <TableCell>
                        <Checkbox checked={selected.has(r.tokenId.toString())} onCheckedChange={() => toggle(r.tokenId.toString())} />
                      </TableCell>
                      <TableCell className="font-mono">{r.tokenId.toString()}</TableCell>
                      <TableCell>
                        {r.token0.symbol}/{r.token1.symbol}
                      </TableCell>
                      <TableCell className="font-mono">
                        {truncateDecimals(tickToPrice(r.tickLower, r.token0.decimals, r.token1.decimals))} →{' '}
                        {truncateDecimals(tickToPrice(r.tickUpper, r.token0.decimals, r.token1.decimals))}
                      </TableCell>
                      <TableCell>{r.rangeStatus}</TableCell>
                      <TableCell className="font-mono">{liquidityUsd !== null ? formatUsd(liquidityUsd) : r.liquidity.toString()}</TableCell>
                      <TableCell className="font-mono">{feesUsd !== null ? formatUsd(feesUsd) : `${r.tokensOwed0} / ${r.tokensOwed1}`}</TableCell>
                      <TableCell className="font-mono">{yieldPct !== null ? `${yieldPct.toFixed(2)}%` : '-'}</TableCell>
                    </TableRow>
                  ))}
                  {rows.length === 0 && (
                    <TableRow>
                      <TableCell colSpan={8} className="py-2 text-muted-foreground">
                        No positions found.
                      </TableCell>
                    </TableRow>
                  )}
                </TableBody>
              </Table>
            </div>

            <div className="flex gap-2">
              <Button disabled={busy || selected.size === 0} onClick={doCollect} size="sm">
                Collect fees
              </Button>
              <Button disabled={busy || selected.size === 0} onClick={() => doWithdraw(10_000)} size="sm" variant="destructive">
                Withdraw full (burn)
              </Button>
              <Button disabled={busy || selected.size === 0} onClick={() => doWithdraw(5_000)} size="sm" variant="secondary">
                Withdraw 50%
              </Button>
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}

'use client';

import { useEffect, useState } from 'react';
import { searchPoolsByToken, lookupPoolById, type PoolListItem } from '@/lib/adapters/pool-search';
import { addressSchema, poolIdSchema } from '@/lib/schemas';
import { tickToPrice } from '@/lib/core';
import { getChain } from '@/lib/registry/chains';
import { estimatePoolLiquidityUsd, formatUsd } from '@/lib/valuation';
import { truncateDecimals } from '@/lib/format';
import { trackEvent } from '@/lib/analytics';
import { Card, CardContent } from '@/components/ui/card';
import { Label } from '@/components/ui/label';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Spinner } from '@/components/ui/spinner';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';

const FEE_LABELS: Record<number, string> = { 100: '0.01%', 500: '0.05%', 3000: '0.3%', 10000: '1%' };

const TOKEN_HISTORY_KEY = 'ladderfi:tokenHistory';
const POOL_HISTORY_KEY = 'ladderfi:poolHistory';
const HISTORY_LIMIT = 3;

function loadHistory(key: string): string[] {
  if (typeof window === 'undefined') return [];
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

function pushHistory(key: string, value: string): string[] {
  const trimmed = value.trim();
  if (!trimmed) return loadHistory(key);
  const next = [trimmed, ...loadHistory(key).filter((v) => v.toLowerCase() !== trimmed.toLowerCase())].slice(0, HISTORY_LIMIT);
  try {
    localStorage.setItem(key, JSON.stringify(next));
  } catch {
    // ignore quota/private-mode errors - history is a convenience, not critical state
  }
  return next;
}

function shorten(value: string): string {
  return value.length > 14 ? `${value.slice(0, 8)}…${value.slice(-4)}` : value;
}

function HistoryRow({ items, onPick }: { items: string[]; onPick: (value: string) => void }) {
  if (items.length === 0) return null;
  return (
    <div className="flex flex-wrap gap-1.5">
      {items.map((item) => (
        <Button key={item} type="button" variant="outline" size="xs" title={item} onClick={() => onPick(item)} className="font-mono text-[11px] text-muted-foreground">
          {shorten(item)}
        </Button>
      ))}
    </div>
  );
}

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
  const notionalToken = getChain(chainId).notionalToken;
  const [manualPool, setManualPool] = useState('');
  const [results, setResults] = useState<PoolListItem[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [tokenHistory, setTokenHistory] = useState<string[]>([]);
  const [poolHistory, setPoolHistory] = useState<string[]>([]);

  useEffect(() => {
    setTokenHistory(loadHistory(TOKEN_HISTORY_KEY));
    setPoolHistory(loadHistory(POOL_HISTORY_KEY));
  }, []);

  async function runSearch(tokenOverride?: string) {
    if (loading) return;
    trackEvent('search_pools_by_token');
    const value = (tokenOverride ?? token).trim();
    const parsed = addressSchema.safeParse(value);
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message ?? 'Invalid token address');
      setResults(null);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const pools = await searchPoolsByToken(chainId, protocol, parsed.data);
      setResults(pools);
      setTokenHistory(pushHistory(TOKEN_HISTORY_KEY, value));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Search failed');
      setResults(null);
    } finally {
      setLoading(false);
    }
  }

  async function runManualLookup(e?: React.FormEvent, poolOverride?: string) {
    e?.preventDefault();
    if (loading) return;
    trackEvent('search_pool_by_id');
    const value = (poolOverride ?? manualPool).trim();
    const parsed = poolIdSchema.safeParse(value);
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message ?? 'Invalid pool address or PoolId');
      setResults(null);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const pool = await lookupPoolById(chainId, protocol, parsed.data);
      setResults([pool]);
      setPoolHistory(pushHistory(POOL_HISTORY_KEY, value));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Lookup failed');
      setResults(null);
    } finally {
      setLoading(false);
    }
  }

  function pickTokenHistory(value: string) {
    onTokenChange(value);
    void runSearch(value);
  }

  function pickPoolHistory(value: string) {
    setManualPool(value);
    void runManualLookup(undefined, value);
  }

  return (
    <Card>
      <CardContent className="space-y-4">
        <div className="flex flex-wrap items-start gap-6">
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void runSearch();
            }}
            className="flex flex-col gap-1.5"
          >
            <div className="flex items-end gap-2">
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="token-address">Token address</Label>
                <Input
                  id="token-address"
                  value={token}
                  onChange={(e) => onTokenChange(e.target.value)}
                  placeholder="0x..."
                  className="w-96 font-mono text-xs"
                />
              </div>
              <Button type="submit" disabled={loading || !token}>
                Search pools
              </Button>
            </div>
            <HistoryRow items={tokenHistory} onPick={pickTokenHistory} />
          </form>

          <form onSubmit={runManualLookup} className="flex flex-col gap-1.5">
            <div className="flex items-end gap-2">
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="manual-pool">Manual pool address or PoolId (fallback)</Label>
                <Input
                  id="manual-pool"
                  value={manualPool}
                  onChange={(e) => setManualPool(e.target.value)}
                  placeholder="0x... (address for v3, 32-byte PoolId for v4)"
                  className="w-96 font-mono text-xs"
                />
              </div>
              <Button type="submit" variant="secondary" disabled={loading || !manualPool}>
                Look up
              </Button>
            </div>
            <HistoryRow items={poolHistory} onPick={pickPoolHistory} />
          </form>
        </div>

        {loading && (
          <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <Spinner className="size-3" />
            Loading…
          </span>
        )}

        {error && (
          <Alert variant="destructive">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}

        {results && (
          <div className="max-h-[13rem] overflow-y-auto rounded-md border">
            <Table>
              <TableHeader className="sticky top-0 z-10 bg-card">
                <TableRow>
                  <TableHead>Pair</TableHead>
                  <TableHead>Fee</TableHead>
                  <TableHead>Price (token1/token0)</TableHead>
                  <TableHead>Liquidity</TableHead>
                  <TableHead>Explorer</TableHead>
                  <TableHead />
                </TableRow>
              </TableHeader>
              <TableBody>
                {results.map((p) => {
                  const price = truncateDecimals(tickToPrice(p.state.tick, p.state.token0.decimals, p.state.token1.decimals));
                  // p.ref.id is a real contract address for v3 (40 hex chars) but a 32-byte
                  // PoolId for v4 (64 hex chars) - only the former has its own explorer page.
                  const isContractAddress = p.ref.id.length === 42;
                  const usd = estimatePoolLiquidityUsd(p.state, notionalToken);
                  return (
                    <TableRow key={p.ref.id} className="cursor-pointer" onClick={() => onSelect(p)}>
                      <TableCell className="font-mono">
                        {p.state.token0.symbol}/{p.state.token1.symbol}
                      </TableCell>
                      <TableCell>{FEE_LABELS[p.state.fee] ?? `${p.state.fee / 10000}%`}</TableCell>
                      <TableCell className="font-mono">{price}</TableCell>
                      <TableCell className="font-mono">{usd !== null ? formatUsd(usd) : p.state.liquidity.toString()}</TableCell>
                      <TableCell>
                        {isContractAddress ? (
                          <Button asChild variant="link" size="sm" className="h-auto p-0" onClick={(e) => e.stopPropagation()}>
                            <a href={`${explorerUrl}/address/${p.ref.id}`} target="_blank" rel="noreferrer">
                              view
                            </a>
                          </Button>
                        ) : (
                          '-'
                        )}
                      </TableCell>
                      <TableCell className="text-right text-primary">select →</TableCell>
                    </TableRow>
                  );
                })}
                {results.length === 0 && (
                  <TableRow>
                    <TableCell colSpan={6} className="py-2 text-muted-foreground">
                      No pools found for this token.
                    </TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

'use client';

import { useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useAppToken } from './AppTokenProvider';
import { getPools } from '@/lib/api-client';
import type { GeckoPoolSummary } from '@/lib/geckoterminal';
import { formatUsd } from '@/lib/valuation';
import { Card, CardContent } from '@/components/ui/card';
import { Spinner } from '@/components/ui/spinner';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';

const ON_CHAIN_ID_RE = /^0x[a-fA-F0-9]{40}$|^0x[a-fA-F0-9]{64}$/;

type SortField = 'volume' | 'liquidity' | 'change' | 'name';
type SortDir = 'asc' | 'desc';

const SORT_LABELS: Record<SortField, string> = {
  volume: '5m volume',
  liquidity: 'Liquidity',
  change: '5m change',
  name: 'Pair',
};

function sortValue(pool: GeckoPoolSummary, field: SortField): number | string {
  switch (field) {
    case 'volume':
      return pool.volumeUsd5m;
    case 'liquidity':
      return pool.reserveUsd;
    case 'change':
      return pool.priceChangePercentage5m ?? -Infinity;
    case 'name':
      return pool.name.toLowerCase();
  }
}

/** Pools list sourced from GeckoTerminal (free, no key) - trading volume and liquidity
 *  data the on-chain adapters can't provide (see lib/geckoterminal.ts). Sorting is done
 *  client-side over the fetched page so toggling direction/field is instant. */
export function GeckoPoolsTable() {
  const router = useRouter();
  const appToken = useAppToken();
  const [pools, setPools] = useState<GeckoPoolSummary[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [sortField, setSortField] = useState<SortField>('volume');
  const [sortDir, setSortDir] = useState<SortDir>('desc');

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    getPools(appToken)
      .then((result) => {
        if (!cancelled) setPools(result);
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : 'Failed to load pools from GeckoTerminal');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [appToken]);

  const sorted = useMemo(() => {
    if (!pools) return [];
    const copy = [...pools];
    copy.sort((a, b) => {
      const av = sortValue(a, sortField);
      const bv = sortValue(b, sortField);
      const cmp = av < bv ? -1 : av > bv ? 1 : 0;
      return sortDir === 'asc' ? cmp : -cmp;
    });
    return copy;
  }, [pools, sortField, sortDir]);

  function toggleSort(field: SortField) {
    if (field === sortField) {
      setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    } else {
      setSortField(field);
      setSortDir('desc');
    }
  }

  function sortIndicator(field: SortField) {
    if (field !== sortField) return null;
    return <span className="ml-1 text-muted-foreground">{sortDir === 'asc' ? '▲' : '▼'}</span>;
  }

  function handleSelect(pool: GeckoPoolSummary) {
    if (!ON_CHAIN_ID_RE.test(pool.address)) return;
    router.push(`/pools/${pool.address}`);
  }

  return (
    <Card>
      <CardContent className="space-y-4">
        <div className="flex items-center justify-between">
          <p className="text-sm text-muted-foreground">Live pool data from GeckoTerminal. Click a row to configure liquidity for that pool.</p>
        </div>

        {loading && (
          <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <Spinner className="size-3" />
            Loading pools…
          </span>
        )}

        {error && (
          <Alert variant="destructive">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}

        {!loading && !error && (
          <div className="max-h-[28rem] overflow-y-auto rounded-md border">
            <Table>
              <TableHeader className="sticky top-0 z-10 bg-card">
                <TableRow>
                  <TableHead className="cursor-pointer select-none" onClick={() => toggleSort('name')}>
                    {SORT_LABELS.name}
                    {sortIndicator('name')}
                  </TableHead>
                  <TableHead>DEX</TableHead>
                  <TableHead className="cursor-pointer select-none" onClick={() => toggleSort('volume')}>
                    {SORT_LABELS.volume}
                    {sortIndicator('volume')}
                  </TableHead>
                  <TableHead className="cursor-pointer select-none" onClick={() => toggleSort('liquidity')}>
                    {SORT_LABELS.liquidity}
                    {sortIndicator('liquidity')}
                  </TableHead>
                  <TableHead className="cursor-pointer select-none" onClick={() => toggleSort('change')}>
                    {SORT_LABELS.change}
                    {sortIndicator('change')}
                  </TableHead>
                  <TableHead />
                </TableRow>
              </TableHeader>
              <TableBody>
                {sorted.map((pool) => {
                  const linkable = ON_CHAIN_ID_RE.test(pool.address);
                  const change = pool.priceChangePercentage5m;
                  return (
                    <TableRow
                      key={pool.id}
                      className={linkable ? 'cursor-pointer' : 'opacity-50'}
                      title={linkable ? undefined : 'This pool id could not be matched to an on-chain address'}
                      onClick={() => handleSelect(pool)}
                    >
                      <TableCell className="font-mono">{pool.name}</TableCell>
                      <TableCell className="text-muted-foreground">{pool.dex}</TableCell>
                      <TableCell className="font-mono">{formatUsd(pool.volumeUsd5m)}</TableCell>
                      <TableCell className="font-mono">{formatUsd(pool.reserveUsd)}</TableCell>
                      <TableCell className={change != null && change < 0 ? 'text-destructive' : 'text-green-500'}>
                        {change != null ? `${change > 0 ? '+' : ''}${change.toFixed(2)}%` : '-'}
                      </TableCell>
                      <TableCell className="text-right text-primary">{linkable ? 'add liquidity →' : '-'}</TableCell>
                    </TableRow>
                  );
                })}
                {sorted.length === 0 && (
                  <TableRow>
                    <TableCell colSpan={6} className="py-2 text-muted-foreground">
                      No pools reported for this chain yet.
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

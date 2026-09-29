'use client';

import { Bar, BarChart, Cell, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { formatUnits } from 'viem';
import type { PlanResult, RawPoolState } from '@/lib/core';
import { truncateDecimals } from '@/lib/format';
import { Card, CardContent } from '@/components/ui/card';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';

const ASK_COLOR = '#22c55e'; // base
const BID_COLOR = '#3b82f6'; // quote

export function PreviewChart({ pool, plan }: { pool: RawPoolState; plan: PlanResult }) {
  const sorted = [...plan.bins].sort((a, b) => a.tickLower - b.tickLower);
  const data = sorted.map((bin) => ({
    tick: bin.tickLower,
    priceLower: truncateDecimals(bin.priceLower, 6),
    value: bin.side === 'upper' ? Number(formatUnits(bin.amount0, pool.token0.decimals)) : Number(formatUnits(bin.amount1, pool.token1.decimals)),
    label: bin.label,
  }));

  const mintableCount = plan.bins.filter((b) => b.amount0 > 0n || b.amount1 > 0n).length;
  const chunkCount = Math.ceil(mintableCount / 10);

  const baseDecimals = plan.baseIsToken0 ? pool.token0.decimals : pool.token1.decimals;
  const quoteDecimals = plan.baseIsToken0 ? pool.token1.decimals : pool.token0.decimals;
  const totalBase = plan.baseIsToken0 ? plan.totals.amount0 : plan.totals.amount1;
  const totalQuote = plan.baseIsToken0 ? plan.totals.amount1 : plan.totals.amount0;

  return (
    <Card>
      <CardContent className="space-y-4">
        <div className="h-64">
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={data}>
              <XAxis dataKey="priceLower" tick={{ fontSize: 10 }} angle={-40} textAnchor="end" height={50} />
              <YAxis tick={{ fontSize: 10 }} />
              <Tooltip
                contentStyle={{ backgroundColor: '#171717', borderColor: '#404040' }}
                labelStyle={{ color: '#e5e5e5' }}
                itemStyle={{ color: '#e5e5e5' }}
                formatter={(value: number, _name, item) => [value, item.payload.label === 'ask' ? 'ask (base)' : 'bid (quote)']}
                labelFormatter={(_price, item) => `price ${item?.[0]?.payload.priceLower} (tick ${item?.[0]?.payload.tick})`}
              />
              <ReferenceLine
                x={truncateDecimals(plan.currentPrice, 6)}
                stroke="#f59e0b"
                strokeDasharray="4 4"
                label={{ value: 'price', fontSize: 10, fill: '#f59e0b' }}
              />
              <Bar dataKey="value">
                {data.map((d, i) => (
                  <Cell key={i} fill={d.label === 'ask' ? ASK_COLOR : BID_COLOR} />
                ))}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </div>

        <div className="grid grid-cols-2 gap-2 text-sm md:grid-cols-5">
          <Stat label="Current price" value={truncateDecimals(plan.currentPrice)} />
          <Stat label="Actual range" value={`${truncateDecimals(plan.actualPriceLower)} - ${truncateDecimals(plan.actualPriceUpper)}`} />
          <Stat label="Total base" value={formatUnits(totalBase, baseDecimals)} />
          <Stat label="Total quote" value={formatUnits(totalQuote, quoteDecimals)} />
          <Stat label="Positions / txs" value={`${mintableCount} / ${chunkCount}`} />
        </div>

        {plan.warnings.length > 0 && (
          <Alert>
            <AlertDescription>
              <ul className="space-y-1">
                {plan.warnings.map((w, i) => (
                  <li key={i}>⚠ {w.message}</li>
                ))}
              </ul>
            </AlertDescription>
          </Alert>
        )}

        <div className="max-h-64 overflow-auto rounded-md border">
          <Table>
            <TableHeader className="sticky top-0 z-10 bg-card">
              <TableRow>
                <TableHead>#</TableHead>
                <TableHead>Side</TableHead>
                <TableHead>Ticks</TableHead>
                <TableHead>Prices</TableHead>
                <TableHead>amount0</TableHead>
                <TableHead>amount1</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {sorted.map((bin, i) => (
                <TableRow key={i}>
                  <TableCell>{bin.index}</TableCell>
                  <TableCell>{bin.label}</TableCell>
                  <TableCell className="font-mono">
                    {bin.tickLower} → {bin.tickUpper}
                  </TableCell>
                  <TableCell className="font-mono">
                    {truncateDecimals(bin.priceLower)} → {truncateDecimals(bin.priceUpper)}
                  </TableCell>
                  <TableCell className="font-mono">{formatUnits(bin.amount0, pool.token0.decimals)}</TableCell>
                  <TableCell className="font-mono">{formatUnits(bin.amount1, pool.token1.decimals)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      </CardContent>
    </Card>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <Card size="sm" className="shadow-none">
      <CardContent className="gap-0.5 px-3">
        <div className="text-muted-foreground">{label}</div>
        <div className="font-mono">{value}</div>
      </CardContent>
    </Card>
  );
}

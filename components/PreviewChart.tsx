'use client';

import { Bar, BarChart, Cell, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { formatUnits } from 'viem';
import type { PlanResult, RawPoolState } from '@/lib/core';
import { truncateDecimals } from '@/lib/format';

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

  return (
    <div className="space-y-4 rounded-lg border border-neutral-800 bg-neutral-900 p-4">
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
        <Stat label="Total base" value={formatUnits(plan.totals.amount0, pool.token0.decimals)} />
        <Stat label="Total quote" value={formatUnits(plan.totals.amount1, pool.token1.decimals)} />
        <Stat label="Positions / txs" value={`${mintableCount} / ${chunkCount}`} />
      </div>

      {plan.warnings.length > 0 && (
        <ul className="space-y-1 text-sm text-amber-400">
          {plan.warnings.map((w, i) => (
            <li key={i}>⚠ {w.message}</li>
          ))}
        </ul>
      )}

      <div className="max-h-64 overflow-auto">
        <table className="w-full text-xs">
          <thead className="sticky top-0 bg-neutral-900 text-left text-neutral-400">
            <tr>
              <th className="py-1">#</th>
              <th>Side</th>
              <th>Ticks</th>
              <th>Prices</th>
              <th>amount0</th>
              <th>amount1</th>
            </tr>
          </thead>
          <tbody>
            {sorted.map((bin, i) => (
              <tr key={i} className="border-t border-neutral-800">
                <td className="py-1">{bin.index}</td>
                <td className={bin.label === 'ask' ? 'text-green-400' : 'text-blue-400'}>{bin.label}</td>
                <td className="font-mono">
                  {bin.tickLower} → {bin.tickUpper}
                </td>
                <td className="font-mono">
                  {truncateDecimals(bin.priceLower)} → {truncateDecimals(bin.priceUpper)}
                </td>
                <td className="font-mono">{formatUnits(bin.amount0, pool.token0.decimals)}</td>
                <td className="font-mono">{formatUnits(bin.amount1, pool.token1.decimals)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded border border-neutral-800 bg-neutral-950 p-2">
      <div className="text-neutral-500">{label}</div>
      <div className="font-mono">{value}</div>
    </div>
  );
}

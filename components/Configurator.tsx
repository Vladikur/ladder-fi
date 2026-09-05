'use client';

import { useAccount } from 'wagmi';
import { useAppToken } from './AppTokenProvider';
import { getBalance } from '@/lib/api-client';
import type { PoolListItem } from '@/lib/api-client';
import type { Strategy, DepositMode } from '@/lib/core';

const FEE_LABELS: Record<number, string> = { 100: '0.01%', 500: '0.05%', 3000: '0.3%', 10000: '1%' };

export interface LadderConfig {
  baseToken: string;
  strategy: Strategy;
  alpha: number;
  depositMode: DepositMode;
  n: number;
  priceMin: string;
  priceMax: string;
  gapSpacings: number;
  baseAmount: string;
  quoteAmount: string;
  slippageBps: number;
}

export function Configurator({
  chainId,
  pool,
  config,
  onChange,
}: {
  chainId: number;
  pool: PoolListItem;
  config: LadderConfig;
  onChange: (next: LadderConfig) => void;
}) {
  const appToken = useAppToken();
  const { address } = useAccount();
  const { token0, token1 } = pool.state;
  const baseIsToken0 = config.baseToken.toLowerCase() === token0.address.toLowerCase();
  const baseSymbol = baseIsToken0 ? token0.symbol : token1.symbol;
  const quoteSymbol = baseIsToken0 ? token1.symbol : token0.symbol;

  function set<K extends keyof LadderConfig>(key: K, value: LadderConfig[K]) {
    onChange({ ...config, [key]: value });
  }

  async function setMax(field: 'baseAmount' | 'quoteAmount') {
    if (!address) return;
    const tokenAddr = field === 'baseAmount' ? (baseIsToken0 ? token0.address : token1.address) : baseIsToken0 ? token1.address : token0.address;
    const { balance, decimals } = await getBalance(appToken, { chainId, token: tokenAddr, owner: address });
    set(field, formatUnitsPlain(balance, decimals));
  }

  const priceMaxNum = Number(config.priceMax);
  const priceMinNum = Number(config.priceMin);
  const priceMinPercent =
    config.priceMax !== '' && priceMaxNum > 0 && config.priceMin !== '' && !isNaN(priceMinNum)
      ? (((priceMaxNum - priceMinNum) / priceMaxNum) * 100).toFixed(2)
      : '';

  function setPriceMinPercent(pctStr: string) {
    const pct = Number(pctStr);
    if (pctStr === '' || isNaN(pct) || !(priceMaxNum > 0)) return;
    set('priceMin', String(priceMaxNum * (1 - pct / 100)));
  }

  return (
    <div className="rounded-lg border border-neutral-800 bg-neutral-900 p-4">
      <div className="mb-4 flex items-center gap-2 text-sm text-neutral-400">
        <span className="font-medium text-neutral-100">
          {token0.symbol} / {token1.symbol}
        </span>
        <span className="rounded bg-neutral-800 px-1.5 py-0.5 text-xs">{FEE_LABELS[pool.ref.fee] ?? `${pool.ref.fee / 10000}%`}</span>
      </div>
      <div className="grid grid-cols-2 gap-4 md:grid-cols-3">
      <label className="flex flex-col gap-1 text-sm">
        Base token
        <select value={config.baseToken} onChange={(e) => set('baseToken', e.target.value)} className="rounded border border-neutral-700 bg-neutral-950 px-2 py-1">
          <option value={token0.address}>{token0.symbol}</option>
          <option value={token1.address}>{token1.symbol}</option>
        </select>
      </label>

      <label className="flex flex-col gap-1 text-sm">
        Strategy
        <select value={config.strategy} onChange={(e) => set('strategy', e.target.value as Strategy)} className="rounded border border-neutral-700 bg-neutral-950 px-2 py-1">
          <option value="bid-ask">Bid-Ask</option>
          <option value="spot">Spot</option>
          <option value="curve">Curve</option>
        </select>
      </label>

      <label className="flex flex-col gap-1 text-sm">
        Alpha ({config.alpha.toFixed(1)})
        <input type="range" min={0.5} max={4.0} step={0.1} value={config.alpha} onChange={(e) => set('alpha', Number(e.target.value))} />
      </label>

      <label className="flex flex-col gap-1 text-sm">
        Deposit mode
        <select value={config.depositMode} onChange={(e) => set('depositMode', e.target.value as DepositMode)} className="rounded border border-neutral-700 bg-neutral-950 px-2 py-1">
          <option value="both">Both sides</option>
          <option value="base-only">Base only ({baseSymbol})</option>
          <option value="quote-only">Quote only ({quoteSymbol})</option>
        </select>
      </label>

      <label className="flex flex-col gap-1 text-sm">
        Bins (N): {config.n}
        <input type="range" min={1} max={50} value={config.n} onChange={(e) => set('n', Number(e.target.value))} />
      </label>

      <label className="flex flex-col gap-1 text-sm">
        Gap (× tick spacing)
        <input type="number" min={1} max={20} value={config.gapSpacings} onChange={(e) => set('gapSpacings', Number(e.target.value))} className="rounded border border-neutral-700 bg-neutral-950 px-2 py-1" />
      </label>

      <label className="flex flex-col gap-1 text-sm">
        Price min ({quoteSymbol} per {baseSymbol})
        <input value={config.priceMin} onChange={(e) => set('priceMin', e.target.value)} className="rounded border border-neutral-700 bg-neutral-950 px-2 py-1 font-mono" />
      </label>

      <label className="flex flex-col gap-1 text-sm">
        Price max ({quoteSymbol} per {baseSymbol})
        <input value={config.priceMax} onChange={(e) => set('priceMax', e.target.value)} className="rounded border border-neutral-700 bg-neutral-950 px-2 py-1 font-mono" />
      </label>

      <label className="flex flex-col gap-1 text-sm">
        Price min (% below max)
        <input
          type="number"
          value={priceMinPercent}
          onChange={(e) => setPriceMinPercent(e.target.value)}
          disabled={!(priceMaxNum > 0)}
          className="rounded border border-neutral-700 bg-neutral-950 px-2 py-1 font-mono disabled:opacity-50"
        />
      </label>

      <label className="flex flex-col gap-1 text-sm">
        Slippage (bps)
        <input type="number" min={0} max={10000} value={config.slippageBps} onChange={(e) => set('slippageBps', Number(e.target.value))} className="rounded border border-neutral-700 bg-neutral-950 px-2 py-1" />
      </label>

      {config.depositMode !== 'quote-only' && (
        <label className="flex flex-col gap-1 text-sm">
          {baseSymbol} amount
          <div className="flex gap-1">
            <input value={config.baseAmount} onChange={(e) => set('baseAmount', e.target.value)} className="w-full rounded border border-neutral-700 bg-neutral-950 px-2 py-1 font-mono" />
            <button type="button" disabled={!address} onClick={() => setMax('baseAmount')} className="rounded bg-neutral-700 px-2 text-xs disabled:opacity-40">
              MAX
            </button>
          </div>
        </label>
      )}

      {config.depositMode !== 'base-only' && (
        <label className="flex flex-col gap-1 text-sm">
          {quoteSymbol} amount
          <div className="flex gap-1">
            <input value={config.quoteAmount} onChange={(e) => set('quoteAmount', e.target.value)} className="w-full rounded border border-neutral-700 bg-neutral-950 px-2 py-1 font-mono" />
            <button type="button" disabled={!address} onClick={() => setMax('quoteAmount')} className="rounded bg-neutral-700 px-2 text-xs disabled:opacity-40">
              MAX
            </button>
          </div>
        </label>
      )}
      </div>
    </div>
  );
}

function formatUnitsPlain(raw: string, decimals: number): string {
  const value = BigInt(raw);
  const base = 10n ** BigInt(decimals);
  const whole = value / base;
  const frac = value % base;
  if (frac === 0n) return whole.toString();
  return `${whole}.${frac.toString().padStart(decimals, '0').replace(/0+$/, '')}`;
}

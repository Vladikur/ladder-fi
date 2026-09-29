'use client';

import { ArrowLeftRight } from 'lucide-react';
import { useAccount } from 'wagmi';
import { useAppToken } from './AppTokenProvider';
import { getBalance } from '@/lib/api-client';
import type { PoolListItem } from '@/lib/adapters/pool-search';
import { tickToPrice, toUserFacingPrice, type Strategy, type DepositMode } from '@/lib/core';
import { truncateDecimals } from '@/lib/format';
import { Card, CardContent, CardHeader } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Label } from '@/components/ui/label';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Slider } from '@/components/ui/slider';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';

const FEE_LABELS: Record<number, string> = { 100: '0.01%', 500: '0.05%', 3000: '0.3%', 10000: '1%' };

/** base/quote trade places on a swap, so a mode naming one of those roles has to follow. */
const SWAPPED_DEPOSIT_MODE: Record<DepositMode, DepositMode> = {
  'base-only': 'quote-only',
  'quote-only': 'base-only',
  both: 'both',
};

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

  function invertPrice(priceStr: string): string {
    const trimmed = priceStr.trim();
    if (trimmed === '' || isNaN(Number(trimmed)) || Number(trimmed) === 0) return '';
    try {
      return toUserFacingPrice(trimmed, false);
    } catch {
      return '';
    }
  }

  function swapBaseQuote() {
    onChange({
      ...config,
      baseToken: baseIsToken0 ? token1.address : token0.address,
      depositMode: SWAPPED_DEPOSIT_MODE[config.depositMode],
      priceMin: invertPrice(config.priceMax),
      priceMax: invertPrice(config.priceMin),
      baseAmount: config.quoteAmount,
      quoteAmount: config.baseAmount,
    });
  }

  let currentPrice = '';
  try {
    currentPrice = toUserFacingPrice(tickToPrice(pool.state.tick, token0.decimals, token1.decimals), baseIsToken0);
  } catch {
    currentPrice = '';
  }
  const currentPriceNum = Number(currentPrice);

  // A bin above the current price can only hold the base token and one below it only the
  // quote token, so a range parked on one side is unfundable from the other - surfacing
  // that here beats letting the preview come back silently all-zero.
  const rangeNeeds =
    !(currentPriceNum > 0) || !(priceMinNum > 0) || !(priceMaxNum > 0)
      ? null
      : priceMinNum >= currentPriceNum
        ? 'base'
        : priceMaxNum <= currentPriceNum
          ? 'quote'
          : 'both';
  const fundsBase = config.depositMode !== 'quote-only';
  const fundsQuote = config.depositMode !== 'base-only';
  const unfundable = (rangeNeeds === 'base' && !fundsBase) || (rangeNeeds === 'quote' && !fundsQuote);

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <span className="font-medium text-foreground">
            {token0.symbol} / {token1.symbol}
          </span>
          <Badge variant="secondary">{FEE_LABELS[pool.ref.fee] ?? `${pool.ref.fee / 10000}%`}</Badge>
        </div>
      </CardHeader>
      <CardContent>
        <div className="grid grid-cols-2 gap-4 md:grid-cols-3">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="base-token">Base token</Label>
            <div className="flex gap-1">
              <Select value={config.baseToken} onValueChange={(v) => set('baseToken', v)}>
                <SelectTrigger id="base-token" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={token0.address}>{token0.symbol}</SelectItem>
                  <SelectItem value={token1.address}>{token1.symbol}</SelectItem>
                </SelectContent>
              </Select>
              <Button
                type="button"
                variant="secondary"
                size="icon"
                title={`Swap base/quote (${baseSymbol} ↔ ${quoteSymbol})`}
                onClick={swapBaseQuote}
              >
                <ArrowLeftRight className="size-4" />
              </Button>
            </div>
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="strategy">Strategy</Label>
            <Select value={config.strategy} onValueChange={(v) => set('strategy', v as Strategy)}>
              <SelectTrigger id="strategy" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="bid-ask">Bid-Ask</SelectItem>
                <SelectItem value="spot">Spot</SelectItem>
                <SelectItem value="curve">Curve</SelectItem>
              </SelectContent>
            </Select>
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="alpha">Alpha ({config.alpha.toFixed(1)})</Label>
            <Slider
              id="alpha"
              min={0.5}
              max={4.0}
              step={0.1}
              value={[config.alpha]}
              onValueChange={([v]) => set('alpha', v!)}
              className="h-9"
            />
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="deposit-mode">Deposit mode</Label>
            <Select value={config.depositMode} onValueChange={(v) => set('depositMode', v as DepositMode)}>
              <SelectTrigger id="deposit-mode" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="both">Both sides</SelectItem>
                <SelectItem value="base-only">Base only ({baseSymbol})</SelectItem>
                <SelectItem value="quote-only">Quote only ({quoteSymbol})</SelectItem>
              </SelectContent>
            </Select>
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="n">Bins (N): {config.n}</Label>
            <Slider id="n" min={1} max={50} step={1} value={[config.n]} onValueChange={([v]) => set('n', v!)} className="h-9" />
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="gap-spacings">Gap (× tick spacing)</Label>
            <Input
              id="gap-spacings"
              type="number"
              min={1}
              max={20}
              value={config.gapSpacings}
              onChange={(e) => set('gapSpacings', Number(e.target.value))}
            />
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="price-min">
              Price min ({quoteSymbol} per {baseSymbol})
            </Label>
            <Input id="price-min" value={config.priceMin} onChange={(e) => set('priceMin', e.target.value)} className="font-mono" />
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="price-max">
              Price max ({quoteSymbol} per {baseSymbol})
            </Label>
            <Input id="price-max" value={config.priceMax} onChange={(e) => set('priceMax', e.target.value)} className="font-mono" />
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="price-min-percent">Price min (% below max)</Label>
            <Input
              id="price-min-percent"
              type="number"
              value={priceMinPercent}
              onChange={(e) => setPriceMinPercent(e.target.value)}
              disabled={!(priceMaxNum > 0)}
              className="font-mono"
            />
          </div>

          {rangeNeeds && (
            <p className={`col-span-2 text-xs md:col-span-3 ${unfundable ? 'text-destructive' : 'text-muted-foreground'}`}>
              Current price {truncateDecimals(currentPrice)} {quoteSymbol} per {baseSymbol} —{' '}
              {rangeNeeds === 'base'
                ? `range sits entirely above it (ask bins), so it can only be funded with ${baseSymbol}`
                : rangeNeeds === 'quote'
                  ? `range sits entirely below it (bid bins), so it can only be funded with ${quoteSymbol}`
                  : `range straddles it: ask bins take ${baseSymbol}, bid bins take ${quoteSymbol}`}
              .
              {unfundable &&
                ` Deposit mode funds only ${fundsBase ? baseSymbol : quoteSymbol} — switch deposit mode, or move the price range to the other side of the current price.`}
            </p>
          )}

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="slippage">Slippage (bps)</Label>
            <Input
              id="slippage"
              type="number"
              min={0}
              max={10000}
              value={config.slippageBps}
              onChange={(e) => set('slippageBps', Number(e.target.value))}
            />
          </div>

          {config.depositMode !== 'quote-only' && (
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="base-amount">{baseSymbol} amount</Label>
              <div className="flex gap-1">
                <Input id="base-amount" value={config.baseAmount} onChange={(e) => set('baseAmount', e.target.value)} className="font-mono" />
                <Button type="button" variant="secondary" size="sm" disabled={!address} onClick={() => setMax('baseAmount')}>
                  MAX
                </Button>
              </div>
            </div>
          )}

          {config.depositMode !== 'base-only' && (
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="quote-amount">{quoteSymbol} amount</Label>
              <div className="flex gap-1">
                <Input id="quote-amount" value={config.quoteAmount} onChange={(e) => set('quoteAmount', e.target.value)} className="font-mono" />
                <Button type="button" variant="secondary" size="sm" disabled={!address} onClick={() => setMax('quoteAmount')}>
                  MAX
                </Button>
              </div>
            </div>
          )}
        </div>
      </CardContent>
    </Card>
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

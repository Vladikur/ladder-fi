'use client';

import { Suspense, useEffect, useMemo, useState } from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { Banner } from '@/components/Banner';
import { Header } from '@/components/Header';
import { PoolSearch } from '@/components/PoolSearch';
import { Configurator, type LadderConfig } from '@/components/Configurator';
import { PreviewChart } from '@/components/PreviewChart';
import { PositionsPanel } from '@/components/PositionsPanel';
import { useAppToken } from '@/components/AppTokenProvider';
import { getPlan, executeStream, type PoolListItem, type ExecuteEvent } from '@/lib/api-client';
import type { PlanResult, RawPoolState } from '@/lib/core';
import { resolveOrientation, toUserFacingPrice, tickToPrice } from '@/lib/core';
import { CHAIN_ID, EXPLORER_URL } from '@/lib/constants';

const PRESETS_KEY = 'liquidity-ladder:presets';

function defaultConfig(pool: PoolListItem): LadderConfig {
  const baseToken = pool.state.token0.address;
  const { baseIsToken0 } = resolveOrientation(pool.state.token0.address, pool.state.token1.address, baseToken);
  const currentPrice = toUserFacingPrice(
    tickToPrice(pool.state.tick, pool.state.token0.decimals, pool.state.token1.decimals),
    baseIsToken0,
  );
  const priceMin = String(Number(currentPrice) * 0.2);
  return {
    baseToken,
    strategy: 'bid-ask',
    alpha: 1,
    depositMode: 'quote-only',
    n: 6,
    priceMin,
    priceMax: currentPrice,
    gapSpacings: 1,
    baseAmount: '0',
    quoteAmount: '0',
    slippageBps: 50,
  };
}

// import {generatePrivateKey, privateKeyToAccount} from 'viem/accounts'; const pk = generatePrivateKey(); console.log('PRIVATE_KEY=' + pk); console.log('address:', privateKeyToAccount(pk).address);

export default function Page() {
  return (
    <Suspense fallback={null}>
      <PageInner />
    </Suspense>
  );
}

function PageInner() {
  const appToken = useAppToken();
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  const [protocol, setProtocol] = useState<'uniswap-v3' | 'uniswap-v4'>(() =>
    searchParams.get('protocol') === 'uniswap-v3' ? 'uniswap-v3' : 'uniswap-v4',
  );
  const [searchToken, setSearchToken] = useState(() => searchParams.get('token') ?? '');

  // Mirror protocol/token into the URL so a reload doesn't lose them -
  // replace (not push) so typing in the search box doesn't spam browser history.
  useEffect(() => {
    const params = new URLSearchParams();
    params.set('protocol', protocol);
    if (searchToken) params.set('token', searchToken);
    router.replace(`${pathname}?${params.toString()}`, { scroll: false });
  }, [protocol, searchToken, pathname, router]);

  const [pool, setPool] = useState<PoolListItem | null>(null);
  const [config, setConfig] = useState<LadderConfig | null>(null);
  const [plan, setPlan] = useState<{ pool: RawPoolState; plan: PlanResult } | null>(null);
  const [planError, setPlanError] = useState<string | null>(null);
  const [planLoading, setPlanLoading] = useState(false);
  const [log, setLog] = useState<ExecuteEvent[]>([]);
  const [executing, setExecuting] = useState(false);
  const [presetName, setPresetName] = useState('');

  function handleSelectPool(p: PoolListItem) {
    setPool(p);
    setPlan(null);
    setLog([]);
    setConfig(defaultConfig(p));
  }

  // Debounced plan preview whenever config changes.
  useEffect(() => {
    if (!pool || !config) return;
    if (!config.priceMin || !config.priceMax) return;
    const handle = setTimeout(async () => {
      setPlanLoading(true);
      setPlanError(null);
      try {
        const result = await getPlan(appToken, {
          chainId: CHAIN_ID,
          protocol,
          poolId: pool.ref.id,
          baseToken: config.baseToken,
          strategy: config.strategy,
          alpha: config.alpha,
          depositMode: config.depositMode,
          n: config.n,
          priceMin: config.priceMin,
          priceMax: config.priceMax,
          gapSpacings: config.gapSpacings,
          baseAmount: config.baseAmount || '0',
          quoteAmount: config.quoteAmount || '0',
          slippageBps: config.slippageBps,
        });
        setPlan({ pool: result.pool, plan: result.plan });
      } catch (err) {
        setPlanError(err instanceof Error ? err.message : 'Failed to compute plan');
        setPlan(null);
      } finally {
        setPlanLoading(false);
      }
    }, 400);
    return () => clearTimeout(handle);
  }, [pool, config, protocol, appToken]);

  async function runExecute(resumeFromChunk = 0) {
    if (!pool || !config) return;
    setExecuting(true);
    setLog([]);
    try {
      await executeStream(
        appToken,
        {
          chainId: CHAIN_ID,
          protocol,
          poolId: pool.ref.id,
          baseToken: config.baseToken,
          strategy: config.strategy,
          alpha: config.alpha,
          depositMode: config.depositMode,
          n: config.n,
          priceMin: config.priceMin,
          priceMax: config.priceMax,
          gapSpacings: config.gapSpacings,
          baseAmount: config.baseAmount || '0',
          quoteAmount: config.quoteAmount || '0',
          slippageBps: config.slippageBps,
          resumeFromChunk,
        },
        (event) => setLog((prev) => [...prev, event]),
      );
    } catch (err) {
      setLog((prev) => [...prev, { type: 'error', code: 'client', message: err instanceof Error ? err.message : 'Execution failed' }]);
    } finally {
      setExecuting(false);
    }
  }

  const lastPartialFailure = useMemo(() => log.find((e) => e.type === 'partial-failure'), [log]);

  function savePreset() {
    if (!config || !presetName.trim()) return;
    const presets = JSON.parse(localStorage.getItem(PRESETS_KEY) ?? '{}');
    presets[presetName.trim()] = config;
    localStorage.setItem(PRESETS_KEY, JSON.stringify(presets));
  }

  function loadPreset(name: string) {
    const presets = JSON.parse(localStorage.getItem(PRESETS_KEY) ?? '{}');
    if (presets[name]) setConfig(presets[name]);
  }

  const presetNames: string[] = typeof window !== 'undefined' ? Object.keys(JSON.parse(localStorage.getItem(PRESETS_KEY) ?? '{}')) : [];

  return (
    <main className="min-h-screen">
      <Banner />
      <Header />
      <div className="mx-auto max-w-6xl space-y-6 p-6">
        <h1 className="text-2xl font-semibold">Liquidity Ladder — Robinhood Chain</h1>

        <div className="flex gap-2">
          {(['uniswap-v3', 'uniswap-v4'] as const).map((p) => (
            <button
              key={p}
              onClick={() => {
                setProtocol(p);
                setPool(null);
                setConfig(null);
                setPlan(null);
              }}
              className={`rounded px-3 py-1.5 text-sm ${protocol === p ? 'bg-blue-600' : 'bg-neutral-800'}`}
            >
              {p === 'uniswap-v3' ? 'Uniswap v3 (bins)' : 'Uniswap v4 (bins)'}
            </button>
          ))}
        </div>

        <PoolSearch
          chainId={CHAIN_ID}
          protocol={protocol}
          explorerUrl={EXPLORER_URL}
          token={searchToken}
          onTokenChange={setSearchToken}
          onSelect={handleSelectPool}
        />

        {pool && config && (
          <>
            <div className="flex items-end gap-2 text-sm">
              <input
                value={presetName}
                onChange={(e) => setPresetName(e.target.value)}
                placeholder="preset name"
                className="rounded border border-neutral-700 bg-neutral-950 px-2 py-1"
              />
              <button onClick={savePreset} className="rounded bg-neutral-700 px-2 py-1">
                Save preset
              </button>
              {presetNames.map((name) => (
                <button key={name} onClick={() => loadPreset(name)} className="rounded bg-neutral-800 px-2 py-1">
                  {name}
                </button>
              ))}
            </div>

            <Configurator chainId={CHAIN_ID} pool={pool} config={config} onChange={setConfig} />

            {planLoading && <p className="text-sm text-neutral-500">Computing plan…</p>}
            {planError && <p className="text-sm text-red-400">{planError}</p>}
            {plan && <PreviewChart pool={plan.pool} plan={plan.plan} />}

            <div className="flex items-center gap-3">
              <button
                disabled={!plan || executing}
                onClick={() => runExecute(0)}
                className="rounded bg-green-700 px-4 py-2 text-sm font-medium disabled:opacity-40"
              >
                {executing ? 'Executing…' : 'Execute'}
              </button>
              {lastPartialFailure && (
                <button
                  onClick={() => runExecute(Number(lastPartialFailure.confirmedChunks))}
                  className="rounded bg-amber-700 px-4 py-2 text-sm font-medium"
                >
                  Resend remainder (from chunk {String(lastPartialFailure.confirmedChunks)})
                </button>
              )}
            </div>

            {log.length > 0 && (
              <div className="max-h-64 overflow-auto rounded border border-neutral-800 bg-black p-2 font-mono text-xs">
                {log.map((e, i) => (
                  <div key={i} className={e.type === 'error' || e.type === 'partial-failure' ? 'text-red-400' : 'text-neutral-300'}>
                    {JSON.stringify(e)}
                  </div>
                ))}
              </div>
            )}

            <PositionsPanel chainId={CHAIN_ID} protocol={protocol} poolId={pool.ref.id} />
          </>
        )}
      </div>
    </main>
  );
}

'use client';

import { useEffect, useMemo, useState } from 'react';
import { useAccount } from 'wagmi';
import { call as simulateCall, sendTransaction, waitForTransactionReceipt } from 'wagmi/actions';
import { Header } from '@/components/Header';
import { PoolSearch } from '@/components/PoolSearch';
import { Configurator, type LadderConfig } from '@/components/Configurator';
import { PreviewChart } from '@/components/PreviewChart';
import { PositionsPanel } from '@/components/PositionsPanel';
import { useAppToken } from '@/components/AppTokenProvider';
import { getPlan, prepareExecute, type PoolListItem, type SerializedCall } from '@/lib/api-client';
import { extractMintedTokenIds } from '@/lib/adapters/mint-events';
import type { PlanResult, RawPoolState } from '@/lib/core';
import { resolveOrientation, toUserFacingPrice, tickToPrice } from '@/lib/core';
import { CHAIN_ID, EXPLORER_URL } from '@/lib/constants';
import { wagmiConfig } from '@/lib/wallet/config';

type ExecuteEvent = { type: string; [key: string]: unknown };

const PRESETS_KEY = 'ladderfi:presets';

function computePriceMinPercent(priceMin: string, priceMax: string): string {
  const priceMaxNum = Number(priceMax);
  const priceMinNum = Number(priceMin);
  return priceMax !== '' && priceMaxNum > 0 && priceMin !== '' && !isNaN(priceMinNum)
    ? (((priceMaxNum - priceMinNum) / priceMaxNum) * 100).toFixed(2)
    : '';
}

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

export default function Page() {
  const appToken = useAppToken();
  const { address, isConnected } = useAccount();

  const [protocol, setProtocol] = useState<'uniswap-v3' | 'uniswap-v4'>('uniswap-v4');
  const [searchToken, setSearchToken] = useState('');

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

  async function sendCall(
    call: SerializedCall,
    onSubmitted: (hash: `0x${string}`) => void,
  ): Promise<{ hash: `0x${string}`; receipt: Awaited<ReturnType<typeof waitForTransactionReceipt>> }> {
    const hash = await sendTransaction(wagmiConfig, {
      to: call.to,
      data: call.data,
      value: call.value ? BigInt(call.value) : undefined,
      chainId: CHAIN_ID,
    });
    onSubmitted(hash);
    const receipt = await waitForTransactionReceipt(wagmiConfig, { hash, chainId: CHAIN_ID });
    return { hash, receipt };
  }

  async function runExecute(resumeFromChunk = 0) {
    if (!pool || !config || !address) return;
    setExecuting(true);
    if (resumeFromChunk === 0) setLog([]);
    const push = (event: ExecuteEvent) => setLog((prev) => [...prev, event]);
    try {
      push({ type: 'step', step: 'prepare', status: 'running' });
      const prepared = await prepareExecute(appToken, {
        chainId: CHAIN_ID,
        protocol,
        poolId: pool.ref.id,
        owner: address,
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
      push({ type: 'step', step: 'prepare', status: 'done', positions: prepared.mintableBinsCount, warnings: prepared.warnings });

      if (resumeFromChunk === 0) {
        for (const call of prepared.approveCalls) {
          push({ type: 'approve-sending', token: call.to });
          const { hash, receipt } = await sendCall(call, (hash) => push({ type: 'approve-submitted', token: call.to, hash }));
          if (receipt.status !== 'success') throw new Error(`Approve transaction ${hash} reverted`);
          push({ type: 'approve-confirmed', token: call.to, hash });
        }
      }

      push({ type: 'step', step: 'mint', status: 'running', totalChunks: prepared.mintChunks.length });
      const mintedTokenIds: string[] = [];
      for (let i = resumeFromChunk; i < prepared.mintChunks.length; i++) {
        const chunkCall = prepared.mintChunks[i]![0]!;
        // Simulated here, not server-side: this chunk's mint only succeeds once the
        // approvals sent just above are actually mined, which by this point they are.
        push({ type: 'step', step: 'simulate', status: 'running', chunkIndex: i });
        try {
          await simulateCall(wagmiConfig, {
            account: address,
            to: chunkCall.to,
            data: chunkCall.data,
            value: chunkCall.value ? BigInt(chunkCall.value) : undefined,
            chainId: CHAIN_ID,
          });
        } catch (err) {
          push({
            type: 'partial-failure',
            confirmedChunks: i,
            totalChunks: prepared.mintChunks.length,
            mintedTokenIds,
            message: `Chunk ${i} would revert on-chain (${err instanceof Error ? err.message : 'simulation failed'}). ${i} of ${prepared.mintChunks.length} chunks already succeeded. Retry with resumeFromChunk=${i} to send the remainder.`,
          });
          return;
        }
        push({ type: 'mint-chunk-sending', chunkIndex: i, totalChunks: prepared.mintChunks.length });
        const { hash, receipt } = await sendCall(chunkCall, (hash) =>
          push({ type: 'mint-chunk-submitted', chunkIndex: i, totalChunks: prepared.mintChunks.length, hash }),
        );
        const tokenIds = receipt.status === 'success' ? extractMintedTokenIds(receipt.logs, prepared.positionManager) : [];
        mintedTokenIds.push(...tokenIds);

        if (receipt.status !== 'success') {
          push({ type: 'mint-chunk-failed', chunkIndex: i, totalChunks: prepared.mintChunks.length, hash });
          push({
            type: 'partial-failure',
            confirmedChunks: i,
            totalChunks: prepared.mintChunks.length,
            mintedTokenIds,
            message: `Chunk ${i} reverted on-chain. ${i} of ${prepared.mintChunks.length} chunks already succeeded. Retry with resumeFromChunk=${i} to send the remainder.`,
          });
          return;
        }
        push({ type: 'mint-chunk-confirmed', chunkIndex: i, totalChunks: prepared.mintChunks.length, hash, tokenIds });
      }
      push({ type: 'done', mintedTokenIds, totalChunks: prepared.mintChunks.length });
    } catch (err) {
      push({ type: 'error', code: 'client', message: err instanceof Error ? err.message : 'Execution failed' });
    } finally {
      setExecuting(false);
    }
  }

  const lastPartialFailure = useMemo(() => log.find((e) => e.type === 'partial-failure'), [log]);

  function savePreset() {
    if (!config || !presetName.trim()) return;
    const { priceMin, priceMax, ...rest } = config;
    const priceMinPercent = computePriceMinPercent(priceMin, priceMax);
    const presets = JSON.parse(localStorage.getItem(PRESETS_KEY) ?? '{}');
    presets[presetName.trim()] = { ...rest, priceMinPercent };
    localStorage.setItem(PRESETS_KEY, JSON.stringify(presets));
  }

  function loadPreset(name: string) {
    const presets = JSON.parse(localStorage.getItem(PRESETS_KEY) ?? '{}');
    const preset = presets[name];
    if (preset && config) {
      const { priceMin, priceMax, priceMinPercent, ...rest } = preset;
      const priceMaxNum = Number(config.priceMax);
      const pct = Number(priceMinPercent);
      const newPriceMin = priceMinPercent !== undefined && priceMinPercent !== '' && !isNaN(pct) && priceMaxNum > 0
        ? String(priceMaxNum * (1 - pct / 100))
        : config.priceMin;
      setConfig({ ...config, ...rest, priceMin: newPriceMin });
    }
  }

  const presetNames: string[] = typeof window !== 'undefined' ? Object.keys(JSON.parse(localStorage.getItem(PRESETS_KEY) ?? '{}')) : [];

  return (
    <main className="min-h-screen">
      <Header />
      <div className="mx-auto max-w-6xl space-y-6 p-6">
        <h1 className="flex items-center gap-2 text-2xl font-semibold">
          <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 16 16" data-icon="IconRobinhood16pxS">
            <rect width="16" height="16" fill="#cf0" rx="8"></rect>
            <path
              fill="#000"
              d="M9.0731 5.6235c.0665.0001.0868.0403.04.0937-1.137 1.2574-2.9498 3.3574-4.6152 7.5977-.0134.0333-.0537.0537-.0937.0537h-.2207c-.0468-.0001-.0671-.029-.0537-.0811.2207-.8159.5222-1.719.997-3.0498V8.392c0-.3544.0536-.6016.2676-.8691l1.458-1.8057c.0515-.0642.114-.0937.1875-.0937z"
            ></path>
            <path
              fill="#000"
              d="M9.4735 6.1332c.0468-.0534.0936-.0266.0938.04V8.729c0 .0334-.0064.0802-.0264.1201l-.9297 1.5313c-.1136.1871-.2463.2823-.4814.3545l-2.087.6426c-.0601.02-.0927-.0248-.0673-.0743 1.0099-1.973 2.1002-3.6116 3.498-5.1699"
            ></path>
            <path
              fill="#000"
              d="M9.1327 3.5444c.6556-.254 2.0734-.2406 2.3877.0937.3543.3747.4005 1.2778.3203 1.8662-.0602.401-.127.488-.3477.7754l-1.3574 1.7725c-.0401.06-.0936.0403-.0937-.0264v-2.542c-.0001-.2072-.1209-.3271-.3282-.3271H7.46c-.0666-.0002-.0865-.0471-.04-.0938.3811-.4013.7828-.8093 1.3847-1.3242.0602-.0515.1917-.1415.3281-.1944"
            ></path>
          </svg>
          Robinhood Chain
        </h1>

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
              {p === 'uniswap-v3' ? 'Uniswap v3' : 'Uniswap v4'}
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
            {false && (
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
            )}

            <Configurator chainId={CHAIN_ID} pool={pool} config={config} onChange={setConfig} />

            {planLoading && <p className="text-sm text-neutral-500">Computing plan…</p>}
            {planError && <p className="text-sm text-red-400">{planError}</p>}
            {plan && <PreviewChart pool={plan.pool} plan={plan.plan} />}

            {!isConnected && <p className="text-sm text-amber-400">Connect a wallet to execute.</p>}

            <div className="flex items-center gap-3">
              <button
                disabled={!plan || executing || !isConnected}
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
                    {typeof e.hash === 'string' && (
                      <>
                        {' '}
                        <a href={`${EXPLORER_URL}/tx/${e.hash}`} target="_blank" rel="noreferrer" className="underline">
                          view on explorer
                        </a>
                      </>
                    )}
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

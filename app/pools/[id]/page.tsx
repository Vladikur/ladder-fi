'use client';

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useParams, useSearchParams } from 'next/navigation';
import { useAccount } from 'wagmi';
import { call as simulateCall, sendTransaction, waitForTransactionReceipt } from 'wagmi/actions';
import { Header } from '@/components/Header';
import { Configurator, type LadderConfig } from '@/components/Configurator';
import { PreviewChart } from '@/components/PreviewChart';
import { PositionsPanel } from '@/components/PositionsPanel';
import { useAppToken } from '@/components/AppTokenProvider';
import { getPlan, prepareExecute, type SerializedCall } from '@/lib/api-client';
import { lookupPoolById, inferProtocolFromPoolId, type PoolListItem } from '@/lib/adapters/pool-search';
import { poolIdSchema } from '@/lib/schemas';
import { extractMintedTokenIds } from '@/lib/adapters/mint-events';
import type { PlanResult, RawPoolState } from '@/lib/core';
import { resolveOrientation, toUserFacingPrice, tickToPrice } from '@/lib/core';
import { CHAIN_ID, EXPLORER_URL } from '@/lib/constants';
import { wagmiConfig } from '@/lib/wallet/config';
import { trackEvent } from '@/lib/analytics';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Spinner } from '@/components/ui/spinner';

type ExecuteEvent = { type: string; [key: string]: unknown };

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

export default function PoolAddLiquidityPage() {
  const appToken = useAppToken();
  const { address, isConnected } = useAccount();
  const params = useParams<{ id: string }>();
  const searchParams = useSearchParams();

  const poolIdRaw = decodeURIComponent(params.id);
  const protocolOverride = searchParams.get('protocol');
  const protocol: 'uniswap-v3' | 'uniswap-v4' =
    protocolOverride === 'uniswap-v3' || protocolOverride === 'uniswap-v4' ? protocolOverride : inferProtocolFromPoolId(poolIdRaw);

  const [pool, setPool] = useState<PoolListItem | null>(null);
  const [poolLoading, setPoolLoading] = useState(true);
  const [poolError, setPoolError] = useState<string | null>(null);

  const [config, setConfig] = useState<LadderConfig | null>(null);
  const [plan, setPlan] = useState<{ pool: RawPoolState; plan: PlanResult } | null>(null);
  const [planError, setPlanError] = useState<string | null>(null);
  const [planLoading, setPlanLoading] = useState(false);
  const [log, setLog] = useState<ExecuteEvent[]>([]);
  const [executing, setExecuting] = useState(false);

  // Resolve the pool from its on-chain id whenever the route (id or protocol override) changes.
  useEffect(() => {
    let cancelled = false;
    setPoolLoading(true);
    setPoolError(null);
    setPool(null);
    setConfig(null);
    setPlan(null);
    setLog([]);

    const parsed = poolIdSchema.safeParse(poolIdRaw);
    if (!parsed.success) {
      setPoolError(parsed.error.issues[0]?.message ?? 'Invalid pool address or PoolId');
      setPoolLoading(false);
      return;
    }

    lookupPoolById(CHAIN_ID, protocol, parsed.data)
      .then((p) => {
        if (cancelled) return;
        setPool(p);
        setConfig(defaultConfig(p));
      })
      .catch((err) => {
        if (!cancelled) setPoolError(err instanceof Error ? err.message : 'Failed to load pool');
      })
      .finally(() => {
        if (!cancelled) setPoolLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [poolIdRaw, protocol]);

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
    if (resumeFromChunk === 0) trackEvent('execute_click');
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

  return (
    <main className="min-h-screen">
      <Header />
      <div className="mx-auto max-w-6xl space-y-6 p-6">
        <div className="flex items-center gap-3">
          <Button asChild variant="secondary" size="sm">
            <Link href="/pools">← Pools</Link>
          </Button>
          <h1 className="text-2xl font-semibold">
            {pool ? `${pool.state.token0.symbol} / ${pool.state.token1.symbol}` : 'Add liquidity'}
          </h1>
        </div>

        {poolLoading && (
          <span className="flex items-center gap-1.5 text-sm text-muted-foreground">
            <Spinner className="size-3" />
            Loading pool…
          </span>
        )}

        {poolError && (
          <Alert variant="destructive">
            <AlertDescription>{poolError}</AlertDescription>
          </Alert>
        )}

        {pool && config && (
          <>
            <Configurator chainId={CHAIN_ID} pool={pool} config={config} onChange={setConfig} />

            {planLoading && (
              <span className="flex items-center gap-1.5 text-sm text-muted-foreground">
                <Spinner className="size-3" />
                Computing plan…
              </span>
            )}
            {planError && (
              <Alert variant="destructive">
                <AlertDescription>{planError}</AlertDescription>
              </Alert>
            )}
            {plan && <PreviewChart pool={plan.pool} plan={plan.plan} />}

            {!isConnected && (
              <Alert>
                <AlertDescription>Connect a wallet to execute.</AlertDescription>
              </Alert>
            )}

            <div className="flex items-center gap-3">
              <Button disabled={!plan || executing || !isConnected} onClick={() => runExecute(0)}>
                {executing && <Spinner />}
                {executing ? 'Executing…' : 'Execute'}
              </Button>
              {lastPartialFailure && (
                <Button variant="secondary" onClick={() => runExecute(Number(lastPartialFailure.confirmedChunks))}>
                  Resend remainder (from chunk {String(lastPartialFailure.confirmedChunks)})
                </Button>
              )}
            </div>

            {log.length > 0 && (
              <Card>
                <CardContent className="max-h-64 overflow-auto font-mono text-xs">
                  {log.map((e, i) => (
                    <div key={i} className={e.type === 'error' || e.type === 'partial-failure' ? 'text-destructive' : 'text-muted-foreground'}>
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
                </CardContent>
              </Card>
            )}

            <PositionsPanel chainId={CHAIN_ID} protocol={protocol} poolRef={pool.ref} />
          </>
        )}
      </div>
    </main>
  );
}

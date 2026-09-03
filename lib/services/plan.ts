import 'server-only';
import { parseUnits } from 'viem';
import { getAdapter } from '@/lib/adapters';
import { resolvePoolRef } from '@/lib/adapters/resolve-pool';
import type { PoolRef, PoolState } from '@/lib/adapters/types';
import { buildPlan, resolveOrientation, type PlanInput, type PlanResult, type Strategy, type DepositMode } from '@/lib/core';

export interface PlanRequestInput {
  chainId: number;
  protocol: string;
  poolId: `0x${string}`;
  baseToken: `0x${string}`;
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

/**
 * The single place that turns raw client-supplied parameters into a concrete plan.
 * Both /api/plan (preview) and /api/execute call this - execute never accepts a
 * pre-built plan or calldata from the client (TZ §3.4: "готовый calldata от клиента не
 * принимать"), it always recomputes from scratch server-side.
 */
export async function resolvePlan(input: PlanRequestInput): Promise<{ ref: PoolRef; state: PoolState; plan: PlanResult }> {
  const ref = await resolvePoolRef(input.chainId, input.protocol, input.poolId);
  const adapter = getAdapter(input.chainId, input.protocol);
  const state = await adapter.getPoolState(ref);

  const { baseIsToken0 } = resolveOrientation(state.token0.address, state.token1.address, input.baseToken);
  const baseDecimals = baseIsToken0 ? state.token0.decimals : state.token1.decimals;
  const quoteDecimals = baseIsToken0 ? state.token1.decimals : state.token0.decimals;

  const baseAmount = input.depositMode === 'quote-only' ? 0n : parseUnits(input.baseAmount, baseDecimals);
  const quoteAmount = input.depositMode === 'base-only' ? 0n : parseUnits(input.quoteAmount, quoteDecimals);

  const planInput: PlanInput = {
    chainId: input.chainId,
    pool: state,
    baseToken: input.baseToken,
    strategy: input.strategy,
    alpha: input.alpha,
    depositMode: input.depositMode,
    n: input.n,
    priceMin: input.priceMin,
    priceMax: input.priceMax,
    gapSpacings: input.gapSpacings,
    baseAmount,
    quoteAmount,
    slippageBps: input.slippageBps,
  };

  const plan = buildPlan(planInput);
  return { ref, state, plan };
}

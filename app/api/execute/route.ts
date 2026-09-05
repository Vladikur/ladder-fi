import 'server-only';
import { z } from 'zod';
import { jsonResponse } from '@/lib/json';
import { assertRequestAuthorized, CsrfError } from '@/lib/guards/csrf';
import { resolvePlan } from '@/lib/services/plan';
import { RangeTooNarrowError } from '@/lib/core';
import { getAdapter } from '@/lib/adapters';
import type { MintPlan } from '@/lib/adapters/types';
import { getPublicClient } from '@/lib/rpc/client';
import { erc20Abi } from '@/lib/adapters/abis';
import { poolIdSchema, addressSchema } from '@/lib/schemas';
import { getProtocol } from '@/lib/registry/protocols';

const decimalString = z.string().regex(/^\d+(\.\d+)?$/);

const bodySchema = z.object({
  chainId: z.number().int().positive(),
  protocol: z.string().min(1),
  poolId: poolIdSchema,
  owner: addressSchema,
  baseToken: addressSchema,
  strategy: z.enum(['bid-ask', 'spot', 'curve']),
  alpha: z.number().min(0.5).max(4.0),
  depositMode: z.enum(['both', 'base-only', 'quote-only']),
  n: z.number().int().min(1).max(50),
  priceMin: decimalString,
  priceMax: decimalString,
  gapSpacings: z.number().int().min(1).max(20).default(1),
  baseAmount: decimalString.default('0'),
  quoteAmount: decimalString.default('0'),
  slippageBps: z.number().int().min(0).max(10_000).default(50),
});

/**
 * Builds unsigned calldata for a ladder mint (approvals + chunked mints) and returns it
 * to the client - it never signs or sends anything itself. The browser wallet does that;
 * the client drives the approve/mint sequence and simulates each chunk itself before
 * asking the wallet to sign it (see lib/api-client.ts's prepareExecute + app/page.tsx).
 */
export async function POST(request: Request) {
  try {
    assertRequestAuthorized(request);
  } catch (err) {
    if (err instanceof CsrfError) return jsonResponse({ error: err.message }, { status: 401 });
    throw err;
  }

  let json: unknown;
  try {
    json = await request.json();
  } catch {
    return jsonResponse({ error: 'Invalid JSON body' }, { status: 400 });
  }
  const parsed = bodySchema.safeParse(json);
  if (!parsed.success) {
    return jsonResponse({ error: 'Invalid body', issues: parsed.error.issues }, { status: 400 });
  }
  const input = parsed.data;

  try {
    const { ref, state, plan } = await resolvePlan({
      chainId: input.chainId,
      protocol: input.protocol,
      poolId: input.poolId,
      baseToken: input.baseToken,
      strategy: input.strategy,
      alpha: input.alpha,
      depositMode: input.depositMode,
      n: input.n,
      priceMin: input.priceMin,
      priceMax: input.priceMax,
      gapSpacings: input.gapSpacings,
      baseAmount: input.baseAmount,
      quoteAmount: input.quoteAmount,
      slippageBps: input.slippageBps,
    });
    const mintableBins = plan.bins.filter((b) => b.amount0 > 0n || b.amount1 > 0n);

    const client = getPublicClient(input.chainId);
    const [balance0, balance1] = await Promise.all([
      client.readContract({ address: state.token0.address, abi: erc20Abi, functionName: 'balanceOf', args: [input.owner] }),
      client.readContract({ address: state.token1.address, abi: erc20Abi, functionName: 'balanceOf', args: [input.owner] }),
    ]);
    if (balance0 < plan.totals.amount0) {
      throw new Error(`Insufficient ${state.token0.symbol} balance: need ${plan.totals.amount0}, have ${balance0}`);
    }
    if (balance1 < plan.totals.amount1) {
      throw new Error(`Insufficient ${state.token1.symbol} balance: need ${plan.totals.amount1}, have ${balance1}`);
    }

    const protocol = getProtocol(input.chainId, input.protocol);
    const positionManager = protocol.contracts.positionManager;
    if (!positionManager) throw new Error('positionManager not configured for this protocol');

    const deadline = BigInt(Math.floor(Date.now() / 1000) + 300);
    const mintPlan: MintPlan = { kind: 'v3-bins', ref, owner: input.owner, deadline, bins: plan.bins, slippageBps: input.slippageBps };
    const adapter = getAdapter(input.chainId, input.protocol);

    // --- approve (exact amount, not MaxUint256) - each adapter diffs against whatever
    // on-chain allowance actually gates its own mint path and returns only the calls
    // still needed. ---
    const approveCalls = await adapter.buildApproveCalls(mintPlan);

    // Deliberately NOT simulated here: the approve calls above haven't been sent yet at
    // this point (this is a single read-only "prepare" call, before the wallet has signed
    // anything), so a mint chunk would always look like it reverts for insufficient
    // allowance. The client simulates each chunk itself right before sending it, once
    // the approvals it actually sent have been confirmed on-chain - see app/page.tsx.
    const mintChunks = await adapter.buildMintCalls(mintPlan);

    return jsonResponse({
      ref,
      warnings: plan.warnings,
      positionManager,
      mintableBinsCount: mintableBins.length,
      approveCalls,
      mintChunks,
    });
  } catch (err) {
    if (err instanceof RangeTooNarrowError) {
      return jsonResponse({ error: err.message, code: 'range-too-narrow', maxN: err.maxN }, { status: 400 });
    }
    return jsonResponse({ error: err instanceof Error ? err.message : 'Unknown error' }, { status: 500 });
  }
}

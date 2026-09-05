import 'server-only';
import { z } from 'zod';
import { decodeEventLog } from 'viem';
import { jsonResponse } from '@/lib/json';
import { assertRequestAuthorized, CsrfError } from '@/lib/guards/csrf';
import { resolvePlan } from '@/lib/services/plan';
import { RangeTooNarrowError } from '@/lib/core';
import { getAdapter } from '@/lib/adapters';
import type { MintPlan } from '@/lib/adapters/types';
import { getPublicClient } from '@/lib/rpc/client';
import { erc20Abi, erc721TransferEvent } from '@/lib/adapters/abis';
import { poolIdSchema } from '@/lib/schemas';
import { getSigner } from '@/lib/signer/local-key';
import { executionQueue, ConcurrentExecutionError } from '@/lib/signer/queue';
import { runPreflightGuards, checkGasLimit, GuardViolationError } from '@/lib/guards/limits';
import { checkGasFeeUsd } from '@/lib/guards/gas-fee';
import { appendAudit } from '@/lib/guards/audit';
import { getChain } from '@/lib/registry/resolve';
import { getProtocol } from '@/lib/registry/protocols';

const addressSchema = z.string().regex(/^0x[a-fA-F0-9]{40}$/);
const decimalString = z.string().regex(/^\d+(\.\d+)?$/);

const bodySchema = z.object({
  chainId: z.number().int().positive(),
  protocol: z.string().min(1),
  poolId: poolIdSchema,
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
  /** number of mint chunks already confirmed in a previous attempt at this exact plan - skips resending them. */
  resumeFromChunk: z.number().int().min(0).default(0),
  /** user's own $-denominated gas budget per chunk (Header settings popup, localStorage) - default mirrors DEFAULT_MAX_GAS_FEE_USD in lib/settings.ts. */
  maxGasFeeUsd: z.number().positive().default(1),
});

type SseEvent = { type: string; [key: string]: unknown };

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

  const signer = await getSigner();
  if (executionQueue.isActive(signer.address)) {
    return jsonResponse({ error: 'An execution batch is already in progress for this signer' }, { status: 409 });
  }

  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (event: SseEvent) => controller.enqueue(encoder.encode(`data: ${jsonStringify(event)}\n\n`));

      try {
        await executionQueue.run(signer.address, () => runExecution(input, signer, send));
      } catch (err) {
        if (err instanceof ConcurrentExecutionError) {
          send({ type: 'error', code: 'concurrent-execution', message: err.message });
        } else if (err instanceof GuardViolationError) {
          send({ type: 'error', code: err.code, message: err.message });
        } else if (err instanceof RangeTooNarrowError) {
          send({ type: 'error', code: 'range-too-narrow', message: err.message, maxN: err.maxN });
        } else {
          send({ type: 'error', code: 'internal', message: err instanceof Error ? err.message : 'Unknown error' });
        }
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
    },
  });
}

function jsonStringify(value: unknown): string {
  return JSON.stringify(value, (_key, v) => (typeof v === 'bigint' ? v.toString() : v));
}

async function runExecution(
  input: z.infer<typeof bodySchema>,
  signer: Awaited<ReturnType<typeof getSigner>>,
  send: (event: SseEvent) => void,
): Promise<void> {
  send({ type: 'step', step: 'plan', status: 'running' });
  const { ref, state, plan } = await resolvePlan({
    chainId: input.chainId,
    protocol: input.protocol,
    poolId: input.poolId,
    baseToken: input.baseToken as `0x${string}`,
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
  send({ type: 'step', step: 'plan', status: 'done', positions: mintableBins.length, warnings: plan.warnings });

  send({ type: 'step', step: 'guards', status: 'running' });
  const chain = getChain(input.chainId);
  const notionalToken = chain.notionalToken.toLowerCase();
  let notionalThisRun = 0n;
  if (state.token0.address.toLowerCase() === notionalToken) notionalThisRun += plan.totals.amount0;
  if (state.token1.address.toLowerCase() === notionalToken) notionalThisRun += plan.totals.amount1;

  runPreflightGuards({
    chainId: input.chainId,
    token0: state.token0.address,
    token1: state.token1.address,
    slippageBps: input.slippageBps,
    positionsCount: mintableBins.length,
    notionalThisRun,
  });
  send({ type: 'step', step: 'guards', status: 'done' });

  send({ type: 'step', step: 'balances', status: 'running' });
  const client = getPublicClient(input.chainId);
  const [balance0, balance1] = await Promise.all([
    client.readContract({ address: state.token0.address, abi: erc20Abi, functionName: 'balanceOf', args: [signer.address] }),
    client.readContract({ address: state.token1.address, abi: erc20Abi, functionName: 'balanceOf', args: [signer.address] }),
  ]);
  if (balance0 < plan.totals.amount0) {
    throw new Error(`Insufficient ${state.token0.symbol} balance: need ${plan.totals.amount0}, have ${balance0}`);
  }
  if (balance1 < plan.totals.amount1) {
    throw new Error(`Insufficient ${state.token1.symbol} balance: need ${plan.totals.amount1}, have ${balance1}`);
  }
  send({ type: 'step', step: 'balances', status: 'done' });

  const protocol = getProtocol(input.chainId, input.protocol);
  const positionManager = protocol.contracts.positionManager;
  if (!positionManager) throw new Error('positionManager not configured for this protocol');

  const deadline = BigInt(Math.floor(Date.now() / 1000) + 300);
  const mintPlan: MintPlan = { kind: 'v3-bins', ref, owner: signer.address, deadline, bins: plan.bins, slippageBps: input.slippageBps };
  const adapter = getAdapter(input.chainId, input.protocol);

  // --- approve (exact amount, not MaxUint256) - each adapter diffs against whatever
  // on-chain allowance actually gates its own mint path (a direct ERC20 allowance to the
  // position manager for v3, a two-hop ERC20->Permit2->position-manager allowance for v4)
  // and returns only the calls still needed. ---
  send({ type: 'step', step: 'allowance', status: 'running' });
  const approveCalls = await adapter.buildApproveCalls(mintPlan);
  send({ type: 'step', step: 'allowance', status: 'done', approvalsNeeded: approveCalls.length });

  for (const call of approveCalls) {
    send({ type: 'approve-sending', token: call.to });
    const hash = await signer.sendCalls(input.chainId, [call]);
    const receipt = await signer.waitForReceipt(input.chainId, hash);
    appendAudit({
      timestamp: new Date().toISOString(),
      chainId: input.chainId,
      protocol: input.protocol,
      nonce: Number(receipt.transactionIndex),
      hash,
      operation: 'approve',
      token0: state.token0.address,
      token1: state.token1.address,
      amount0: '0',
      amount1: '0',
      result: receipt.status === 'success' ? 'success' : 'failure',
    });
    if (receipt.status !== 'success') throw new Error(`Approve transaction ${hash} reverted`);
    send({ type: 'approve-confirmed', token: call.to, hash });
  }

  // --- build, then simulate every chunk exactly as it will be sent (staticcall, protocol-agnostic) ---
  const chunks = await adapter.buildMintCalls(mintPlan);
  send({ type: 'step', step: 'simulate', status: 'running' });
  for (const chunkCalls of chunks) {
    const call = chunkCalls[0]!;
    await client.call({ account: signer.address, to: call.to, data: call.data, value: call.value ?? 0n });
  }
  send({ type: 'step', step: 'simulate', status: 'done', positions: mintableBins.length });

  // --- mint, chunked, sequential ---
  send({ type: 'step', step: 'mint', status: 'running', totalChunks: chunks.length });

  const chunkSize = protocol.capabilities.maxPositionsPerTx;
  const mintedTokenIds: string[] = [];
  for (let i = input.resumeFromChunk; i < chunks.length; i++) {
    const chunkCalls = chunks[i]!;
    const binsInChunk = mintableBins.slice(i * chunkSize, (i + 1) * chunkSize);
    const gasEstimate = await client.estimateGas({
      account: signer.address,
      to: chunkCalls[0]!.to,
      data: chunkCalls[0]!.data,
      value: chunkCalls[0]!.value ?? 0n,
    });
    checkGasLimit(gasEstimate);
    await checkGasFeeUsd(input.chainId, gasEstimate, input.maxGasFeeUsd);

    send({ type: 'mint-chunk-sending', chunkIndex: i, totalChunks: chunks.length });
    const hash = await signer.sendCalls(input.chainId, chunkCalls);
    const receipt = await signer.waitForReceipt(input.chainId, hash);

    const tokenIds = receipt.status === 'success' ? extractMintedTokenIds(receipt.logs, positionManager) : [];
    mintedTokenIds.push(...tokenIds);

    appendAudit({
      timestamp: new Date().toISOString(),
      chainId: input.chainId,
      protocol: input.protocol,
      nonce: Number(receipt.transactionIndex),
      hash,
      operation: 'mint',
      token0: state.token0.address,
      token1: state.token1.address,
      amount0: binsInChunk.reduce((s, b) => s + b.amount0, 0n).toString(),
      amount1: binsInChunk.reduce((s, b) => s + b.amount1, 0n).toString(),
      positions: binsInChunk.map((bin, j) => ({
        tokenId: tokenIds[j],
        tickLower: bin.tickLower,
        tickUpper: bin.tickUpper,
        label: bin.label,
      })),
      result: receipt.status === 'success' ? 'success' : 'failure',
    });

    if (receipt.status !== 'success') {
      send({ type: 'mint-chunk-failed', chunkIndex: i, totalChunks: chunks.length, hash });
      send({
        type: 'partial-failure',
        confirmedChunks: i,
        totalChunks: chunks.length,
        mintedTokenIds,
        message: `Chunk ${i} reverted on-chain. ${i} of ${chunks.length} chunks already succeeded. Retry with resumeFromChunk=${i} to send the remainder.`,
      });
      return;
    }
    send({ type: 'mint-chunk-confirmed', chunkIndex: i, totalChunks: chunks.length, hash, tokenIds });
  }

  send({ type: 'done', mintedTokenIds, totalChunks: chunks.length });
}

/**
 * Both the v3 NonfungiblePositionManager and the v4 PositionManager are plain ERC721s,
 * so a newly-minted position is always exactly a Transfer(from=0x0, to=owner, tokenId)
 * log from the position manager itself - protocol-agnostic, unlike v3's IncreaseLiquidity
 * event (which v4's PositionManager doesn't emit at all).
 */
function extractMintedTokenIds(
  logs: readonly { address: string; topics: readonly `0x${string}`[]; data: `0x${string}` }[],
  positionManager: `0x${string}`,
): string[] {
  const ids: string[] = [];
  for (const log of logs) {
    if (log.address.toLowerCase() !== positionManager.toLowerCase()) continue;
    try {
      const decoded = decodeEventLog({
        abi: erc721TransferEvent,
        data: log.data,
        topics: log.topics as [`0x${string}`, ...`0x${string}`[]],
      });
      if (decoded.args.from === '0x0000000000000000000000000000000000000000') {
        ids.push(decoded.args.tokenId.toString());
      }
    } catch {
      // not a Transfer log - ignore
    }
  }
  return ids;
}

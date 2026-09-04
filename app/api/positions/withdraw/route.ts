import 'server-only';
import { z } from 'zod';
import { jsonResponse } from '@/lib/json';
import { assertRequestAuthorized, CsrfError } from '@/lib/guards/csrf';
import { getAdapter } from '@/lib/adapters';
import { getSigner } from '@/lib/signer/local-key';
import { executionQueue, ConcurrentExecutionError } from '@/lib/signer/queue';
import { GuardViolationError } from '@/lib/guards/limits';
import { getServerEnv } from '@/lib/env';
import { appendAudit } from '@/lib/guards/audit';
import { getProtocol } from '@/lib/registry/protocols';

const bodySchema = z.object({
  chainId: z.number().int().positive(),
  protocol: z.string().min(1),
  tokenIds: z.array(z.string().regex(/^\d+$/)).min(1),
  /** basis points of liquidity to remove per position; 10000 = full withdraw (decreaseLiquidity -> collect -> burn) */
  bps: z.number().int().min(1).max(10_000).default(10_000),
});

export async function POST(request: Request) {
  try {
    assertRequestAuthorized(request);
  } catch (err) {
    if (err instanceof CsrfError) return jsonResponse({ error: err.message }, { status: 401 });
    throw err;
  }

  const env = getServerEnv();
  if (env.KILL_SWITCH) {
    return jsonResponse({ error: 'KILL_SWITCH is enabled - all execution is blocked' }, { status: 403 });
  }

  let json: unknown;
  try {
    json = await request.json();
  } catch {
    return jsonResponse({ error: 'Invalid JSON body' }, { status: 400 });
  }
  const parsed = bodySchema.safeParse(json);
  if (!parsed.success) return jsonResponse({ error: 'Invalid body', issues: parsed.error.issues }, { status: 400 });
  const input = parsed.data;

  const signer = await getSigner();
  if (executionQueue.isActive(signer.address)) {
    return jsonResponse({ error: 'An execution batch is already in progress for this signer' }, { status: 409 });
  }

  try {
    const results = await executionQueue.run(signer.address, async () => {
      const adapter = getAdapter(input.chainId, input.protocol);

      const chunkSize = getProtocol(input.chainId, input.protocol).capabilities.maxPositionsPerTx;
      const chunks = await adapter.buildWithdrawCalls(signer.address, input.tokenIds.map(BigInt), input.bps);
      const out: { tokenId: string; hash: string; success: boolean; error?: string }[] = [];
      for (let i = 0; i < chunks.length; i++) {
        const tokenIdsInChunk = input.tokenIds.slice(i * chunkSize, (i + 1) * chunkSize);
        // Caught per-chunk so one bad tokenId in a batch (already burned, never minted,
        // etc.) doesn't hide whether other chunks in this request went through.
        try {
          // read before sending - a full withdraw (bps=10000) burns the NFT, after which positions()/getPoolAndPositionInfo() revert
          const positions = await Promise.all(tokenIdsInChunk.map((tokenId) => adapter.getPositionSummary(BigInt(tokenId))));
          const hash = await signer.sendCalls(input.chainId, chunks[i]!);
          const receipt = await signer.waitForReceipt(input.chainId, hash);
          const success = receipt.status === 'success';
          for (let j = 0; j < tokenIdsInChunk.length; j++) {
            const tokenId = tokenIdsInChunk[j]!;
            const position = positions[j]!;
            appendAudit({
              timestamp: new Date().toISOString(),
              chainId: input.chainId,
              protocol: input.protocol,
              nonce: Number(receipt.transactionIndex),
              hash,
              operation: 'withdraw',
              token0: position.token0,
              token1: position.token1,
              tickLower: position.tickLower,
              tickUpper: position.tickUpper,
              amount0: '0',
              amount1: '0',
              result: success ? 'success' : 'failure',
            });
            out.push({ tokenId, hash, success });
          }
        } catch (err) {
          const message = err instanceof Error ? err.message : 'Unknown error';
          for (const tokenId of tokenIdsInChunk) {
            out.push({ tokenId, hash: '', success: false, error: message });
          }
        }
      }
      return out;
    });
    return jsonResponse({ results });
  } catch (err) {
    if (err instanceof ConcurrentExecutionError) return jsonResponse({ error: err.message }, { status: 409 });
    if (err instanceof GuardViolationError) return jsonResponse({ error: err.message, code: err.code }, { status: 403 });
    return jsonResponse({ error: err instanceof Error ? err.message : 'Unknown error' }, { status: 500 });
  }
}

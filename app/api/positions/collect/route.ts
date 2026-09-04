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

const bodySchema = z.object({
  chainId: z.number().int().positive(),
  protocol: z.string().min(1),
  tokenIds: z.array(z.string().regex(/^\d+$/)).min(1),
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

      const chunks = await adapter.buildCollectCalls(signer.address, input.tokenIds.map(BigInt));
      const out: { tokenId: string; hash: string; success: boolean; error?: string }[] = [];
      for (let i = 0; i < chunks.length; i++) {
        const tokenId = input.tokenIds[i]!;
        // Caught per-position so one bad tokenId (already burned, never minted, etc.)
        // doesn't hide whether the others in this batch went through.
        try {
          const position = await adapter.getPositionSummary(BigInt(tokenId));
          const hash = await signer.sendCalls(input.chainId, chunks[i]!);
          const receipt = await signer.waitForReceipt(input.chainId, hash);
          appendAudit({
            timestamp: new Date().toISOString(),
            chainId: input.chainId,
            protocol: input.protocol,
            nonce: Number(receipt.transactionIndex),
            hash,
            operation: 'collect',
            token0: position.token0,
            token1: position.token1,
            amount0: '0',
            amount1: '0',
            result: receipt.status === 'success' ? 'success' : 'failure',
          });
          out.push({ tokenId, hash, success: receipt.status === 'success' });
        } catch (err) {
          out.push({ tokenId, hash: '', success: false, error: err instanceof Error ? err.message : 'Unknown error' });
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

import 'server-only';
import { z } from 'zod';
import { jsonResponse } from '@/lib/json';
import { assertRequestAuthorized, CsrfError } from '@/lib/guards/csrf';
import { getAdapter } from '@/lib/adapters';
import { addressSchema } from '@/lib/schemas';
import { getProtocol } from '@/lib/registry/protocols';

const bodySchema = z.object({
  chainId: z.number().int().positive(),
  protocol: z.string().min(1),
  owner: addressSchema,
  tokenIds: z.array(z.string().regex(/^\d+$/)).min(1),
  /** basis points of liquidity to remove per position; 10000 = full withdraw (decreaseLiquidity -> collect -> burn) */
  bps: z.number().int().min(1).max(10_000).default(10_000),
});

/**
 * Builds unsigned withdraw calldata, chunked up to `chunkSize` tokenIds per transaction
 * (same batching buildWithdrawCalls already does) - the client signs and sends each
 * chunk itself and slices its own `tokenIds` array by `chunkSize` to match each chunk.
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
  if (!parsed.success) return jsonResponse({ error: 'Invalid body', issues: parsed.error.issues }, { status: 400 });
  const input = parsed.data;

  try {
    const adapter = getAdapter(input.chainId, input.protocol);
    const chunkSize = getProtocol(input.chainId, input.protocol).capabilities.maxPositionsPerTx;
    const chunks = await adapter.buildWithdrawCalls(input.owner, input.tokenIds.map(BigInt), input.bps);
    return jsonResponse({ chunks, chunkSize });
  } catch (err) {
    return jsonResponse({ error: err instanceof Error ? err.message : 'Unknown error' }, { status: 500 });
  }
}

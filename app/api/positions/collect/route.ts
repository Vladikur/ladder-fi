import 'server-only';
import { z } from 'zod';
import { jsonResponse } from '@/lib/json';
import { assertRequestAuthorized, CsrfError } from '@/lib/guards/csrf';
import { assertRateLimited, RateLimitError } from '@/lib/guards/rate-limit';
import { getAdapter } from '@/lib/adapters';
import { addressSchema } from '@/lib/schemas';

const bodySchema = z.object({
  chainId: z.number().int().positive(),
  protocol: z.string().min(1),
  owner: addressSchema,
  tokenIds: z.array(z.string().regex(/^\d+$/)).min(1),
});

/** Builds unsigned collect calldata, chunked by tokenId - the client signs and sends each chunk itself. */
export async function POST(request: Request) {
  try {
    assertRequestAuthorized(request);
    assertRateLimited(request, 'collect');
  } catch (err) {
    if (err instanceof CsrfError) return jsonResponse({ error: err.message }, { status: 401 });
    if (err instanceof RateLimitError) {
      return jsonResponse({ error: err.message }, { status: 429, headers: { 'Retry-After': String(Math.ceil(err.retryAfterMs / 1000)) } });
    }
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
    const chunks = await adapter.buildCollectCalls(input.owner, input.tokenIds.map(BigInt));
    return jsonResponse({ chunks });
  } catch (err) {
    return jsonResponse({ error: err instanceof Error ? err.message : 'Unknown error' }, { status: 500 });
  }
}

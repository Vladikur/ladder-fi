import 'server-only';
import { z } from 'zod';
import { jsonResponse } from '@/lib/json';
import { assertRequestAuthorized, CsrfError } from '@/lib/guards/csrf';
import { assertRateLimited, RateLimitError } from '@/lib/guards/rate-limit';
import { addressSchema } from '@/lib/schemas';
import { getPublicClient } from '@/lib/rpc/client';
import { erc20Abi } from '@/lib/adapters/abis';
import { describeError } from '@/lib/rpc/errors';

const querySchema = z.object({
  chainId: z.coerce.number().int().positive(),
  token: addressSchema,
  owner: addressSchema,
});

/** Balance of the connected wallet's own address - used for the configurator's MAX button. */
export async function GET(request: Request) {
  try {
    assertRequestAuthorized(request);
    assertRateLimited(request, 'balance');
  } catch (err) {
    if (err instanceof CsrfError) return jsonResponse({ error: err.message }, { status: 401 });
    if (err instanceof RateLimitError) {
      return jsonResponse({ error: err.message }, { status: 429, headers: { 'Retry-After': String(Math.ceil(err.retryAfterMs / 1000)) } });
    }
    throw err;
  }

  const url = new URL(request.url);
  const parsed = querySchema.safeParse(Object.fromEntries(url.searchParams));
  if (!parsed.success) return jsonResponse({ error: 'Invalid query', issues: parsed.error.issues }, { status: 400 });
  const { chainId, token, owner } = parsed.data;

  try {
    const client = getPublicClient(chainId);
    const [balance, decimals] = await Promise.all([
      client.readContract({ address: token, abi: erc20Abi, functionName: 'balanceOf', args: [owner] }),
      client.readContract({ address: token, abi: erc20Abi, functionName: 'decimals' }),
    ]);
    return jsonResponse({ owner, token, balance, decimals });
  } catch (err) {
    return jsonResponse({ error: describeError(err) }, { status: 500 });
  }
}

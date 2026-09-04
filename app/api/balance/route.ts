import 'server-only';
import { z } from 'zod';
import { jsonResponse } from '@/lib/json';
import { assertRequestAuthorized, CsrfError } from '@/lib/guards/csrf';
import { addressSchema } from '@/lib/schemas';
import { getPublicClient } from '@/lib/rpc/client';
import { erc20Abi } from '@/lib/adapters/abis';
import { getSigner } from '@/lib/signer/local-key';
import { describeError } from '@/lib/rpc/errors';

const querySchema = z.object({
  chainId: z.coerce.number().int().positive(),
  token: addressSchema,
});

/** Balance of the signer's own address - used for the configurator's MAX button. This
 *  is self-custody, single-owner tooling, so there is no separate "owner" to look up. */
export async function GET(request: Request) {
  try {
    assertRequestAuthorized(request);
  } catch (err) {
    if (err instanceof CsrfError) return jsonResponse({ error: err.message }, { status: 401 });
    throw err;
  }

  const url = new URL(request.url);
  const parsed = querySchema.safeParse(Object.fromEntries(url.searchParams));
  if (!parsed.success) return jsonResponse({ error: 'Invalid query', issues: parsed.error.issues }, { status: 400 });
  const { chainId, token } = parsed.data;

  try {
    const signer = await getSigner();
    const client = getPublicClient(chainId);
    const [balance, decimals] = await Promise.all([
      client.readContract({ address: token, abi: erc20Abi, functionName: 'balanceOf', args: [signer.address] }),
      client.readContract({ address: token, abi: erc20Abi, functionName: 'decimals' }),
    ]);
    return jsonResponse({ owner: signer.address, token, balance, decimals });
  } catch (err) {
    return jsonResponse({ error: describeError(err) }, { status: 500 });
  }
}

import 'server-only';
import { z } from 'zod';
import { jsonResponse } from '@/lib/json';
import { assertRequestAuthorized, CsrfError } from '@/lib/guards/csrf';
import { getAdapter } from '@/lib/adapters';
import { resolvePoolRef } from '@/lib/adapters/resolve-pool';
import { poolIdSchema, addressSchema } from '@/lib/schemas';
import { describeError } from '@/lib/rpc/errors';

const querySchema = z.object({
  chainId: z.coerce.number().int().positive(),
  protocol: z.string().min(1),
  owner: addressSchema,
  poolId: poolIdSchema.optional(),
});

export async function GET(request: Request) {
  try {
    assertRequestAuthorized(request);
  } catch (err) {
    if (err instanceof CsrfError) return jsonResponse({ error: err.message }, { status: 401 });
    throw err;
  }

  const url = new URL(request.url);
  const parsed = querySchema.safeParse(Object.fromEntries(url.searchParams));
  if (!parsed.success) {
    return jsonResponse({ error: 'Invalid query', issues: parsed.error.issues }, { status: 400 });
  }
  const { chainId, protocol: protocolKey, owner, poolId } = parsed.data;

  try {
    const adapter = getAdapter(chainId, protocolKey);
    const ref = poolId ? await resolvePoolRef(chainId, protocolKey, poolId) : undefined;
    const rawPositions = await adapter.listPositions(owner, ref);

    const positions = rawPositions.map((p) => {
      const rangeStatus: 'in-range' | 'above-range' | 'below-range' = p.inRange
        ? 'in-range'
        : p.currentTick >= p.tickUpper
          ? 'above-range'
          : 'below-range';
      return { ...p, rangeStatus };
    });

    const aggregate = {
      total: positions.length,
      inRange: positions.filter((p) => p.rangeStatus === 'in-range').length,
    };

    return jsonResponse({ positions, aggregate });
  } catch (err) {
    return jsonResponse({ error: describeError(err) }, { status: 500 });
  }
}

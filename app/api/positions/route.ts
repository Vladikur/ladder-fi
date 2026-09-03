import 'server-only';
import { z } from 'zod';
import { jsonResponse } from '@/lib/json';
import { assertRequestAuthorized, CsrfError } from '@/lib/guards/csrf';
import { getAdapter } from '@/lib/adapters';
import { resolvePoolRef } from '@/lib/adapters/resolve-pool';
import { getSigner } from '@/lib/signer/local-key';
import { loadMintedPositionLabels } from '@/lib/guards/audit';
import { poolIdSchema } from '@/lib/schemas';

const querySchema = z.object({
  chainId: z.coerce.number().int().positive(),
  protocol: z.string().min(1),
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
  const { chainId, protocol: protocolKey, poolId } = parsed.data;

  try {
    const signer = await getSigner();
    const adapter = getAdapter(chainId, protocolKey);
    const ref = poolId ? await resolvePoolRef(chainId, protocolKey, poolId) : undefined;
    const rawPositions = await adapter.listPositions(signer.address, ref);
    const labels = loadMintedPositionLabels(chainId);

    const positions = rawPositions.map((p) => {
      const known = labels.get(p.tokenId.toString());
      const rangeStatus: 'in-range' | 'above-range' | 'below-range' = p.inRange
        ? 'in-range'
        : p.currentTick >= p.tickUpper
          ? 'above-range'
          : 'below-range';

      // ask = started pure token0, waiting for price to rise through it; bid = started
      // pure token1, waiting for price to fall through it. "Worked" (DCA-executed) means
      // price has actually crossed all the way through and out the far side, not merely
      // that the position happens to sit out-of-range (it may simply not be reached yet).
      let worked: boolean | null = null;
      if (known) {
        worked = (known.label === 'ask' && rangeStatus === 'above-range') || (known.label === 'bid' && rangeStatus === 'below-range');
      }
      return { ...p, rangeStatus, worked, label: known?.label ?? null };
    });

    const knownPositions = positions.filter((p) => p.worked !== null);
    const aggregate = {
      total: positions.length,
      inRange: positions.filter((p) => p.rangeStatus === 'in-range').length,
      workedKnown: knownPositions.length,
      workedCount: knownPositions.filter((p) => p.worked).length,
      workedFraction: knownPositions.length > 0 ? knownPositions.filter((p) => p.worked).length / knownPositions.length : null,
    };

    return jsonResponse({ positions, aggregate });
  } catch (err) {
    return jsonResponse({ error: err instanceof Error ? err.message : 'Unknown error' }, { status: 500 });
  }
}

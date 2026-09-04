import 'server-only';
import { z } from 'zod';
import { jsonResponse } from '@/lib/json';
import { assertRequestAuthorized, CsrfError } from '@/lib/guards/csrf';
import { resolvePlan } from '@/lib/services/plan';
import { RangeTooNarrowError } from '@/lib/core';
import { addressSchema, poolIdSchema, decimalStringSchema as decimalString } from '@/lib/schemas';
import { describeError } from '@/lib/rpc/errors';

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
});

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

    return jsonResponse({ ref, pool: state, plan });
  } catch (err) {
    if (err instanceof RangeTooNarrowError) {
      return jsonResponse({ error: err.message, code: 'range-too-narrow', maxN: err.maxN }, { status: 400 });
    }
    return jsonResponse({ error: describeError(err) }, { status: 500 });
  }
}

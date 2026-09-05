import 'server-only';
import { formatUnits } from 'viem';
import { getPublicClient } from '@/lib/rpc/client';
import { getChain } from '@/lib/registry/chains';
import { GuardViolationError } from './limits';

/** CoinGecko id for each chain's native gas token, keyed by ChainDescriptor.nativeCurrency.symbol. */
const NATIVE_COINGECKO_IDS: Record<string, string> = {
  ETH: 'ethereum',
  BNB: 'binancecoin',
};

const PRICE_CACHE_TTL_MS = 30_000;
const priceCache = new Map<string, { usd: number; fetchedAt: number }>();

/**
 * Spot price for the chain's native gas token, from a public external API. This app
 * otherwise has no price oracle (see lib/registry/chains.ts, lib/env.ts) - notional
 * limits are deliberately measured in a stable token rather than converted - but a
 * $-denominated gas budget (Header settings popup, TZ has no equivalent) has no other
 * unit to convert from, since gas is always paid in the native token, never the stable one.
 */
async function getNativeUsdPrice(chainId: number): Promise<number> {
  const chain = getChain(chainId);
  const coingeckoId = NATIVE_COINGECKO_IDS[chain.nativeCurrency.symbol];
  if (!coingeckoId) {
    throw new Error(`No USD price source configured for native currency ${chain.nativeCurrency.symbol}`);
  }

  const cached = priceCache.get(coingeckoId);
  if (cached && Date.now() - cached.fetchedAt < PRICE_CACHE_TTL_MS) return cached.usd;

  const res = await fetch(`https://api.coingecko.com/api/v3/simple/price?ids=${coingeckoId}&vs_currencies=usd`, {
    cache: 'no-store',
    signal: AbortSignal.timeout(5_000),
  });
  if (!res.ok) throw new Error(`Price API responded with status ${res.status}`);
  const data = (await res.json()) as Record<string, { usd?: number }>;
  const usd = data[coingeckoId]?.usd;
  if (typeof usd !== 'number' || !Number.isFinite(usd) || usd <= 0) {
    throw new Error('Price API returned a malformed price');
  }

  priceCache.set(coingeckoId, { usd, fetchedAt: Date.now() });
  return usd;
}

/** The per-gas-unit price a tx is actually capped at - maxFeePerGas under EIP-1559,
 *  gasPrice under legacy - i.e. the same worst-case ceiling the signer itself pays
 *  (see estimateFees in lib/signer/local-key.ts). */
async function estimateGasPriceWei(chainId: number): Promise<bigint> {
  const chain = getChain(chainId);
  const client = getPublicClient(chainId);
  if (chain.gasStrategy === 'legacy') {
    return client.getGasPrice();
  }
  const { maxFeePerGas } = await client.estimateFeesPerGas();
  if (maxFeePerGas === undefined) throw new Error('RPC did not return maxFeePerGas');
  return maxFeePerGas;
}

/**
 * Checked alongside checkGasLimit (lib/guards/limits.ts) before sending each chunk -
 * that one enforces the operator's env-configured MAX_GAS_PER_RUN (raw gas units), this
 * one enforces the user's own $-denominated budget (Header settings popup, localStorage).
 */
export async function checkGasFeeUsd(chainId: number, estimatedGas: bigint, maxGasFeeUsd: number): Promise<void> {
  const chain = getChain(chainId);
  const [gasPriceWei, nativeUsd] = await Promise.all([estimateGasPriceWei(chainId), getNativeUsdPrice(chainId)]);
  const costWei = estimatedGas * gasPriceWei;
  const costUsd = Number(formatUnits(costWei, chain.nativeCurrency.decimals)) * nativeUsd;

  if (costUsd > maxGasFeeUsd) {
    throw new GuardViolationError(
      'gas-fee-usd',
      `Estimated gas fee $${costUsd.toFixed(2)} exceeds your max gas fee setting ($${maxGasFeeUsd})`,
    );
  }
}

// Client-side fetch helpers. No 'server-only' imports here - `import type` only for
// shapes, so nothing server-side ends up in the browser bundle.
import type { PlanResult, Strategy, DepositMode } from '@/lib/core';
import type { PoolRef, PoolState } from '@/lib/adapters/types';
import { RPC_HICCUP_MESSAGE } from '@/lib/rpc/hiccup';

async function apiFetch(appToken: string, path: string, init?: RequestInit): Promise<Response> {
  const res = await fetch(path, {
    ...init,
    headers: { ...init?.headers, 'x-app-token': appToken },
  });
  return res;
}

/** One silent retry for the chain's known-flaky-RPC hiccup, for reads only (never wrap
 *  execute/collect/withdraw - those submit transactions and must not be retried blindly). */
async function withRpcHiccupRetry<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof Error && err.message === RPC_HICCUP_MESSAGE) {
      await new Promise((resolve) => setTimeout(resolve, 600));
      return fn();
    }
    throw err;
  }
}

export interface PoolListItem {
  ref: PoolRef;
  state: PoolState;
}

export async function searchPools(
  appToken: string,
  params: { chainId: number; protocol: string; token?: string; poolId?: string },
): Promise<PoolListItem[]> {
  return withRpcHiccupRetry(async () => {
    const qs = new URLSearchParams({ chainId: String(params.chainId), protocol: params.protocol });
    if (params.token) qs.set('token', params.token);
    if (params.poolId) qs.set('poolId', params.poolId);
    const res = await apiFetch(appToken, `/api/pools?${qs.toString()}`);
    const data = await res.json();
    if (!res.ok) throw new Error(data.error ?? 'Failed to search pools');
    return data.pools;
  });
}

export interface PlanRequestParams {
  chainId: number;
  protocol: string;
  poolId: string;
  baseToken: string;
  strategy: Strategy;
  alpha: number;
  depositMode: DepositMode;
  n: number;
  priceMin: string;
  priceMax: string;
  gapSpacings: number;
  baseAmount: string;
  quoteAmount: string;
  slippageBps: number;
}

export async function getPlan(
  appToken: string,
  params: PlanRequestParams,
): Promise<{ ref: PoolRef; pool: PoolState; plan: PlanResult }> {
  return withRpcHiccupRetry(async () => {
    const res = await apiFetch(appToken, '/api/plan', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(params),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error ?? 'Failed to compute plan');
    return data;
  });
}

export interface SerializedCall {
  to: `0x${string}`;
  data: `0x${string}`;
  /** bigint serialized as a decimal string by lib/json.ts - convert with BigInt(...) before sending. */
  value?: string;
}

export interface PrepareExecuteResult {
  ref: PoolRef;
  warnings: string[];
  positionManager: `0x${string}`;
  mintableBinsCount: number;
  approveCalls: SerializedCall[];
  mintChunks: SerializedCall[][];
}

/** Builds unsigned approve/mint calldata server-side; the caller signs and sends each call via the connected wallet. */
export async function prepareExecute(
  appToken: string,
  params: PlanRequestParams & { owner: string },
): Promise<PrepareExecuteResult> {
  const res = await apiFetch(appToken, '/api/execute', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(params),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error ?? `Failed to prepare execution (status ${res.status})`);
  return data;
}

/** Builds unsigned collect calldata, one chunk per tokenId (same order as `tokenIds`). */
export async function prepareCollect(
  appToken: string,
  params: { chainId: number; protocol: string; owner: string; tokenIds: string[] },
): Promise<{ chunks: SerializedCall[][] }> {
  const res = await apiFetch(appToken, '/api/positions/collect', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(params),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error ?? 'Failed to prepare collect');
  return data;
}

export async function getBalance(
  appToken: string,
  params: { chainId: number; token: string; owner: string },
): Promise<{ owner: string; token: string; balance: string; decimals: number }> {
  return withRpcHiccupRetry(async () => {
    const qs = new URLSearchParams({ chainId: String(params.chainId), token: params.token, owner: params.owner });
    const res = await apiFetch(appToken, `/api/balance?${qs.toString()}`);
    const data = await res.json();
    if (!res.ok) throw new Error(data.error ?? 'Failed to load balance');
    return data;
  });
}

/** Builds unsigned withdraw calldata; `chunkSize` tells the caller how to slice its own `tokenIds` to match `chunks`. */
export async function prepareWithdraw(
  appToken: string,
  params: { chainId: number; protocol: string; owner: string; tokenIds: string[]; bps: number },
): Promise<{ chunks: SerializedCall[][]; chunkSize: number }> {
  const res = await apiFetch(appToken, '/api/positions/withdraw', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(params),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error ?? 'Failed to prepare withdraw');
  return data;
}

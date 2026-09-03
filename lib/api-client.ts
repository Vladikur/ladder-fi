// Client-side fetch helpers. No 'server-only' imports here - `import type` only for
// shapes, so nothing server-side ends up in the browser bundle.
import type { PlanResult, Strategy, DepositMode } from '@/lib/core';
import type { PoolRef, PoolState, PositionView } from '@/lib/adapters/types';

async function apiFetch(appToken: string, path: string, init?: RequestInit): Promise<Response> {
  const res = await fetch(path, {
    ...init,
    headers: { ...init?.headers, 'x-app-token': appToken },
  });
  return res;
}

export interface PoolListItem {
  ref: PoolRef;
  state: PoolState;
}

export async function searchPools(
  appToken: string,
  params: { chainId: number; protocol: string; token?: string; poolId?: string },
): Promise<PoolListItem[]> {
  const qs = new URLSearchParams({ chainId: String(params.chainId), protocol: params.protocol });
  if (params.token) qs.set('token', params.token);
  if (params.poolId) qs.set('poolId', params.poolId);
  const res = await apiFetch(appToken, `/api/pools?${qs.toString()}`);
  const data = await res.json();
  if (!res.ok) throw new Error(data.error ?? 'Failed to search pools');
  return data.pools;
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
  const res = await apiFetch(appToken, '/api/plan', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(params),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error ?? 'Failed to compute plan');
  return data;
}

export type ExecuteEvent = { type: string; [key: string]: unknown };

/** Streams SSE events from /api/execute, calling onEvent for each one, until the stream ends. */
export async function executeStream(
  appToken: string,
  params: PlanRequestParams & { resumeFromChunk?: number },
  onEvent: (event: ExecuteEvent) => void,
): Promise<void> {
  const res = await apiFetch(appToken, '/api/execute', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(params),
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error ?? `Execute request failed with status ${res.status}`);
  }
  if (!res.body) throw new Error('No response body for SSE stream');

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const parts = buffer.split('\n\n');
    buffer = parts.pop() ?? '';
    for (const part of parts) {
      const line = part.split('\n').find((l) => l.startsWith('data: '));
      if (!line) continue;
      try {
        onEvent(JSON.parse(line.slice('data: '.length)));
      } catch {
        // ignore malformed SSE frame
      }
    }
  }
}

export async function listPositions(
  appToken: string,
  params: { chainId: number; protocol: string; poolId?: string },
): Promise<{ positions: (PositionView & { rangeStatus: string; worked: boolean | null; label: string | null })[]; aggregate: Record<string, unknown> }> {
  const qs = new URLSearchParams({ chainId: String(params.chainId), protocol: params.protocol });
  if (params.poolId) qs.set('poolId', params.poolId);
  const res = await apiFetch(appToken, `/api/positions?${qs.toString()}`);
  const data = await res.json();
  if (!res.ok) throw new Error(data.error ?? 'Failed to load positions');
  return data;
}

export async function collectPositions(
  appToken: string,
  params: { chainId: number; protocol: string; tokenIds: string[] },
): Promise<{ results: { tokenId: string; hash: string; success: boolean }[] }> {
  const res = await apiFetch(appToken, '/api/positions/collect', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(params),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error ?? 'Failed to collect fees');
  return data;
}

export async function getBalance(
  appToken: string,
  params: { chainId: number; token: string },
): Promise<{ owner: string; token: string; balance: string; decimals: number }> {
  const qs = new URLSearchParams({ chainId: String(params.chainId), token: params.token });
  const res = await apiFetch(appToken, `/api/balance?${qs.toString()}`);
  const data = await res.json();
  if (!res.ok) throw new Error(data.error ?? 'Failed to load balance');
  return data;
}

export async function withdrawPositions(
  appToken: string,
  params: { chainId: number; protocol: string; tokenIds: string[]; bps: number },
): Promise<{ results: { tokenId: string; hash: string; success: boolean }[] }> {
  const res = await apiFetch(appToken, '/api/positions/withdraw', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(params),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error ?? 'Failed to withdraw');
  return data;
}

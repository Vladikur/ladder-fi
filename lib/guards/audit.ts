import 'server-only';
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import type { Address } from 'viem';
import { getServerEnv } from '@/lib/env';

export interface AuditEntry {
  timestamp: string; // ISO 8601
  chainId: number;
  protocol: string;
  nonce: number;
  hash: string;
  operation: 'approve' | 'mint' | 'collect' | 'withdraw';
  token0: Address;
  token1: Address;
  amount0: string; // bigint as string
  amount1: string;
  tickLower?: number;
  tickUpper?: number;
  /** for 'mint': one entry per position in this chunk, in on-chain event order - lets
   *  the positions view recover each NFT's original ask/bid intent later (TZ §3.5's
   *  "доля отработавших бинов" needs to know which side of the active price a
   *  position started on, which isn't recoverable from current on-chain state alone). */
  positions?: { tokenId?: string; tickLower: number; tickUpper: number; label: 'ask' | 'bid' }[];
  result: 'success' | 'failure';
  errorMessage?: string;
}

/** Append-only. Never includes the key or a raw signed tx - only hash, nonce, gas-adjacent fields. */
export function appendAudit(entry: AuditEntry): void {
  const env = getServerEnv();
  appendFileSync(env.AUDIT_LOG_PATH, JSON.stringify(entry) + '\n', { mode: 0o600 });
}

function readEntries(): AuditEntry[] {
  const env = getServerEnv();
  if (!existsSync(env.AUDIT_LOG_PATH)) return [];
  const raw = readFileSync(env.AUDIT_LOG_PATH, 'utf8');
  const entries: AuditEntry[] = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try {
      entries.push(JSON.parse(line) as AuditEntry);
    } catch {
      // malformed line (e.g. truncated by a crash mid-write) - skip rather than fail the guard check
    }
  }
  return entries;
}

/**
 * Recovers each minted position's original ask/bid label from the audit trail, keyed
 * by tokenId. Positions minted outside this app (or before this ledger existed) simply
 * won't appear and are reported as 'unknown' by the caller.
 */
export function loadMintedPositionLabels(chainId: number): Map<string, { tickLower: number; tickUpper: number; label: 'ask' | 'bid' }> {
  const map = new Map<string, { tickLower: number; tickUpper: number; label: 'ask' | 'bid' }>();
  for (const entry of readEntries()) {
    if (entry.chainId !== chainId || entry.operation !== 'mint' || entry.result !== 'success' || !entry.positions) continue;
    for (const p of entry.positions) {
      if (!p.tokenId) continue;
      map.set(p.tokenId, { tickLower: p.tickLower, tickUpper: p.tickUpper, label: p.label });
    }
  }
  return map;
}

/**
 * Sums today's (UTC) successful mint notional in `notionalToken` raw units, derived
 * from the audit log itself - this is what MAX_NOTIONAL_PER_DAY is checked against.
 * Reading from the log (rather than an in-memory counter) means the limit survives
 * process restarts and is always consistent with what was actually sent on-chain.
 */
export function sumTodayNotional(chainId: number, notionalToken: Address): bigint {
  const todayUtc = new Date().toISOString().slice(0, 10);
  const token = notionalToken.toLowerCase();
  return readEntries()
    .filter((e) => e.chainId === chainId && e.operation === 'mint' && e.result === 'success')
    .filter((e) => e.timestamp.slice(0, 10) === todayUtc)
    .reduce((sum, e) => {
      let contribution = 0n;
      if (e.token0.toLowerCase() === token) contribution += BigInt(e.amount0);
      if (e.token1.toLowerCase() === token) contribution += BigInt(e.amount1);
      return sum + contribution;
    }, 0n);
}

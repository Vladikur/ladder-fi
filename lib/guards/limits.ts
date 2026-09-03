import 'server-only';
import type { Address } from 'viem';
import { getServerEnv } from '@/lib/env';
import { getChain } from '@/lib/registry/chains';
import { sumTodayNotional } from './audit';

export class GuardViolationError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'GuardViolationError';
  }
}

export interface PreflightInput {
  chainId: number;
  token0: Address;
  token1: Address;
  slippageBps: number;
  positionsCount: number;
  /** raw amount of chain.notionalToken being deposited this run (0n if neither leg is that token) */
  notionalThisRun: bigint;
}

/**
 * Server-side guard-rails (TZ §5) - checked here, not only in the UI. KILL_SWITCH is
 * checked first and unconditionally. Every check throws GuardViolationError with a
 * stable `code` so the API layer can map it to a clear client-facing message.
 */
export function runPreflightGuards(input: PreflightInput): void {
  const env = getServerEnv();

  if (env.KILL_SWITCH) {
    throw new GuardViolationError('kill-switch', 'KILL_SWITCH is enabled - all execution is blocked');
  }

  if (input.slippageBps > env.MAX_SLIPPAGE_BPS) {
    throw new GuardViolationError(
      'slippage',
      `Requested slippage ${input.slippageBps}bps exceeds MAX_SLIPPAGE_BPS (${env.MAX_SLIPPAGE_BPS}bps)`,
    );
  }

  if (input.positionsCount > env.MAX_POSITIONS_PER_RUN) {
    throw new GuardViolationError(
      'positions-per-run',
      `Plan has ${input.positionsCount} positions, exceeding MAX_POSITIONS_PER_RUN (${env.MAX_POSITIONS_PER_RUN})`,
    );
  }

  const chain = getChain(input.chainId);
  const touchesNotionalToken =
    input.token0.toLowerCase() === chain.notionalToken.toLowerCase() ||
    input.token1.toLowerCase() === chain.notionalToken.toLowerCase();

  if (touchesNotionalToken) {
    if (env.MAX_NOTIONAL_PER_RUN > 0n && input.notionalThisRun > env.MAX_NOTIONAL_PER_RUN) {
      throw new GuardViolationError(
        'notional-per-run',
        `Run notional ${input.notionalThisRun} exceeds MAX_NOTIONAL_PER_RUN (${env.MAX_NOTIONAL_PER_RUN})`,
      );
    }
    if (env.MAX_NOTIONAL_PER_DAY > 0n) {
      const spentToday = sumTodayNotional(input.chainId, chain.notionalToken);
      if (spentToday + input.notionalThisRun > env.MAX_NOTIONAL_PER_DAY) {
        throw new GuardViolationError(
          'notional-per-day',
          `Today's notional ${spentToday} + this run's ${input.notionalThisRun} would exceed MAX_NOTIONAL_PER_DAY (${env.MAX_NOTIONAL_PER_DAY})`,
        );
      }
    }
  }
}

/** Checked after gas estimation, before sending. */
export function checkGasLimit(estimatedGas: bigint): void {
  const env = getServerEnv();
  if (estimatedGas > env.MAX_GAS_PER_RUN) {
    throw new GuardViolationError(
      'gas-per-run',
      `Estimated gas ${estimatedGas} exceeds MAX_GAS_PER_RUN (${env.MAX_GAS_PER_RUN})`,
    );
  }
}

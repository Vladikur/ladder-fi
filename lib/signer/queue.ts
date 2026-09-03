import 'server-only';
import type { Address } from 'viem';

export class ConcurrentExecutionError extends Error {
  constructor(address: Address) {
    super(`An execution batch is already in progress for ${address}`);
    this.name = 'ConcurrentExecutionError';
  }
}

/**
 * Enforces strictly-1 concurrency per signer address. A second run() call while one is
 * already active for the same address is rejected immediately (maps to HTTP 409 at the
 * API layer) rather than queued - the caller decides whether to retry.
 */
class ExecutionQueue {
  private readonly active = new Set<Address>();

  async run<T>(address: Address, fn: () => Promise<T>): Promise<T> {
    const key = address.toLowerCase() as Address;
    if (this.active.has(key)) {
      throw new ConcurrentExecutionError(address);
    }
    this.active.add(key);
    try {
      return await fn();
    } finally {
      this.active.delete(key);
    }
  }

  isActive(address: Address): boolean {
    return this.active.has(address.toLowerCase() as Address);
  }
}

// Process-wide singleton: this app is single-tenant/self-hosted, one signer address.
export const executionQueue = new ExecutionQueue();

import 'server-only';
import type { Address, PublicClient } from 'viem';

/**
 * Tracks the next nonce for one address. Initializes from getTransactionCount(pending)
 * on first use, then increments locally under a single-flight lock so concurrent
 * callers never hand out the same nonce. On "nonce too low" the caller should call
 * resync() and retry.
 */
export class NonceManager {
  private nonce: number | null = null;
  private chain = Promise.resolve();

  constructor(
    private readonly client: PublicClient,
    private readonly address: Address,
  ) {}

  /** Reserves and returns the next nonce to use, serialized against concurrent callers. */
  async next(): Promise<number> {
    const result = this.chain.then(async () => {
      if (this.nonce === null) {
        this.nonce = await this.client.getTransactionCount({ address: this.address, blockTag: 'pending' });
      }
      const value = this.nonce;
      this.nonce += 1;
      return value;
    });
    // Keep the chain alive even if this particular caller's result rejects downstream.
    this.chain = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  /** Re-reads the pending nonce from the chain, discarding the local counter. Call after a "nonce too low" error. */
  async resync(): Promise<void> {
    const fresh = await this.client.getTransactionCount({ address: this.address, blockTag: 'pending' });
    this.chain = this.chain.then(() => {
      this.nonce = fresh;
    });
    await this.chain;
  }
}

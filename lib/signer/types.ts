import 'server-only';
import type { Address, Hash, TransactionReceipt } from 'viem';

export interface Call {
  to: Address;
  data: `0x${string}`;
  value?: bigint;
}

export interface ISigner {
  address: Address;
  /** Sends one on-chain transaction. Only a single call is supported - adapters are
   *  responsible for pre-combining multiple operations into one call (e.g. via the
   *  target contract's own multicall), the signer never aggregates calldata itself. */
  sendCalls(chainId: number, calls: Call[]): Promise<Hash>;
  waitForReceipt(chainId: number, hash: Hash): Promise<TransactionReceipt>;
}

import { createConfig, http } from 'wagmi';
// Imported from @wagmi/core directly, not the 'wagmi/connectors' barrel: that barrel's
// single index file re-exports every connector (including Coinbase's baseAccount),
// which drags in @coinbase/cdp-sdk's optional @x402/* packages and breaks the webpack
// build even though only `injected` is ever used. @wagmi/core's `injected` is the same
// implementation with no such baggage (its own deps are just eventemitter3/mipd/zustand).
import { injected } from '@wagmi/core';
import { robinhoodChain } from './chain';

// Injected connector only (v1): MetaMask, Rabby, Coinbase Wallet extension, and any
// other EIP-1193 provider a browser extension injects. No WalletConnect - that needs an
// externally-registered WalletConnect Cloud project id, out of scope until asked for.
export const wagmiConfig = createConfig({
  chains: [robinhoodChain],
  connectors: [injected()],
  transports: {
    // Same batching/retry tuning as the server's getPublicClient (lib/rpc/client.ts) -
    // this chain's public RPC is rate-limited and has been observed truncating large
    // JSON-RPC batch responses under load. Without this, waitForTransactionReceipt's
    // polling can silently stall on a transient RPC error after the wallet has already
    // signed and broadcast the transaction, looking like nothing happened.
    [robinhoodChain.id]: http(robinhoodChain.rpcUrls.default.http[0], {
      batch: { batchSize: 10, wait: 20 },
      retryCount: 4,
      retryDelay: 300,
      timeout: 15_000,
    }),
  },
});

declare module 'wagmi' {
  interface Register {
    config: typeof wagmiConfig;
  }
}

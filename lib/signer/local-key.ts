import 'server-only';
import { readFileSync } from 'node:fs';
import {
  createWalletClient,
  http,
  type Address,
  type Hash,
  type PrivateKeyAccount,
  type TransactionReceipt,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { getPublicClient } from '@/lib/rpc/client';
import { getChain } from '@/lib/registry/chains';
import { getServerEnv } from '@/lib/env';
import { NonceManager } from './nonce-manager';
import { decryptV3Keystore, promptPassword } from './keystore';
import type { Call, ISigner } from './types';

const STUCK_TX_TIMEOUT_MS = 60_000;
const MAX_REPLACEMENTS = 5;
const GAS_BUFFER_BPS = 12_000n; // +20%
const FEE_BUMP_BPS = 12_500n; // +25% per replacement, comfortably above the typical 10% mempool minimum

let signerPromise: Promise<LocalKeySigner> | null = null;

/** Lazily creates the process-wide signer singleton. Never logs the key or a raw signed tx. */
export async function getSigner(): Promise<ISigner> {
  if (!signerPromise) {
    signerPromise = LocalKeySigner.create();
  }
  return signerPromise;
}

async function resolveAccount(): Promise<PrivateKeyAccount> {
  const env = getServerEnv();
  if (env.SIGNER_MODE === 'env') {
    if (!env.PRIVATE_KEY) throw new Error('PRIVATE_KEY is required when SIGNER_MODE=env');
    return privateKeyToAccount(env.PRIVATE_KEY as `0x${string}`);
  }

  if (!env.KEYSTORE_PATH) throw new Error('KEYSTORE_PATH is required when SIGNER_MODE=keystore');
  const json = readFileSync(env.KEYSTORE_PATH, 'utf8');
  const password = env.SIGNER_KEYSTORE_PASSWORD ?? (await promptPassword('Keystore password: '));
  const privateKey = decryptV3Keystore(json, password);
  return privateKeyToAccount(privateKey);
}

class LocalKeySigner implements ISigner {
  private readonly nonceManagers = new Map<number, NonceManager>();

  private constructor(private readonly account: PrivateKeyAccount) {}

  static async create(): Promise<LocalKeySigner> {
    const account = await resolveAccount();
    return new LocalKeySigner(account);
  }

  get address(): Address {
    return this.account.address;
  }

  private nonceManagerFor(chainId: number): NonceManager {
    let manager = this.nonceManagers.get(chainId);
    if (!manager) {
      manager = new NonceManager(getPublicClient(chainId), this.address);
      this.nonceManagers.set(chainId, manager);
    }
    return manager;
  }

  private walletClientFor(chainId: number) {
    const chain = getChain(chainId);
    const rpcUrl = chain.rpcUrls[0];
    if (!rpcUrl) throw new Error(`No RPC URL configured for chain ${chainId}`);
    return createWalletClient({
      account: this.account,
      chain: {
        id: chain.id,
        name: chain.name,
        nativeCurrency: { name: chain.nativeCurrency.symbol, symbol: chain.nativeCurrency.symbol, decimals: chain.nativeCurrency.decimals },
        rpcUrls: { default: { http: chain.rpcUrls } },
      },
      transport: http(rpcUrl),
    });
  }

  async sendCalls(chainId: number, calls: Call[]): Promise<Hash> {
    if (calls.length !== 1) {
      throw new Error(
        `sendCalls expects exactly one pre-combined call, got ${calls.length}. Adapters must combine multiple operations into a single call (e.g. via the target contract's own multicall) before reaching the signer.`,
      );
    }
    const call = calls[0]!;
    const chain = getChain(chainId);
    const publicClient = getPublicClient(chainId);
    const walletClient = this.walletClientFor(chainId);
    const nonceManager = this.nonceManagerFor(chainId);

    let nonce = await nonceManager.next();
    let attempt = 0;
    let feeMultiplierBps = 10_000n;

    for (;;) {
      const fees = await this.estimateFees(chainId, chain.gasStrategy, feeMultiplierBps);
      const gas = await publicClient.estimateGas({ account: this.address, to: call.to, data: call.data, value: call.value ?? 0n });
      const gasWithBuffer = (gas * GAS_BUFFER_BPS) / 10_000n;

      let hash: Hash;
      try {
        hash = await walletClient.sendTransaction({
          to: call.to,
          data: call.data,
          value: call.value ?? 0n,
          nonce,
          gas: gasWithBuffer,
          ...fees,
        });
      } catch (err) {
        if (isNonceTooLowError(err)) {
          await nonceManager.resync();
          nonce = await nonceManager.next();
          continue;
        }
        throw err;
      }

      // Console-only, structured, non-secret fields - never the raw signed tx or the key.
      console.log(JSON.stringify({ event: 'tx-sent', chainId, hash, nonce, gas: gasWithBuffer.toString(), attempt }));

      const receipt = await this.waitWithTimeout(chainId, hash, STUCK_TX_TIMEOUT_MS);
      if (receipt) return hash;

      attempt += 1;
      if (attempt > MAX_REPLACEMENTS) {
        throw new Error(`Transaction ${hash} still unconfirmed after ${MAX_REPLACEMENTS} fee-bumped replacements`);
      }
      feeMultiplierBps = (feeMultiplierBps * FEE_BUMP_BPS) / 10_000n;
      console.log(JSON.stringify({ event: 'tx-replace', chainId, previousHash: hash, nonce, attempt }));
      // loop: resend with same nonce, higher fee
    }
  }

  async waitForReceipt(chainId: number, hash: Hash): Promise<TransactionReceipt> {
    return getPublicClient(chainId).waitForTransactionReceipt({ hash });
  }

  private async waitWithTimeout(chainId: number, hash: Hash, timeoutMs: number): Promise<TransactionReceipt | null> {
    const client = getPublicClient(chainId);
    try {
      return await client.waitForTransactionReceipt({ hash, timeout: timeoutMs, pollingInterval: 1_000 });
    } catch {
      return null;
    }
  }

  private async estimateFees(
    chainId: number,
    strategy: 'eip1559' | 'legacy',
    multiplierBps: bigint,
  ): Promise<{ gasPrice?: bigint } | { maxFeePerGas?: bigint; maxPriorityFeePerGas?: bigint }> {
    const client = getPublicClient(chainId);
    if (strategy === 'legacy') {
      const gasPrice = await client.getGasPrice();
      return { gasPrice: (gasPrice * multiplierBps) / 10_000n };
    }
    const { maxFeePerGas, maxPriorityFeePerGas } = await client.estimateFeesPerGas();
    return {
      maxFeePerGas: maxFeePerGas ? (maxFeePerGas * multiplierBps) / 10_000n : undefined,
      maxPriorityFeePerGas: maxPriorityFeePerGas ? (maxPriorityFeePerGas * multiplierBps) / 10_000n : undefined,
    };
  }
}

function isNonceTooLowError(err: unknown): boolean {
  const message = err instanceof Error ? err.message.toLowerCase() : String(err).toLowerCase();
  return message.includes('nonce too low') || message.includes('nonce is too low');
}

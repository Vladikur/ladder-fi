import { encodeFunctionData, zeroAddress, type Hex } from 'viem';
import type { Address, TokenMeta } from '@/lib/core';
import { getPublicClient } from '@/lib/rpc/client';
import type { ProtocolDescriptor } from '@/lib/registry/protocols';
import { erc20Abi, nonfungiblePositionManagerAbi, univ3FactoryAbi, univ3PoolAbi } from './abis';
import type { Call, ILiquidityAdapter, MintPlan, PoolRef, PoolState, PositionView } from './types';

/**
 * Parameterized adapter for any UniswapV3-family fork: differs from another fork only
 * by contracts/feeTiers/initCodeHash in the ProtocolDescriptor, never by new code.
 * "Критерий приёмки по расширяемости": no chainId/protocol branching lives in here.
 */
export class UniswapV3ForkAdapter implements ILiquidityAdapter {
  constructor(private readonly protocol: ProtocolDescriptor) {}

  private get client() {
    return getPublicClient(this.protocol.chainId);
  }

  private get factory(): Address {
    const f = this.protocol.contracts.factory;
    if (!f) throw new Error(`${this.protocol.key}: factory not configured`);
    return f;
  }

  private get positionManager(): Address {
    const pm = this.protocol.contracts.positionManager;
    if (!pm) throw new Error(`${this.protocol.key}: positionManager not configured`);
    return pm;
  }

  async findPools(token: Address, candidates: Address[]): Promise<PoolRef[]> {
    const uniqueCandidates = [...new Set(candidates.map((c) => c.toLowerCase()))].filter(
      (c) => c !== token.toLowerCase(),
    ) as Address[];

    const lookups = uniqueCandidates.flatMap((quote) =>
      this.protocol.feeTiers.map((tier) => ({ quote, fee: tier.fee, tickSpacing: tier.tickSpacing })),
    );

    // allSettled: one candidate's getPool() failing (flaky RPC) shouldn't blank out
    // every other fee-tier/quote-token candidate for this search. But if EVERY lookup
    // failed (e.g. the RPC node is in one of its bad windows right now), that's not
    // "no pools exist" - surface the error instead of silently reporting zero results.
    const settled = await Promise.allSettled(
      lookups.map(({ quote, fee, tickSpacing }) =>
        this.client
          .readContract({
            address: this.factory,
            abi: univ3FactoryAbi,
            functionName: 'getPool',
            args: [token, quote, fee],
          })
          .then((addr) => ({ addr, quote, fee, tickSpacing })),
      ),
    );
    const results = settled.flatMap((r) => (r.status === 'fulfilled' ? [r.value] : []));
    if (results.length === 0 && settled.some((r) => r.status === 'rejected')) {
      throw (settled.find((r): r is PromiseRejectedResult => r.status === 'rejected')!).reason;
    }

    return results
      .filter((r) => r.addr.toLowerCase() !== zeroAddress)
      .map((r) => {
        const [token0, token1] =
          token.toLowerCase() < r.quote.toLowerCase() ? [token, r.quote] : [r.quote, token];
        return {
          id: r.addr,
          protocolKey: this.protocol.key,
          chainId: this.protocol.chainId,
          token0,
          token1,
          fee: r.fee,
          tickSpacing: r.tickSpacing,
        };
      });
  }

  async getPoolState(ref: PoolRef): Promise<PoolState> {
    const [slot0, liquidity, dec0, sym0, dec1, sym1] = await Promise.all([
      this.client.readContract({ address: ref.id, abi: univ3PoolAbi, functionName: 'slot0' }),
      this.client.readContract({ address: ref.id, abi: univ3PoolAbi, functionName: 'liquidity' }),
      this.client.readContract({ address: ref.token0, abi: erc20Abi, functionName: 'decimals' }),
      this.client.readContract({ address: ref.token0, abi: erc20Abi, functionName: 'symbol' }),
      this.client.readContract({ address: ref.token1, abi: erc20Abi, functionName: 'decimals' }),
      this.client.readContract({ address: ref.token1, abi: erc20Abi, functionName: 'symbol' }),
    ]);

    const token0: TokenMeta = { address: ref.token0, decimals: dec0, symbol: sym0 };
    const token1: TokenMeta = { address: ref.token1, decimals: dec1, symbol: sym1 };

    return {
      token0,
      token1,
      fee: ref.fee,
      tickSpacing: ref.tickSpacing,
      sqrtPriceX96: slot0[0],
      tick: slot0[1],
      liquidity,
    };
  }

  async buildApproveCalls(plan: MintPlan): Promise<Call[]> {
    const totals = plan.bins.reduce(
      (acc, b) => ({ amount0: acc.amount0 + b.amount0, amount1: acc.amount1 + b.amount1 }),
      { amount0: 0n, amount1: 0n },
    );
    const calls: Call[] = [];
    if (totals.amount0 > 0n) {
      calls.push({
        to: plan.ref.token0,
        data: encodeFunctionData({
          abi: erc20Abi,
          functionName: 'approve',
          args: [this.positionManager, totals.amount0],
        }),
      });
    }
    if (totals.amount1 > 0n) {
      calls.push({
        to: plan.ref.token1,
        data: encodeFunctionData({
          abi: erc20Abi,
          functionName: 'approve',
          args: [this.positionManager, totals.amount1],
        }),
      });
    }
    return calls;
  }

  async buildMintCalls(plan: MintPlan): Promise<Call[][]> {
    const mintable = plan.bins.filter((b) => b.amount0 > 0n || b.amount1 > 0n);
    const mintCalldatas: Hex[] = mintable.map((bin) =>
      encodeFunctionData({
        abi: nonfungiblePositionManagerAbi,
        functionName: 'mint',
        args: [
          {
            token0: plan.ref.token0,
            token1: plan.ref.token1,
            fee: plan.ref.fee,
            tickLower: bin.tickLower,
            tickUpper: bin.tickUpper,
            amount0Desired: bin.amount0,
            amount1Desired: bin.amount1,
            amount0Min: bin.amount0Min,
            amount1Min: bin.amount1Min,
            recipient: plan.owner,
            deadline: plan.deadline,
          },
        ],
      }),
    );

    const chunkSize = this.protocol.capabilities.maxPositionsPerTx;
    const chunks: Call[][] = [];
    for (let i = 0; i < mintCalldatas.length; i += chunkSize) {
      const slice = mintCalldatas.slice(i, i + chunkSize);
      const data =
        slice.length === 1
          ? slice[0]!
          : encodeFunctionData({ abi: nonfungiblePositionManagerAbi, functionName: 'multicall', args: [slice] });
      chunks.push([{ to: this.positionManager, data }]);
    }
    return chunks;
  }

  async listPositions(owner: Address, ref?: PoolRef): Promise<PositionView[]> {
    const balance = await this.client.readContract({
      address: this.positionManager,
      abi: nonfungiblePositionManagerAbi,
      functionName: 'balanceOf',
      args: [owner],
    });

    const indices = Array.from({ length: Number(balance) }, (_, i) => i);
    const tokenIds = await Promise.all(
      indices.map((i) =>
        this.client.readContract({
          address: this.positionManager,
          abi: nonfungiblePositionManagerAbi,
          functionName: 'tokenOfOwnerByIndex',
          args: [owner, BigInt(i)],
        }),
      ),
    );

    const positions = await Promise.all(
      tokenIds.map((tokenId) =>
        this.client
          .readContract({
            address: this.positionManager,
            abi: nonfungiblePositionManagerAbi,
            functionName: 'positions',
            args: [tokenId],
          })
          .then((p) => ({ tokenId, p })),
      ),
    );

    const filtered = positions.filter(({ p }) => {
      if (p[7] === 0n) return false; // liquidity === 0, fully withdrawn/burned-in-place
      if (!ref) return true;
      return (
        p[2].toLowerCase() === ref.token0.toLowerCase() &&
        p[3].toLowerCase() === ref.token1.toLowerCase() &&
        p[4] === ref.fee
      );
    });

    if (filtered.length === 0) return [];

    // Need current tick per distinct pool to compute in/out of range; batch the
    // distinct (token0,token1,fee) pools via the factory rather than one read per position.
    const distinctPools = new Map<string, { token0: Address; token1: Address; fee: number }>();
    for (const { p } of filtered) {
      const key = `${p[2]}-${p[3]}-${p[4]}`;
      distinctPools.set(key, { token0: p[2], token1: p[3], fee: p[4] });
    }
    const poolEntries = [...distinctPools.entries()];
    const poolAddresses = await Promise.all(
      poolEntries.map(([, meta]) =>
        this.client.readContract({
          address: this.factory,
          abi: univ3FactoryAbi,
          functionName: 'getPool',
          args: [meta.token0, meta.token1, meta.fee],
        }),
      ),
    );
    const [ticks, tickSpacings] = await Promise.all([
      Promise.all(poolAddresses.map((addr) => this.client.readContract({ address: addr, abi: univ3PoolAbi, functionName: 'slot0' }))),
      Promise.all(poolAddresses.map((addr) => this.client.readContract({ address: addr, abi: univ3PoolAbi, functionName: 'tickSpacing' }))),
    ]);
    const tickByKey = new Map(poolEntries.map(([key], i) => [key, ticks[i]![1]]));
    const tickSpacingByKey = new Map(poolEntries.map(([key], i) => [key, tickSpacings[i]!]));

    const tokenMetaCache = new Map<string, TokenMeta>();
    const getTokenMeta = async (address: Address): Promise<TokenMeta> => {
      const key = address.toLowerCase();
      const cached = tokenMetaCache.get(key);
      if (cached) return cached;
      const [decimals, symbol] = await Promise.all([
        this.client.readContract({ address, abi: erc20Abi, functionName: 'decimals' }),
        this.client.readContract({ address, abi: erc20Abi, functionName: 'symbol' }),
      ]);
      const meta: TokenMeta = { address, decimals, symbol };
      tokenMetaCache.set(key, meta);
      return meta;
    };

    const views: PositionView[] = [];
    for (const { tokenId, p } of filtered) {
      const key = `${p[2]}-${p[3]}-${p[4]}`;
      const currentTick = tickByKey.get(key) ?? 0;
      const [token0, token1] = await Promise.all([getTokenMeta(p[2]), getTokenMeta(p[3])]);
      views.push({
        tokenId,
        ref: {
          id: poolAddresses[poolEntries.findIndex(([k]) => k === key)]!,
          protocolKey: this.protocol.key,
          chainId: this.protocol.chainId,
          token0: p[2],
          token1: p[3],
          fee: p[4],
          tickSpacing: tickSpacingByKey.get(key) ?? 0,
        },
        token0,
        token1,
        fee: p[4],
        tickLower: p[5],
        tickUpper: p[6],
        liquidity: p[7],
        currentTick,
        inRange: currentTick >= p[5] && currentTick < p[6],
        tokensOwed0: p[10],
        tokensOwed1: p[11],
      });
    }
    return views;
  }

  async getPositionSummary(tokenId: bigint): Promise<{ token0: Address; token1: Address; tickLower: number; tickUpper: number }> {
    const p = await this.client.readContract({
      address: this.positionManager,
      abi: nonfungiblePositionManagerAbi,
      functionName: 'positions',
      args: [tokenId],
    });
    return { token0: p[2], token1: p[3], tickLower: p[5], tickUpper: p[6] };
  }

  async buildCollectCalls(owner: Address, tokenIds: bigint[]): Promise<Call[][]> {
    const maxUint128 = (1n << 128n) - 1n;
    return tokenIds.map((tokenId) => [
      {
        to: this.positionManager,
        data: encodeFunctionData({
          abi: nonfungiblePositionManagerAbi,
          functionName: 'collect',
          args: [{ tokenId, recipient: owner, amount0Max: maxUint128, amount1Max: maxUint128 }],
        }),
      },
    ]);
  }

  /** decreaseLiquidity -> collect -> burn per position, batched across up to
   *  maxPositionsPerTx positions into one multicall per chunk (same chunking as buildMintCalls). */
  async buildWithdrawCalls(owner: Address, tokenIds: bigint[], bps: number): Promise<Call[][]> {
    if (bps <= 0 || bps > 10_000) throw new Error('bps must be in (0, 10000]');
    const maxUint128 = (1n << 128n) - 1n;
    const deadline = BigInt(Math.floor(Date.now() / 1000) + 300);

    const positions = await Promise.all(
      tokenIds.map((tokenId) =>
        this.client
          .readContract({
            address: this.positionManager,
            abi: nonfungiblePositionManagerAbi,
            functionName: 'positions',
            args: [tokenId],
          })
          .then((p) => ({ tokenId, liquidity: p[7] })),
      ),
    );

    const callsPerPosition: Hex[][] = positions.map(({ tokenId, liquidity }) => {
      const liquidityToRemove = (liquidity * BigInt(bps)) / 10_000n;
      const calls: Hex[] = [
        encodeFunctionData({
          abi: nonfungiblePositionManagerAbi,
          functionName: 'decreaseLiquidity',
          args: [{ tokenId, liquidity: liquidityToRemove, amount0Min: 0n, amount1Min: 0n, deadline }],
        }),
        encodeFunctionData({
          abi: nonfungiblePositionManagerAbi,
          functionName: 'collect',
          args: [{ tokenId, recipient: owner, amount0Max: maxUint128, amount1Max: maxUint128 }],
        }),
      ];
      if (bps === 10_000) {
        calls.push(encodeFunctionData({ abi: nonfungiblePositionManagerAbi, functionName: 'burn', args: [tokenId] }));
      }
      return calls;
    });

    const chunkSize = this.protocol.capabilities.maxPositionsPerTx;
    const chunks: Call[][] = [];
    for (let i = 0; i < callsPerPosition.length; i += chunkSize) {
      const flat = callsPerPosition.slice(i, i + chunkSize).flat();
      const data = encodeFunctionData({ abi: nonfungiblePositionManagerAbi, functionName: 'multicall', args: [flat] });
      chunks.push([{ to: this.positionManager, data }]);
    }
    return chunks;
  }
}

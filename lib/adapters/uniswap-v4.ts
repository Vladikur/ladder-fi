import { encodeAbiParameters, encodeFunctionData, encodePacked, keccak256, toHex, zeroAddress, type Hex } from 'viem';
import type { Address, TokenMeta } from '@/lib/core';
import { getPublicClient } from '@/lib/rpc/client';
import type { ProtocolDescriptor } from '@/lib/registry/protocols';
import {
  erc20Abi,
  erc721TransferEvent,
  permit2Abi,
  positionManagerV4Abi,
  stateViewAbi,
  v4PoolManagerInitializeEvent,
} from './abis';
import type { Call, ILiquidityAdapter, MintPlan, PoolRef, PoolState, PositionView } from './types';

/** Action opcodes from v4-periphery's Actions.sol - verified against the deployed source, see README. */
const ACTIONS = {
  DECREASE_LIQUIDITY: 0x01,
  MINT_POSITION: 0x02,
  BURN_POSITION: 0x03,
  SETTLE_PAIR: 0x0d,
  TAKE_PAIR: 0x11,
} as const;

const poolKeyAbiType = {
  type: 'tuple',
  components: [
    { name: 'currency0', type: 'address' },
    { name: 'currency1', type: 'address' },
    { name: 'fee', type: 'uint24' },
    { name: 'tickSpacing', type: 'int24' },
    { name: 'hooks', type: 'address' },
  ],
} as const;

const mintParamsAbiTypes = [
  poolKeyAbiType,
  { type: 'int24' },
  { type: 'int24' },
  { type: 'uint256' },
  { type: 'uint128' },
  { type: 'uint128' },
  { type: 'address' },
  { type: 'bytes' },
] as const;

const decreaseParamsAbiTypes = [
  { type: 'uint256' }, // tokenId
  { type: 'uint256' }, // liquidity
  { type: 'uint128' }, // amount0Min
  { type: 'uint128' }, // amount1Min
  { type: 'bytes' }, // hookData
] as const;

const burnParamsAbiTypes = [
  { type: 'uint256' }, // tokenId
  { type: 'uint128' }, // amount0Min
  { type: 'uint128' }, // amount1Min
  { type: 'bytes' }, // hookData
] as const;

const settlePairAbiTypes = [{ type: 'address' }, { type: 'address' }] as const;
const takePairAbiTypes = [{ type: 'address' }, { type: 'address' }, { type: 'address' }] as const;

const unlockDataAbiTypes = [{ type: 'bytes' }, { type: 'bytes[]' }] as const;

const MAX_UINT48 = (1n << 48n) - 1n;

/** How far back (in blocks) findPools scans for Initialize events by default before narrowing.
 *  This chain's v4 Initialize-event volume is high enough that a single-currency-filtered
 *  eth_getLogs over the *full* history reliably exceeds the RPC's 10,000-match cap (verified
 *  empirically: currency0=WETH matched ~2,000 logs over the most recent 2,000,000 blocks, and
 *  ~7,400 over 4,000,000) - so pool discovery here is necessarily bounded to recent activity,
 *  unlike v3's factory.getPool() which is a single deterministic lookup. See README "Deviations". */
const FIND_POOLS_WINDOW_BLOCKS = 2_000_000n;
const FIND_POOLS_WINDOW_FLOOR_BLOCKS = 50_000n;

function ceilMulDiv(amount: bigint, numerator: bigint, denominator: bigint): bigint {
  return (amount * numerator + denominator - 1n) / denominator;
}

const Q128 = 1n << 128n;
const MASK256 = (1n << 256n) - 1n;

/** PoolManager.Position.getFeeOwed's own formula (fee-growth delta * liquidity / Q128).
 *  feeGrowth accumulators are meant to overflow mod 2**256 (Solidity's unchecked
 *  subtraction wraps); BigInt doesn't wrap on its own, so mask explicitly to reproduce
 *  the same wrapped delta the contract computes. */
function feeOwed(feeGrowthInsideX128: bigint, feeGrowthInsideLastX128: bigint, liquidity: bigint): bigint {
  const delta = (feeGrowthInsideX128 - feeGrowthInsideLastX128) & MASK256;
  return (delta * liquidity) / Q128;
}

function decodeTick(info: bigint, offsetBits: bigint): number {
  const raw = (info >> offsetBits) & 0xffffffn;
  const signBit = 1n << 23n;
  return Number((raw ^ signBit) - signBit);
}

function poolKeyFor(ref: PoolRef): { currency0: Address; currency1: Address; fee: number; tickSpacing: number; hooks: Address } {
  // Only hookless pools are ever resolved into a PoolRef (see resolve-pool.ts / findPools below),
  // so it's always safe to hardcode the zero address here rather than carry `hooks` on PoolRef.
  return { currency0: ref.token0, currency1: ref.token1, fee: ref.fee, tickSpacing: ref.tickSpacing, hooks: zeroAddress };
}

function isRangeError(err: unknown): boolean {
  const message = err instanceof Error ? err.message.toLowerCase() : String(err).toLowerCase();
  return message.includes('exceeds limit') || message.includes('too many') || message.includes('range');
}

/**
 * Uniswap v4 adapter: a single PoolManager singleton holds every pool's state (no
 * per-pool contract, no factory), and liquidity is provided through PositionManager's
 * Actions-router `modifyLiquidities` entrypoint rather than a per-call `mint()`. Token
 * transfers settle through Permit2 (PositionManager._pay calls
 * `permit2.transferFrom(...)`), so - unlike the v3-fork adapter - approving requires two
 * hops: ERC20 -> Permit2, then a Permit2 allowance for PositionManager as spender.
 *
 * PoolKey math (liquidity/amount sizing) is identical to v3's - lib/core is reused
 * unchanged. Only pools with no hooks and no native-currency leg are supported (see
 * resolvePoolRef/findPools); hooked pools can have arbitrary custom behaviour on
 * liquidity add that this app has no way to reason about safely.
 */
export class UniswapV4Adapter implements ILiquidityAdapter {
  constructor(private readonly protocol: ProtocolDescriptor) {}

  private get client() {
    return getPublicClient(this.protocol.chainId);
  }

  private get poolManager(): Address {
    const pm = this.protocol.contracts.poolManager;
    if (!pm) throw new Error(`${this.protocol.key}: poolManager not configured`);
    return pm;
  }

  private get positionManager(): Address {
    const pm = this.protocol.contracts.positionManager;
    if (!pm) throw new Error(`${this.protocol.key}: positionManager not configured`);
    return pm;
  }

  private get stateView(): Address {
    const sv = this.protocol.contracts.stateView;
    if (!sv) throw new Error(`${this.protocol.key}: stateView not configured`);
    return sv;
  }

  private get permit2(): Address {
    const p2 = this.protocol.contracts.permit2;
    if (!p2) throw new Error(`${this.protocol.key}: permit2 not configured`);
    return p2;
  }

  private async scanInitializeLogs(args: { currency0: Address } | { currency1: Address }) {
    const latest = await this.client.getBlockNumber();
    let window = FIND_POOLS_WINDOW_BLOCKS;
    for (;;) {
      const fromBlock = latest > window ? latest - window : 0n;
      try {
        return await this.client.getLogs({
          address: this.poolManager,
          event: v4PoolManagerInitializeEvent[0],
          args,
          fromBlock,
          toBlock: 'latest',
        });
      } catch (err) {
        if (window <= FIND_POOLS_WINDOW_FLOOR_BLOCKS || !isRangeError(err)) throw err;
        window = window / 2n;
      }
    }
  }

  /** Best-effort recent-pool discovery - see FIND_POOLS_WINDOW_BLOCKS. A pool that hasn't
   *  been (re-)initialized recently and whose id isn't already known won't show up here;
   *  look it up directly via its PoolId instead (same fallback as v3's manual address). */
  async findPools(token: Address, candidates: Address[]): Promise<PoolRef[]> {
    const uniqueCandidates = new Set(candidates.map((c) => c.toLowerCase()).filter((c) => c !== token.toLowerCase()));
    if (uniqueCandidates.size === 0) return [];

    const [asCurrency0, asCurrency1] = await Promise.all([
      this.scanInitializeLogs({ currency0: token }),
      this.scanInitializeLogs({ currency1: token }),
    ]);

    const refs = new Map<string, PoolRef>();
    for (const log of [...asCurrency0, ...asCurrency1]) {
      const { id, currency0, currency1, fee, tickSpacing, hooks } = log.args;
      if (id === undefined || currency0 === undefined || currency1 === undefined || fee === undefined || tickSpacing === undefined) continue;
      if (hooks !== zeroAddress) continue; // hookless only
      if (currency0 === zeroAddress) continue; // no native-currency pools
      const other = currency0.toLowerCase() === token.toLowerCase() ? currency1 : currency0;
      if (!uniqueCandidates.has(other.toLowerCase())) continue;
      refs.set(id, { id, protocolKey: this.protocol.key, chainId: this.protocol.chainId, token0: currency0, token1: currency1, fee, tickSpacing });
    }
    return [...refs.values()];
  }

  async getPoolState(ref: PoolRef): Promise<PoolState> {
    const [slot0, liquidity, dec0, sym0, dec1, sym1] = await Promise.all([
      this.client.readContract({ address: this.stateView, abi: stateViewAbi, functionName: 'getSlot0', args: [ref.id] }),
      this.client.readContract({ address: this.stateView, abi: stateViewAbi, functionName: 'getLiquidity', args: [ref.id] }),
      this.client.readContract({ address: ref.token0, abi: erc20Abi, functionName: 'decimals' }),
      this.client.readContract({ address: ref.token0, abi: erc20Abi, functionName: 'symbol' }),
      this.client.readContract({ address: ref.token1, abi: erc20Abi, functionName: 'decimals' }),
      this.client.readContract({ address: ref.token1, abi: erc20Abi, functionName: 'symbol' }),
    ]);

    const token0: TokenMeta = { address: ref.token0, decimals: dec0, symbol: sym0 };
    const token1: TokenMeta = { address: ref.token1, decimals: dec1, symbol: sym1 };

    return { token0, token1, fee: ref.fee, tickSpacing: ref.tickSpacing, sqrtPriceX96: slot0[0], tick: slot0[1], liquidity };
  }

  /**
   * Unlike v3 (approve exactly the desired amount to the NonfungiblePositionManager),
   * v4 mints specify `liquidity` directly and cap spend via amount0Max/amount1Max, so the
   * amount that must actually be approved is the slippage-buffered *max*, not the
   * zero-slippage exact amount - otherwise a legitimate small price move would make the
   * mint revert on an insufficient Permit2 allowance instead of ever reaching its own
   * slippage check. Both hops (ERC20->Permit2, Permit2->PositionManager) are diffed
   * against current on-chain allowance and only the missing ones are returned.
   */
  async buildApproveCalls(plan: MintPlan): Promise<Call[]> {
    const mintable = plan.bins.filter((b) => b.amount0 > 0n || b.amount1 > 0n);
    const bufferBps = 10_000n + BigInt(plan.slippageBps);
    const totalMax0 = ceilMulDiv(mintable.reduce((s, b) => s + b.amount0, 0n), bufferBps, 10_000n);
    const totalMax1 = ceilMulDiv(mintable.reduce((s, b) => s + b.amount1, 0n), bufferBps, 10_000n);

    const calls: Call[] = [];
    for (const [token, amount] of [
      [plan.ref.token0, totalMax0],
      [plan.ref.token1, totalMax1],
    ] as const) {
      if (amount === 0n) continue;
      await this.pushNeededApprovals(calls, token, amount, plan.owner, plan.deadline);
    }
    return calls;
  }

  private async pushNeededApprovals(calls: Call[], token: Address, amount: bigint, owner: Address, deadline: bigint): Promise<void> {
    const [erc20Allowance, permit2Allowance] = await Promise.all([
      this.client.readContract({ address: token, abi: erc20Abi, functionName: 'allowance', args: [owner, this.permit2] }),
      this.client.readContract({ address: this.permit2, abi: permit2Abi, functionName: 'allowance', args: [owner, token, this.positionManager] }),
    ]);
    if (erc20Allowance < amount) {
      calls.push({ to: token, data: encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [this.permit2, amount] }) });
    }
    const [permit2Amount, permit2Expiration] = permit2Allowance;
    const now = BigInt(Math.floor(Date.now() / 1000));
    if (permit2Amount < amount || BigInt(permit2Expiration) <= now) {
      const expiration = deadline > MAX_UINT48 ? MAX_UINT48 : deadline;
      calls.push({
        to: this.permit2,
        data: encodeFunctionData({ abi: permit2Abi, functionName: 'approve', args: [token, this.positionManager, amount, Number(expiration)] }),
      });
    }
  }

  async buildMintCalls(plan: MintPlan): Promise<Call[][]> {
    const mintable = plan.bins.filter((b) => b.amount0 > 0n || b.amount1 > 0n);
    const chunkSize = this.protocol.capabilities.maxPositionsPerTx;
    const bufferBps = 10_000n + BigInt(plan.slippageBps);
    const poolKey = poolKeyFor(plan.ref);

    const chunks: Call[][] = [];
    for (let i = 0; i < mintable.length; i += chunkSize) {
      const slice = mintable.slice(i, i + chunkSize);
      const actionCodes: number[] = [];
      const params: Hex[] = [];

      for (const bin of slice) {
        actionCodes.push(ACTIONS.MINT_POSITION);
        const amount0Max = ceilMulDiv(bin.amount0, bufferBps, 10_000n);
        const amount1Max = ceilMulDiv(bin.amount1, bufferBps, 10_000n);
        params.push(
          encodeAbiParameters(mintParamsAbiTypes, [
            poolKey,
            bin.tickLower,
            bin.tickUpper,
            bin.liquidity,
            amount0Max,
            amount1Max,
            plan.owner,
            '0x',
          ]),
        );
      }
      actionCodes.push(ACTIONS.SETTLE_PAIR);
      params.push(encodeAbiParameters(settlePairAbiTypes, [plan.ref.token0, plan.ref.token1]));

      const actions = encodePacked(
        actionCodes.map(() => 'uint8'),
        actionCodes,
      );
      const unlockData = encodeAbiParameters(unlockDataAbiTypes, [actions, params]);
      const data = encodeFunctionData({ abi: positionManagerV4Abi, functionName: 'modifyLiquidities', args: [unlockData, plan.deadline] });
      chunks.push([{ to: this.positionManager, data }]);
    }
    return chunks;
  }

  /** No ERC721Enumerable on v4's PositionManager (solmate ERC721 base) - positions are
   *  reconstructed by replaying this owner's own Transfer events, then confirmed live via
   *  ownerOf() for each candidate. Both getLogs calls filter on this app's own signer
   *  address (highly selective), so - unlike findPools' currency-indexed scan - an
   *  unbounded full-history query here is fast regardless of this chain's pool-spam volume. */
  async listPositions(owner: Address, ref?: PoolRef): Promise<PositionView[]> {
    const [received, sent] = await Promise.all([
      this.client.getLogs({ address: this.positionManager, event: erc721TransferEvent[0], args: { to: owner }, fromBlock: 0n, toBlock: 'latest' }),
      this.client.getLogs({ address: this.positionManager, event: erc721TransferEvent[0], args: { from: owner }, fromBlock: 0n, toBlock: 'latest' }),
    ]);

    const events = [
      ...received.map((l) => ({ ...l, dir: 'in' as const })),
      ...sent.map((l) => ({ ...l, dir: 'out' as const })),
    ].sort((a, b) => (a.blockNumber !== b.blockNumber ? Number(a.blockNumber - b.blockNumber) : a.logIndex - b.logIndex));

    const held = new Set<string>();
    for (const e of events) {
      const tokenId = e.args.tokenId;
      if (tokenId === undefined) continue;
      if (e.dir === 'in') held.add(tokenId.toString());
      else held.delete(tokenId.toString());
    }
    if (held.size === 0) return [];

    const candidateIds = [...held].map(BigInt);
    const owners = await Promise.all(
      candidateIds.map((tokenId) =>
        this.client
          .readContract({ address: this.positionManager, abi: positionManagerV4Abi, functionName: 'ownerOf', args: [tokenId] })
          .catch(() => null),
      ),
    );
    const tokenIds = candidateIds.filter((_, i) => owners[i]?.toLowerCase() === owner.toLowerCase());
    if (tokenIds.length === 0) return [];

    const [infos, liquidities] = await Promise.all([
      Promise.all(
        tokenIds.map((tokenId) =>
          this.client.readContract({ address: this.positionManager, abi: positionManagerV4Abi, functionName: 'getPoolAndPositionInfo', args: [tokenId] }),
        ),
      ),
      Promise.all(
        tokenIds.map((tokenId) =>
          this.client.readContract({ address: this.positionManager, abi: positionManagerV4Abi, functionName: 'getPositionLiquidity', args: [tokenId] }),
        ),
      ),
    ]);

    const filtered = tokenIds
      .map((tokenId, i) => ({ tokenId, poolKey: infos[i]![0], info: infos[i]![1], liquidity: liquidities[i]! }))
      .filter(({ liquidity, poolKey }) => {
        if (liquidity === 0n) return false;
        if (!ref) return true;
        return (
          poolKey.currency0.toLowerCase() === ref.token0.toLowerCase() &&
          poolKey.currency1.toLowerCase() === ref.token1.toLowerCase() &&
          poolKey.fee === ref.fee &&
          poolKey.tickSpacing === ref.tickSpacing
        );
      });
    if (filtered.length === 0) return [];

    // current tick per distinct pool, batched over StateView
    const distinctPoolIds = new Map<string, `0x${string}`>();
    for (const { poolKey } of filtered) {
      const key = `${poolKey.currency0}-${poolKey.currency1}-${poolKey.fee}-${poolKey.tickSpacing}`;
      if (!distinctPoolIds.has(key)) distinctPoolIds.set(key, poolIdFor(poolKey));
    }
    const poolIdEntries = [...distinctPoolIds.entries()];
    const slot0s = await Promise.all(
      poolIdEntries.map(([, poolId]) => this.client.readContract({ address: this.stateView, abi: stateViewAbi, functionName: 'getSlot0', args: [poolId] })),
    );
    const tickByKey = new Map(poolIdEntries.map(([key], i) => [key, slot0s[i]![1]]));

    // Uncollected fees, computed the same way PoolManager itself does at collect time
    // (feeGrowthInside delta * liquidity / Q128) rather than left at 0 - v4 doesn't cache
    // a "tokensOwed" field like v3's NPM, but StateView exposes the two pieces needed to
    // derive it live, without first triggering a real collect. PoolManager tracks this
    // position's own liquidity/state under (owner=this PositionManager, tickLower,
    // tickUpper, salt=bytes32(tokenId)) - see v4-periphery PositionManager.sol.
    const feeGrowth = await Promise.all(
      filtered.map(({ tokenId, poolKey, info }) => {
        const poolId = poolIdFor(poolKey);
        const tickLower = decodeTick(info, 8n);
        const tickUpper = decodeTick(info, 32n);
        const salt = toHex(tokenId, { size: 32 });
        return Promise.all([
          this.client.readContract({
            address: this.stateView,
            abi: stateViewAbi,
            functionName: 'getPositionInfo',
            args: [poolId, this.positionManager, tickLower, tickUpper, salt],
          }),
          this.client.readContract({
            address: this.stateView,
            abi: stateViewAbi,
            functionName: 'getFeeGrowthInside',
            args: [poolId, tickLower, tickUpper],
          }),
        ]);
      }),
    );

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
    for (const [i, { tokenId, poolKey, info, liquidity }] of filtered.entries()) {
      const key = `${poolKey.currency0}-${poolKey.currency1}-${poolKey.fee}-${poolKey.tickSpacing}`;
      const currentTick = tickByKey.get(key) ?? 0;
      const tickLower = decodeTick(info, 8n);
      const tickUpper = decodeTick(info, 32n);
      const [positionInfo, feeGrowthInside] = feeGrowth[i]!;
      const [, feeGrowthInside0LastX128, feeGrowthInside1LastX128] = positionInfo;
      const [feeGrowthInside0X128, feeGrowthInside1X128] = feeGrowthInside;
      const tokensOwed0 = feeOwed(feeGrowthInside0X128, feeGrowthInside0LastX128, liquidity);
      const tokensOwed1 = feeOwed(feeGrowthInside1X128, feeGrowthInside1LastX128, liquidity);
      const [token0, token1] = await Promise.all([getTokenMeta(poolKey.currency0), getTokenMeta(poolKey.currency1)]);
      views.push({
        tokenId,
        ref: {
          id: poolIdFor(poolKey),
          protocolKey: this.protocol.key,
          chainId: this.protocol.chainId,
          token0: poolKey.currency0,
          token1: poolKey.currency1,
          fee: poolKey.fee,
          tickSpacing: poolKey.tickSpacing,
        },
        token0,
        token1,
        fee: poolKey.fee,
        tickLower,
        tickUpper,
        liquidity,
        currentTick,
        inRange: currentTick >= tickLower && currentTick < tickUpper,
        tokensOwed0,
        tokensOwed1,
      });
    }
    return views;
  }

  async getPositionSummary(tokenId: bigint): Promise<{ token0: Address; token1: Address; tickLower: number; tickUpper: number }> {
    const [poolKey, info] = await this.client.readContract({
      address: this.positionManager,
      abi: positionManagerV4Abi,
      functionName: 'getPoolAndPositionInfo',
      args: [tokenId],
    });
    return { token0: poolKey.currency0, token1: poolKey.currency1, tickLower: decodeTick(info, 8n), tickUpper: decodeTick(info, 32n) };
  }

  /** DECREASE_LIQUIDITY(tokenId, liquidity=0, ...) credits accrued fees without touching
   *  principal; TAKE_PAIR then pays that credit out. amount0Min/amount1Min=0 because a
   *  fee-only credit is never a debit, so there is nothing for a slippage floor to guard. */
  async buildCollectCalls(owner: Address, tokenIds: bigint[]): Promise<Call[][]> {
    const deadline = BigInt(Math.floor(Date.now() / 1000) + 300);
    const infos = await Promise.all(
      tokenIds.map((tokenId) =>
        this.client.readContract({ address: this.positionManager, abi: positionManagerV4Abi, functionName: 'getPoolAndPositionInfo', args: [tokenId] }),
      ),
    );
    return tokenIds.map((tokenId, i) => {
      const poolKey = infos[i]![0];
      const actions = encodePacked(['uint8', 'uint8'], [ACTIONS.DECREASE_LIQUIDITY, ACTIONS.TAKE_PAIR]);
      const decreaseParams = encodeAbiParameters(decreaseParamsAbiTypes, [tokenId, 0n, 0n, 0n, '0x']);
      const takeParams = encodeAbiParameters(takePairAbiTypes, [poolKey.currency0, poolKey.currency1, owner]);
      const unlockData = encodeAbiParameters(unlockDataAbiTypes, [actions, [decreaseParams, takeParams]]);
      const data = encodeFunctionData({ abi: positionManagerV4Abi, functionName: 'modifyLiquidities', args: [unlockData, deadline] });
      return [{ to: this.positionManager, data }];
    });
  }

  /** decreaseLiquidity (or burn, at bps=10000) -> take per position, batched across up to
   *  maxPositionsPerTx positions into one modifyLiquidities call per chunk (same chunking as buildMintCalls). */
  async buildWithdrawCalls(owner: Address, tokenIds: bigint[], bps: number): Promise<Call[][]> {
    if (bps <= 0 || bps > 10_000) throw new Error('bps must be in (0, 10000]');
    const deadline = BigInt(Math.floor(Date.now() / 1000) + 300);
    const full = bps === 10_000;

    const [infos, liquidities] = await Promise.all([
      Promise.all(
        tokenIds.map((tokenId) =>
          this.client.readContract({ address: this.positionManager, abi: positionManagerV4Abi, functionName: 'getPoolAndPositionInfo', args: [tokenId] }),
        ),
      ),
      Promise.all(
        tokenIds.map((tokenId) =>
          this.client.readContract({ address: this.positionManager, abi: positionManagerV4Abi, functionName: 'getPositionLiquidity', args: [tokenId] }),
        ),
      ),
    ]);

    const perPosition = tokenIds.map((tokenId, i) => {
      const poolKey = infos[i]![0];
      const liquidity = liquidities[i]!;
      const liquidityToRemove = (liquidity * BigInt(bps)) / 10_000n;

      const firstParams = full
        ? encodeAbiParameters(burnParamsAbiTypes, [tokenId, 0n, 0n, '0x'])
        : encodeAbiParameters(decreaseParamsAbiTypes, [tokenId, liquidityToRemove, 0n, 0n, '0x']);
      const takeParams = encodeAbiParameters(takePairAbiTypes, [poolKey.currency0, poolKey.currency1, owner]);
      return {
        actionCodes: [full ? ACTIONS.BURN_POSITION : ACTIONS.DECREASE_LIQUIDITY, ACTIONS.TAKE_PAIR],
        params: [firstParams, takeParams],
      };
    });

    const chunkSize = this.protocol.capabilities.maxPositionsPerTx;
    const chunks: Call[][] = [];
    for (let i = 0; i < perPosition.length; i += chunkSize) {
      const slice = perPosition.slice(i, i + chunkSize);
      const actionCodes = slice.flatMap((p) => p.actionCodes);
      const params = slice.flatMap((p) => p.params);
      const actions = encodePacked(
        actionCodes.map(() => 'uint8'),
        actionCodes,
      );
      const unlockData = encodeAbiParameters(unlockDataAbiTypes, [actions, params]);
      const data = encodeFunctionData({ abi: positionManagerV4Abi, functionName: 'modifyLiquidities', args: [unlockData, deadline] });
      chunks.push([{ to: this.positionManager, data }]);
    }
    return chunks;
  }
}

function poolIdFor(poolKey: { currency0: Address; currency1: Address; fee: number; tickSpacing: number; hooks: Address }): `0x${string}` {
  return keccak256(
    encodeAbiParameters(
      [{ type: 'address' }, { type: 'address' }, { type: 'uint24' }, { type: 'int24' }, { type: 'address' }],
      [poolKey.currency0, poolKey.currency1, poolKey.fee, poolKey.tickSpacing, poolKey.hooks],
    ),
  );
}

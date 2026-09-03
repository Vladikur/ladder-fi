# Liquidity Ladder — Robinhood Chain

Self-hosted, single-user tool that lays concentrated Uniswap v3/v4 liquidity out as a
ladder of narrow one-sided positions using the Bid-Ask weighting strategy (Meteora
DLMM-style). See [`TZ-bid-ask-lp-robinhood-chain.md`](./TZ-bid-ask-lp-robinhood-chain.md)
for the full spec this was built against (v2 support, which the TZ originally called
for, has since been dropped in favor of v4 - see "Deviations" below).

**This holds a live private key with no manual confirmation step.** Read the whole of
"Safety" below before pointing it at real funds.

## Setup

```bash
npm install
cp .env.local.example .env.local   # fill in PRIVATE_KEY, APP_TOKEN
chmod 600 .env.local
npm run dev     # http://127.0.0.1:3000
```

`npm run dev` / `npm run start` both bind to `127.0.0.1` explicitly (`-H 127.0.0.1`);
`middleware.ts` additionally rejects any request whose `Host` header isn't localhost
unless `ALLOW_PUBLIC_BIND=true` is set. Use a wallet dedicated to this tool, funded only
with the working capital and gas you're prepared to lose.

## Verified on-chain addresses

Robinhood Chain (mainnet, chain id `4663`) turned out to have decoy contracts squatting
several well-known cross-chain addresses. Every address in `lib/registry/` was verified
independently on-chain before being hardcoded — never copied from a name search, a
"verified" Blockscout label, or a docs page alone:

- The canonical, identical-on-every-chain `UniswapV3Factory` address
  (`0x1F98431c8aD98523631AE4a59f267346ea31F984`) is a `StubContract.sol` here, not the
  real factory.
- The canonical `Multicall3` address (`0xcA11bde05977b3631167028862bE2a173976CA11`) and
  every other contract *and token* named "Multicall3" found via Blockscout search (7
  contracts, 13 tokens) returns a **frozen, stale `getBlockNumber()`** — none of them are
  real. `chains.ts` leaves `multicall3` unset; reads are batched at the HTTP transport
  level instead (`lib/rpc/client.ts`), so nothing depends on trusting an on-chain
  aggregator that can't be verified.
- The real v3 addresses (`UniswapV3Factory`, `NonfungiblePositionManager`, `QuoterV2`,
  `TickLens`, `UniswapInterfaceMulticall`) came from `developers.uniswap.org`'s own
  deployments page and were then cross-checked *on-chain*:
  `NonfungiblePositionManager.factory()` and `.WETH9()` match the factory/WETH addresses
  below; `factory.feeAmountTickSpacing(fee)` returns the expected Uniswap defaults for
  all four fee tiers (100/1, 500/10, 3000/60, 10000/200);
  `UniswapInterfaceMulticall.getCurrentBlockTimestamp()` matches wall-clock time.
  Bytecode size was also checked (tens of KB, not a thin proxy stub).
- The v4 addresses (`PoolManager`, `PositionManager`, `StateView`, `Permit2`) likewise
  came from `developers.uniswap.org`'s v4 deployments page and were cross-checked
  on-chain: `PositionManager.poolManager()` and `StateView.poolManager()` both match the
  `PoolManager` address below; `PositionManager.permit2()` matches the `Permit2` address
  below; every one of the four carries substantial verified bytecode (tens of KB). The
  exact action-encoding calldata shapes (`Actions.sol`, `CalldataDecoder.sol`,
  `PositionManager.sol` in `Uniswap/v4-periphery`) were read from the real upstream
  source rather than assumed from memory before `lib/adapters/uniswap-v4.ts` was written
  against them, and the PoolId hash (`keccak256(abi.encode(currency0, currency1, fee,
  tickSpacing, hooks))`) was independently verified to match a real on-chain `Initialize`
  event's `id` before being relied on.
- `WETH` (`0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73`, 18 dec) and `USDG`
  (`0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168`, 6 dec) symbols/decimals confirmed
  on-chain.
- Web search results for this chain included several unfamiliar/unofficial-looking
  domains claiming to be "verified address" lists — those were not trusted; only
  `developers.uniswap.org` (Uniswap's own domain) plus independent on-chain calls were
  used as sources of truth.

If you retarget this app at a different chain, re-run an equivalent verification before
trusting any address — see the methodology above, not just "same address as chain X".

## Architecture

Follows the TZ's layering: `lib/core` is pure math (ticks/weights/binning/amounts/
orientation, no React/viem/network) and is shared unchanged by both protocol families —
v4's pools use the identical tick/sqrtPrice/liquidity math as v3, just a different
mint mechanism. `lib/registry` holds the one-entry-per-chain and one-entry-per-protocol
descriptors, `lib/adapters` implements `ILiquidityAdapter` per protocol family
(`UniswapV3ForkAdapter` is parameterized — a PancakeSwap-style v3 fork is a new registry
entry, not new code; `UniswapV4Adapter` similarly isn't parameterized per-chain since v4
has no per-chain factory/init-code-hash to vary). `lib/signer` and `lib/guards` are
server-only (nonce management, single-concurrency execution queue, KILL_SWITCH/limit
checks, append-only audit log), and `/app/api/*` is the only place that wires them
together. The client never sees an RPC URL, a contract address, or the private key —
it only calls this app's own API, which recomputes the plan from scratch server-side on
every `/api/execute` call rather than accepting client-supplied calldata. A pool is
addressed by `PoolRef.id` throughout - a real contract address for v3, or v4's 32-byte
PoolId (there's no per-pool contract to have an address) - re-derived server-side from
on-chain state either way, never trusted from the client (`resolvePoolRef`).

## Deviations from the TZ (flagged per its own §8/§6 instruction to report, not silently work around)

- **No on-chain Multicall3.** See "Verified addresses" above — there isn't a real one
  on this chain. Batching happens via viem's HTTP transport batching instead.
- **No Permit2 for v3.** The TZ's own v3 mint flow already calls for plain `approve()`,
  not `MaxUint256`; given how many canonical addresses on this chain are decoys, an
  unused Permit2 integration would just be extra unverified attack surface for no benefit
  there. v4 has no choice in the matter — its `PositionManager._pay` always settles via
  `permit2.transferFrom(...)` — so v4 mints do use Permit2 (verified genuine on this
  chain, see "Verified addresses"), approved exact-amount and time-boxed to the same
  ~5-minute deadline as the mint itself, never `MaxUint256` / indefinite.
- **Idempotent resend of a partially-failed mint batch** is done via an explicit
  `resumeFromChunk` parameter (the client already saw which chunks confirmed via the
  SSE stream) rather than a full on-chain reconciliation scan. This is simpler than what
  §3.4.8 literally describes and works correctly for the intended flow (retrying from
  the same browser session) but won't detect a completed chunk if you resend from a
  different session without passing `resumeFromChunk`.
- **`MAX_NOTIONAL_PER_RUN`/`_DAY`** are denominated in raw USDG units specifically (see
  `chains.ts`'s `notionalToken`), not a true USD notional across arbitrary tokens —
  there's no price oracle in scope (§7 excludes APR/backtest, and a general-purpose
  oracle wasn't asked for). A deposit that doesn't touch USDG on either leg is exempt
  from these two checks; every other guard still applies.
- **"Доля отработавших бинов" (§3.5)** is only computable for positions this app itself
  minted (their ask/bid intent is recorded in `audit.jsonl` at mint time, since it can't
  be recovered from current on-chain state alone — see the comment in
  `app/api/positions/route.ts`). Positions from elsewhere show as "worked: unknown".
- **shadcn/ui**: not installed via its CLI (which needs an interactive prompt run);
  components are hand-written with the same Tailwind utility classes instead.
- **Uniswap v2 was dropped in favor of v4** (superseding the TZ, at the user's explicit
  request). The old `UniswapV2Adapter`/registry entry/UI toggle are gone.
- **Uniswap v4** only supports pools with no hooks and no native-currency leg
  (`resolvePoolRef`/`findPools` reject anything else) — a hook can arbitrarily override
  liquidity-add behavior in ways this app has no way to reason about safely, and native
  ETH handling (wrap/unwrap, `msg.value`) was never wired into the signer/execute path.
- **v4 pool discovery (`findPools`/the token-search box) is bounded to a recent block
  window** (`FIND_POOLS_WINDOW_BLOCKS` in `lib/adapters/uniswap-v4.ts`, ~2,000,000 blocks
  currently), not the full chain history. This chain's `PoolManager.Initialize` event
  volume is high enough (empirically ~1,400 pools per 100k blocks recently) that a
  single-currency-filtered `eth_getLogs` over full history reliably exceeds the RPC's
  10,000-match cap. The window narrows automatically on that error, but a pool that
  hasn't been touched recently and whose id you don't already know won't show up in
  search — look it up directly by its 32-byte PoolId instead (the "Manual pool address or
  PoolId" fallback field), same as v3's manual-address fallback. `resolvePoolRef`
  (looking up one specific, already-known PoolId) has no such limit - it's an exact,
  unbounded, id-indexed match.
- **v4's PositionManager has no `ERC721Enumerable`** (ships plain `solmate/ERC721`), so
  `listPositions` reconstructs an owner's current holdings by replaying that owner's own
  `Transfer` events chronologically and then confirming each candidate live via
  `ownerOf()`, rather than iterating `tokenOfOwnerByIndex` like v3.
- **`TOKEN_ALLOWLIST` (§5's default-deny token guard) was removed at the user's explicit
  request.** `runPreflightGuards` (`lib/guards/limits.ts`) no longer rejects unlisted
  tokens; `/api/execute` will sign and send against any token pair a plan can be built
  for. `KILL_SWITCH` and the other §5 limits (slippage/positions/notional/gas) are
  unaffected.

## Safety

- `KILL_SWITCH=true` stops all execution immediately, checked before anything else.
- The signer never logs the key or a raw signed transaction — only hash/nonce/gas.
- `audit.jsonl` is append-only; back it up if you care about the DCA "worked fraction"
  metric surviving a disk loss.
- This is genuinely experimental software. Test against small amounts (or the testnet
  at chain id `46630`, `rpc.testnet.chain.robinhood.com` — not wired into the registry
  here, add it the same way as any other chain if you want it) before trusting it with
  anything you can't afford to lose. It gives no financial advice and does not forecast
  returns.

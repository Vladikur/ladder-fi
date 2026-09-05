# LadderFi — Robinhood Chain

Non-custodial, publicly-hostable tool that lays concentrated Uniswap v3/v4 liquidity out
as a ladder of narrow one-sided positions using the Bid-Ask weighting strategy (Meteora
DLMM-style). See [`TZ-bid-ask-lp-robinhood-chain.md`](./TZ-bid-ask-lp-robinhood-chain.md)
for the full spec this was built against (v2 support, which the TZ originally called
for, has since been dropped in favor of v4; the server-held signer the TZ specified has
since been replaced by browser-wallet signing - see "Deviations" below).

**Non-custodial: the server never holds a private key.** Every approval, mint, collect,
and withdraw is built as unsigned calldata server-side and signed by whichever wallet
you connect in your browser (MetaMask, Rabby, or any other injected EIP-1193 wallet).
Read the whole of "Safety" below before pointing it at real funds.

## Setup

```bash
npm install
cp .env.local.example .env.local   # fill in APP_TOKEN
chmod 600 .env.local
npm run dev     # http://127.0.0.1:3000
```

Open the app, click "Connect wallet" in the header, and approve the connection in your
wallet extension. `npm run dev` / `npm run start` both bind to `127.0.0.1` explicitly
(`-H 127.0.0.1`); `middleware.ts` additionally rejects any request whose `Host` header
isn't localhost unless `ALLOW_PUBLIC_BIND=true` is set (needed to host this for other
people - put TLS in front of it if you do).

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
has no per-chain factory/init-code-hash to vary). `/app/api/*` recomputes the plan from
scratch server-side on every `/api/execute` call and returns unsigned calldata (approve
calls + chunked mint calls) rather than accepting or sending client-supplied calldata
itself; `lib/wallet` (client-side) is where the connected browser wallet signs and sends
each call and waits for its receipt via wagmi. `lib/guards/csrf.ts` and
`lib/guards/rate-limit.ts` guard every remaining server route: CSRF (`APP_TOKEN` +
Origin/Sec-Fetch-Site) stops other sites from silently driving this app's API, and a
per-route, per-IP token bucket stops a direct scripted caller - Origin/Sec-Fetch-Site are
only checked when present, so a plain `curl` skips CSRF's second check entirely - from
overloading the one shared RPC client once this is actually hosted for multiple people.
The server never sees an RPC URL beyond its own chain registry, never sees a private
key, and never signs anything.

Reads that don't need trusted re-derivation - listing a connected wallet's positions,
searching for or looking up a pool - run directly in the browser against the chain's RPC
instead of through the server (`lib/adapters/position-view.ts`,
`lib/adapters/pool-search.ts`), calling the exact same adapter methods (`listPositions`,
`findPools`, `getPoolState`, `resolvePoolRef`) the server itself uses for
`/api/plan`/`/api/execute` - there is no `/api/positions` or `/api/pools` route. This
moved client-side because both used to poll/search through the one shared, rate-limited
server RPC client (`lib/rpc/client.ts`) on every connected user's browser: fine for one
local operator, a bottleneck once many people use one hosted instance. `/api/plan`,
`/api/execute`, `/api/positions/collect`, and `/api/positions/withdraw` stay server-side
because they build calldata that must be re-derived from trusted on-chain state, never
accepted from the client - a pool is addressed by `PoolRef.id` throughout (a real
contract address for v3, or v4's 32-byte PoolId - there's no per-pool contract to have an
address), re-derived via `resolvePoolRef` either way.

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
  `resumeFromChunk` index the browser keeps in its own React state (it already saw which
  chunks confirmed while driving the wallet through them one at a time) rather than a
  full on-chain reconciliation scan. This is simpler than what §3.4.8 literally describes
  and works correctly for the intended flow (retrying from the same browser session) but
  won't detect a completed chunk if you resend from a different session/tab.
- **Non-custodial signing (superseding the TZ's server-held-key design, at the user's
  explicit request, to allow hosting this for other people rather than one operator).**
  `/api/execute`, `/api/positions/collect`, and `/api/positions/withdraw` now return
  unsigned calldata instead of signing and sending it; the connected browser wallet
  (wagmi + an injected EIP-1193 provider - MetaMask, Rabby, etc.) does that. As a direct
  consequence, everything that existed only to protect a server-held key from bugs was
  removed rather than ported: `KILL_SWITCH`, `MAX_SLIPPAGE_BPS`, `MAX_POSITIONS_PER_RUN`,
  `MAX_NOTIONAL_PER_RUN`/`_DAY`, `MAX_GAS_PER_RUN`, the nonce manager, the stuck-tx
  fee-bump/replacement loop, the single-concurrency execution queue, and the append-only
  `audit.jsonl` are all gone (`TOKEN_ALLOWLIST` had already been removed earlier, see
  below). Each user now confirms every transaction themselves in their own wallet, at
  whatever gas price and nonce their wallet chooses.
- **"Доля отработавших бинов" (§3.5)** was powered by `audit.jsonl` recording each mint's
  ask/bid intent server-side; since the server no longer signs or sees confirmed mints,
  and per-user auditing across a public multi-tenant app is a different feature that
  wasn't asked for, this metric (and the `label`/`worked` fields the positions listing
  used to carry) was dropped along with the audit log rather than ported to a new
  per-wallet log.
- **shadcn/ui**: not installed via its CLI (which needs an interactive prompt run);
  components are hand-written with the same Tailwind utility classes instead.
- **Uniswap v2 was dropped in favor of v4** (superseding the TZ, at the user's explicit
  request). The old `UniswapV2Adapter`/registry entry/UI toggle are gone.
- **Uniswap v4** only supports pools with no hooks and no native-currency leg
  (`resolvePoolRef`/`findPools` reject anything else) — a hook can arbitrarily override
  liquidity-add behavior in ways this app has no way to reason about safely, and native
  ETH handling (wrap/unwrap, `msg.value`) was never wired into the execute path.
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
  request**, before the rest of §5's guard-rails were later removed too (see the
  non-custodial-signing bullet above). `/api/execute` will build calldata against any
  token pair a plan can be built for; the connected wallet is the only remaining check
  (a user simply won't sign a transaction they don't trust).

## Safety

- The server never sees a private key and never signs or sends a transaction - your
  wallet does both, and you get its own confirmation prompt (and, for injected wallets,
  its own gas/nonce handling and stuck-transaction replacement) for every approval, mint,
  collect, and withdraw.
- `assertRequestAuthorized` (`lib/guards/csrf.ts`) still checks `APP_TOKEN` and
  Origin/Sec-Fetch-Site on every request - it stops other sites from silently driving
  this app's API and popping wallet-signature prompts in your browser.
- `assertRateLimited` (`lib/guards/rate-limit.ts`) caps each remaining server route to a
  per-IP token bucket - CSRF alone doesn't stop a direct scripted client (a `curl` simply
  omits the Origin/Sec-Fetch-Site headers a real browser always sends), so this is the
  backstop against both abuse and many legitimate users overloading the shared RPC once
  `ALLOW_PUBLIC_BIND=true` is set. It's in-memory, one process - correct for the single
  `next start` process this app runs as, but would need a shared store (e.g. Redis) if
  you ever ran multiple instances behind a load balancer.
- This is genuinely experimental software. Test against small amounts (or the testnet
  at chain id `46630`, `rpc.testnet.chain.robinhood.com` — not wired into the registry
  here, add it the same way as any other chain if you want it) before trusting it with
  anything you can't afford to lose. It gives no financial advice and does not forecast
  returns.

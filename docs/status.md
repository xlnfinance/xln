# XLN Status

This is the canonical status surface for XLN. Use it for the current launch
picture, blocker order, active engineering backlog, and assumptions for the
current network shape.

For executable work, use the repository root [todo.md](../todo.md). This file
summarizes why those items matter and how they fit the protocol.

## Current Snapshot

**Date:** 2026-06-14
**State:** current `main` is production-demo/public-testnet grade, not mainnet-ready.

What is true now:

- the bilateral runtime and consensus architecture exist and are actively
  exercised by local, browser, and prod-facing checks;
- official same-origin watchtower recovery is live, encrypted, scheduled, and
  no longer exposes public sweep;
- wiped-browser watchtower recovery and post-restore channel payments are
  covered by browser E2E;
- direct same-chain swaps, direct cross-j swaps, and lending are included in the
  fast E2E gate;
- `bun run gate:release` passed on current `main`;
- a release soak passed 13 complete `gate:ci + hub10k` iterations before manual
  stop, but the full 240-minute soak remains open;
- remaining mainnet risk is concentrated in uninterrupted release-duration soak,
  external audit, real mainnet ops, PSR/peer recovery, observability, and
  explicit product boundaries.

## Precedence

When docs disagree, use this order:

1. code + tests
2. root [todo.md](../todo.md)
3. this file
4. [mainnet.md](mainnet.md)
5. protocol/spec docs
6. archive docs

## Non-Negotiable Current Assumptions

### Network shape

- **Hub = normal entity.** No special consensus model for hubs. A hub is an
  entity with reserves, connectivity, and gossip metadata.
- **Runtime is the source of truth.** Frontends are readers/controllers, not
  authorities.
- **Bilateral state is the main execution surface.** The J-layer is the court
  and settlement anchor, not the fast path.
- **Transport must support direct/public runtime operation.** Relay and public
  WS exist to deliver messages, not to own protocol state.

### Product shape

- **USDC-first is acceptable only if explicit.** Silent single-token
  assumptions are not acceptable.
- **Recovery/watchtower is not optional for mainnet.** Offline users need a
  recovery/dispute story.
- **Debug surfaces are protocol infrastructure.** `/api/debug/events`, health,
  metrics, and replayability are part of the product.

## Recently Closed By `0.1.5`

- Contract, RPC settlement, persistence, watchtower, runtime type, frontend
  type, and browser E2E gates passed in `bun run gate:ci`.
- Full browser E2E passed: `bun run test:e2e:full`.
- Prod payment smoke passed: `bun run test:e2e:prod:payment`.
- Prod health passed: `bun run prod:health`.
- Official tower moved to same-origin `/api/tower/*`.
- Watchtower sweep is scheduled inside the daemon and public
  `/api/watchtower/*` is not exposed through nginx.
- Last-resort tower remedies are encrypted to the tower action public key and
  plaintext last-resort remedies are rejected by the tower HTTP layer.
- Tower uploads are gated by reliable local backup barriers before remote side
  effects continue.
- Browser restart after tower restore keeps recovered runtime/channel state.

## Recently Closed On Current `main`

- `bun run gate:release` passed, including source checks, runtime core unit
  tests, soundcheck, frontend check, contract full suite, RPC settlement parity,
  security audit pack, persistence, watchtower, fast E2E, bounded soak, core
  E2E, RPC system scenarios, hub10k benchmark, and production health smoke.
- The RPC/JAdapter Anvil latest-state snapshot race that produced repeated
  `staticCall`/`J_SUBMIT_FATAL` failures is fixed without relaxing real ABI
  reverts or non-dev-chain failures.
- Fast E2E now includes hub lending: funding a pool, borrowing, and repaying
  from the Lending tab.
- Direct runtime websocket policy is covered: hub direct sockets are allowed,
  non-hub direct endpoints are ignored, plaintext direct entity input is
  rejected, and duplicate hellos do not displace a live socket.

## Active Blocker Order

### P0 - release and mainnet readiness

1. Publish the GitHub Release object for `v0.1.5`; the tag is pushed, but the
   release object is blocked by missing `gh` auth or `GH_TOKEN`.
2. Complete the multi-hour `bun run soak:release` before calling any build a
   mainnet candidate. `bun run gate:release` already passed on current `main`;
   the long soak has only partial evidence so far.
3. Document real mainnet chain/RPC, operator keys, tower gas policy,
   backup/restore drills, and monitoring thresholds.
4. Refresh the external audit pack and treat external audit as required for
   real user funds.

### P1 - protocol and runtime

5. Implement Peer State Refresh so a wiped client can recover from honest peers
   even when a tower is unavailable.
6. Add account-level recovery coverage UI and tower receipt/failure visibility.
7. Classify runtime exceptions as `drop`, `defer`, `debug-assert`, or `fatal`.
8. Re-check current consensus/Hanko production semantics against the current
   code, not old audit snapshots.
9. Re-run a current contract governance/access-control scan before external
   audit.
10. Keep destructive reset/clearDB/dev actions strongly gated.

### P2 - product clarity

11. Make the token support boundary explicit: prove multi-token E2E or keep
    the current release line visibly single-token/USDC-first.
12. Clean up custody/fee UX, settlement flow consistency, and activity/account
    cards enough for support/debug use.

## Workstreams

### Contracts and J-Layer

- keep current Depository coverage green;
- preserve explicit nonce/replay tests;
- keep RPC settlement and dispute scenarios in the required gate set;
- improve RPC-side state commitment quality.

### Runtime and Consensus

- run release-duration restart/crash/load soaks;
- keep `consensus-invariants.md` as the living bug-prevention checklist;
- simplify exception handling only after each path has a clear disposition.

### Recovery and Offline Safety

- finish PSR and recovery coverage UX;
- keep tower backup, restore, and delayed-last-resort tests in the gate set;
- prove restore and defense on realistic offline cases, not only clean demos.

### Transport and Ops

- keep one coherent deployment surface for frontend, runtime, relay, tower, and
  local chain/testnet components;
- make runtime, market maker, storage, relay, and tower readiness visible in
  health/metrics.

### Product and UI

- keep dev/scenario surfaces out of the normal wallet path;
- make settlements, disputes, and recovery visible enough for demo and support.

### Multisigner-First Direction

- one authorization envelope for entity actions;
- proposer is coordinator, not implicit authority;
- ingress verification is quorum-aware;
- `1-of-1` is configuration, not a separate auth model;
- J-batch auth moves to strict entity quorum semantics;
- complex-board tests must exist, not just happy-path single-signer tests.

## Historical Reference

Historical snapshots remain in `docs/archive/`. They are useful for context but
must not be treated as active TODOs.

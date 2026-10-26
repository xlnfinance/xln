# XLN Status

This page holds no queue. The only live release queue is the repository
[todo.md](../todo.md); the current execution handoff is
[night-work-plan.md](night-work-plan.md); scope and authority are in
[AGENTS.md](../AGENTS.md). Release requires `bun run gate:mainnet` (including the
uninterrupted one-hour mainnet-preflight soak) on the final clean SHA, per
[mainnet-acceptance-gate.md](mainnet-acceptance-gate.md) and [mainnet.md](mainnet.md).

## Precedence

Newer owner decisions and [AGENTS.md](../AGENTS.md) govern scope and authority.
Canonical protocol specifications define intended behavior; code and tests provide
evidence of implemented behavior, including defects. An implementation does not
silently override an invariant. Dated evidence does not prove current readiness.

## Non-negotiable assumptions

### Network shape

- **Hub = normal entity.** No special consensus model for hubs. A hub is an
  entity with reserves, connectivity, and gossip metadata.
- **Runtime is the source of truth.** Frontends are readers/controllers, not
  authorities.
- **Bilateral state is the main execution surface.** The J-layer is the court
  and settlement anchor, not the fast path.
- **Transport delivers messages; it never owns protocol state.** Direct hub
  sockets and authenticated relay are both canonical delivery paths.

### Product shape

- **Token support is explicit.** Silent single-token assumptions are not acceptable.
- **Recovery/watchtower is required for mainnet.** Offline users need a
  recovery/dispute story; local encrypted backups and independent watchtowers are
  the required recovery paths, Peer State Refresh is optional.
- **Debug surfaces are protocol infrastructure.** `/api/debug/events`, health,
  metrics, and replayability are part of the product.

### Multisigner-first direction

- one authorization envelope for entity actions;
- proposer is coordinator, not implicit authority;
- ingress verification is quorum-aware;
- `1-of-1` is configuration, not a separate auth model;
- J-batch auth uses strict entity quorum semantics;
- complex-board tests must exist, not just happy-path single-signer tests.

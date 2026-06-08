# XLN Mainnet Bar

**[Index](readme.md)** | **[Current Status](status.md)** | **[Roadmap](roadmap.md)** | **[TODO](../todo.md)**

This file defines the release bar for real user funds. It is narrower than
`status.md`: status explains what is active now; this file explains what must
be true before mainnet is acceptable.

## Current Position

**Date:** 2026-05-29
**State:** `0.1.5` is not mainnet-ready.

`0.1.5` materially raised the floor: watchtower recovery is live, encrypted,
scheduled, covered by browser E2E, and production health/payment smoke passed.
That is enough for a serious public demo and testnet-grade iteration. It is not
enough for real funds because release-duration soak, real mainnet ops, and
external audit are still open.

## Public Testnet / Demo Scope

The current public-testnet/demo surface includes:

- server runtime and RPC JAdapter paths;
- transport ingress, encrypted entity inputs, and hub direct endpoints;
- storage snapshot/WAL restore and canonical hashes;
- J-layer `processBatch` contract integration on local Anvil/RPC;
- user-facing payments, swaps, cross-j flows, disputes, and recovery through
  the shared app UI;
- official same-origin watchtower backup restore and delayed-last-resort
  counter-dispute infrastructure;
- browser E2E for wiped-browser watchtower restore and post-restore channel
  payments.

BrowserVM remains useful as a local simulator, but BrowserVM success alone is
not evidence for mainnet readiness.

## Mainnet Gates

All gates need a credible answer before launch.

### 1. Contract and J-layer correctness

Required:

- current Depository integration suite is green;
- replay/nonce safety is explicitly tested;
- RPC settlement path is proven end to end;
- dispute and counter-dispute paths are proven end to end;
- J-side commitment/state-root quality is good enough for replay, dispute, and
  debug use.

Executable checks:

```bash
bun run test:e2e:coverage
bun run test:contracts:full
bun run test:rpc-settlement
```

### 2. Recovery and offline safety

Required:

- encrypted tower backup/restore remains green;
- delayed-last-resort tower action remains green;
- Peer State Refresh exists for honest-peer recovery when towers are absent;
- persistence repair/recovery tooling is documented and usable;
- restore drills cover wiped browser, restart, and offline user cases.

Executable checks:

```bash
bun run test:persistence:cli
bun run test:e2e:full
bun run soak:quick
```

### 3. Runtime and consensus stability

Required:

- restart/crash recovery soak passes;
- long-running load soak passes;
- consensus invariants are still satisfied under ugly conditions;
- market maker/reset recovery remains healthy after deploy/restart.

Executable checks:

```bash
bun run gate:ci
bun run gate:release
bun run soak:release
```

### 4. Operational readiness

Required:

- one coherent deployment surface;
- runtime, relay, storage, market maker, and tower readiness visible in health;
- bounded reconnect behavior;
- alerting/metrics good enough to detect child/runtime/storage/tower failure;
- backup/restore and storage incident drills exist;
- operator/tower keys, gas funding, and RPC endpoints are explicit.

Executable checks:

```bash
bun run prod:health
```

### 5. Product-level safety boundaries

Required:

- supported token surface is explicit;
- custody/fee paths are coherent;
- destructive/reset/debug actions are strongly gated;
- normal user UX does not accidentally route through dev-only surfaces;
- recovery coverage is visible enough for users to know whether an account is
  locally backed up, tower-backed, and delayed-last-resort protected.

External audit handoff:

```bash
bun run security:audit-pack
```

Brief: [docs/security/external-audit-brief.md](security/external-audit-brief.md)

## Things That Are Mainnet-Relevant But Not First-Launch Gates

- advanced market topology optimization;
- richer fee markets;
- product polish beyond critical clarity;
- longer-term wallet surface expansion;
- BrowserVM parity and BrowserVM-specific debugger polish;
- multi-tower economics and paid SLA receipts.

## Required Live Docs

Keep these files aligned before launch:

- [../todo.md](../todo.md)
- [status.md](status.md)
- [consensus-invariants.md](consensus-invariants.md)
- [implementation/payment-spec.md](implementation/payment-spec.md)
- [recovery-watchtower-protocol.md](recovery-watchtower-protocol.md)
- [deployment/ops-runbook.md](deployment/ops-runbook.md)
- [deployment/deployment.md](deployment/deployment.md)
- [docs/security/external-audit-brief.md](security/external-audit-brief.md)

## Historical Reference

Older readiness snapshots are preserved under [archive/](archive/) for context.

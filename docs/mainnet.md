# XLN Mainnet Bar

**[← Index](readme.md)** | **[Current Status](status.md)** | **[Roadmap](roadmap.md)**

This file defines the release bar for mainnet and the narrower bar for the next
public testnet.

It is intentionally narrower than `status.md`:
- `status.md` answers: what are we doing now?
- `mainnet.md` answers: what must be true before real user funds are acceptable?

## Current Position

**Date:** 2026-05-21
**State:** not mainnet-ready

The project appears to be in the "testnet/prod-hardening" phase:
- bilateral protocol ideas and core mechanics exist
- the remaining risk is concentrated in integration, recovery, security, and operations

## Public Testnet Scope

The next release target is a strong public testnet, not mainnet. The blocking
surface is deliberately narrow:

- server runtime and RPC JAdapter paths
- transport ingress, encrypted entity inputs, and hub direct endpoints
- storage snapshot/WAL restore and canonical hashes
- J-layer `processBatch` contract integration on real Anvil/RPC
- user-facing Pay, same-account Swap, and Cross-j Swap through the shared app UI
- fast/core E2E for happy paths plus worst-case rejects, partial fills, disputes,
  expiry/clear paths, and reload/restart behavior

BrowserVM is out of the public-testnet release scope. It can remain as a local
dev/demo simulator, but BrowserVM success is not accepted as evidence for
testnet readiness.

## Mainnet Gates

All of these need a credible answer before launch.

### 1. Contract and J-layer correctness

Required:
- current Depository integration suite is green
- replay/nonce safety is explicitly tested
- RPC settlement path is proven end to end
- dispute path is proven end to end
- J-side commitment/state-root quality is good enough for replay/dispute/debug use

Executable checks:

```bash
bun run test:e2e:coverage
bun run test:contracts:full
bun run test:rpc-settlement
```

Why this gate exists:
- if the court/settlement layer is wrong, every higher-layer success is fake

### 2. Recovery and offline safety

Required:
- a minimum watchtower/recovery implementation exists
- users/hubs can survive realistic offline and restart scenarios
- persistence repair/recovery tooling is documented and usable

Executable checks:

```bash
bun run test:persistence:cli
bun run soak:quick
```

Why this gate exists:
- an off-chain system without a credible recovery path is not safe for real funds

### 3. Runtime and consensus stability

Required:
- restart/crash recovery soak passes
- long-running load soak passes
- consensus invariants are still satisfied under ugly conditions

Executable checks:

```bash
bun run gate:ci
bun run soak:release
```

Why this gate exists:
- a protocol that only works in short clean runs is not a payment system

### 4. Operational readiness

Required:
- one coherent deployment surface
- transport readiness visible in health
- bounded reconnect behavior
- alerting/metrics good enough to detect child/runtime/storage failure
- backup/restore and storage incident drills exist

Executable checks:

```bash
bun run prod:health
bun run gate:release
```

Why this gate exists:
- the system has to be operable, not just architecturally correct

### 5. Product-level safety boundaries

Required:
- supported token surface is explicit
- custody/fee paths are coherent
- destructive/reset/debug actions are strongly gated
- normal user UX does not accidentally route through dev-only surfaces

External audit handoff:

```bash
bun run security:audit-pack
```

Brief: [security/external-audit-brief.md](security/external-audit-brief.md) (`docs/security/external-audit-brief.md`)

Why this gate exists:
- production failures often come from boundary confusion, not just cryptography

## Things That Are Mainnet-Relevant But Not Launch Gates

Important, but not always first-launch blockers:

- advanced market topology optimization
- richer fee markets
- product polish beyond critical clarity
- longer-term wallet surface expansion
- BrowserVM parity and BrowserVM-specific debugger polish
- broad demo/full-matrix E2E that does not exercise public-testnet flows

## Required Live Docs

The following files should stay aligned before launch:

- [status.md](status.md)
- [consensus-invariants.md](consensus-invariants.md)
- [implementation/payment-spec.md](implementation/payment-spec.md)
- [recovery-watchtower-protocol.md](recovery-watchtower-protocol.md)
- [deployment/ops-runbook.md](deployment/ops-runbook.md)
- [deployment/deployment.md](deployment/deployment.md)
- [security/external-audit-brief.md](security/external-audit-brief.md)

## Historical Reference

The older, more detailed readiness snapshot was preserved at:

- [archive/planning/mainnet-readiness-2026-01.md](archive/planning/mainnet-readiness-2026-01.md)

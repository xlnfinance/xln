# xln Documentation

**Reserve-Credit Provable Account Network** — bilateral finance with provable
credit, collateral enforcement, and EVM dispute resolution.

Start with [constraints.md](constraints.md). It explains why XLN is not "one
more L2", but a consequence of the scaling and enforcement constraints.

## Quick Start

**New to XLN**

1. [constraints.md](constraints.md) — why broadcast finance cannot scale
2. [intro.md](intro.md) — XLN in 5 minutes
3. [core/12_invariant.md](core/12_invariant.md) — the RCPAN invariant
4. [core/rjea-architecture.md](core/rjea-architecture.md) — the runtime/entity/account/jurisdiction stack
5. [status.md](status.md) — the current source of truth
6. [../todo.md](../todo.md) — the active TODO/NEXT backlog

**Developers**

- [implementation/payment-spec.md](implementation/payment-spec.md) — payments, HTLCs, onion routing
- [radapter.md](radapter.md) — canonical frontend/runtime adapter spec
- [merkle.md](merkle.md) — storage and proof layout
- [consensus-invariants.md](consensus-invariants.md) — bilateral consensus footguns
- [debug.md](debug.md) — the required runtime/network debug surface

## Core Protocol

| Document | Description |
|----------|-------------|
| [core/00_QA.md](core/00_QA.md) | motivation, objections, and framing |
| [core/10_UFT.md](core/10_UFT.md) | Unified Financial Theory |
| [core/11_Jurisdiction_Machine.md](core/11_Jurisdiction_Machine.md) | J-machine conceptual model |
| [core/12_invariant.md](core/12_invariant.md) | `−Lₗ ≤ Δ ≤ C + Lᵣ` |
| [core/rjea-architecture.md](core/rjea-architecture.md) | canonical system architecture |

## Architecture

| Document | Description |
|----------|-------------|
| [architecture/bilaterality.md](architecture/bilaterality.md) | why bilateral topology is necessary |
| [architecture/why-evm.md](architecture/why-evm.md) | why XLN needs EVM enforcement |
| [architecture/hanko.md](architecture/hanko.md) | hierarchical entity signatures |
| [architecture/contracts.md](architecture/contracts.md) | on-chain contract surface |
| [merkle.md](merkle.md) | durable state and Merkle roots |
| [radapter.md](radapter.md) | production runtime adapter |

## Specs

| Document | Description |
|----------|-------------|
| [implementation/payment-spec.md](implementation/payment-spec.md) | direct payments, HTLCs, onion routing |
| [custody.md](custody.md) | custody balance for prepaid fees |
| [rebalance.md](rebalance.md) | hub auto-rebalance |
| [lend.md](lend.md) | Lend/Borrow product and runtime design |
| [recovery-watchtower-protocol.md](recovery-watchtower-protocol.md) | recovery, peer refresh, watchtower storage |
| [fintech-type-safety-protocol.md](fintech-type-safety-protocol.md) | type-safety rules for money-moving code |

## Status

| Document | Description |
|----------|-------------|
| [status.md](status.md) | canonical current blockers and workstreams |
| [mainnet.md](mainnet.md) | release bar for real-user-fund launch |
| [roadmap.md](roadmap.md) | phased rollout and strategic direction |
| [../todo.md](../todo.md) | active TODO/NEXT backlog |

## Ops and Debugging

| Document | Description |
|----------|-------------|
| [debug.md](debug.md) | single-source event debugging |
| [debugging/consensus-debugging-guide.md](debugging/consensus-debugging-guide.md) | consensus debugging patterns |
| [e2e-debug-protocol.md](e2e-debug-protocol.md) | E2E triage protocol |
| [deployment/deployment.md](deployment/deployment.md) | canonical deploy surface |
| [deployment/ops-runbook.md](deployment/ops-runbook.md) | health, alerts, recovery |

## Archive

- [archive/](archive/) — historical planning, research, philosophy, and logs

**Last updated:** 2026-06-14

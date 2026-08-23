# xln documentation

This is the canonical documentation index. Architecture, security evidence,
and launch status are separate surfaces and should not be scored as one thing.

## New to xln

1. [constraints.md](constraints.md) — the constraints behind bilateral finance
2. [competitors.md](competitors.md) — architecture matrix, DA analysis, and falsification tests
3. [intro.md](intro.md) — xln in five minutes
4. [core/12_invariant.md](core/12_invariant.md) — the RCPAN invariant
5. [core/rjea-architecture.md](core/rjea-architecture.md) — canonical Runtime → Entity → Account → Jurisdiction cascade

## Theory

- [constraints.md](constraints.md)
- [competitors.md](competitors.md)
- [core/00_QA.md](core/00_QA.md)
- [core/10_UFT.md](core/10_UFT.md)
- [core/11_Jurisdiction_Machine.md](core/11_Jurisdiction_Machine.md)
- [architecture/bilaterality.md](architecture/bilaterality.md)
- [architecture/why-evm.md](architecture/why-evm.md)

## Architecture

- [core/rjea-architecture.md](core/rjea-architecture.md)
- [architecture/contracts.md](architecture/contracts.md)
- [architecture/hanko.md](architecture/hanko.md)
- [architecture/reactive-network.html](architecture/reactive-network.html)
- [merkle.md](merkle.md)
- [protocol-codecs.md](protocol-codecs.md)

## Specifications

- [implementation/payment-spec.md](implementation/payment-spec.md)
- [consensus-invariants.md](consensus-invariants.md)
- [custody.md](custody.md)
- [rebalance.md](rebalance.md)
- [lend.md](lend.md)
- [recovery-watchtower-protocol.md](recovery-watchtower-protocol.md)
- [watchtower-services.md](watchtower-services.md)
- [fintech-type-safety-protocol.md](fintech-type-safety-protocol.md)

## Runtime and client

- [radapter.md](radapter.md)
- [runtime/jadapter.md](runtime/jadapter.md)
- [debug.md](debug.md)
- [debugging/consensus-debugging-guide.md](debugging/consensus-debugging-guide.md)
- [e2e-debug-protocol.md](e2e-debug-protocol.md)

## Security

- [audit-protocol.md](audit-protocol.md) — canonical audit workflow
- [security/](security/) — current security policy, required scans, and review briefs
- [audit/advisor-scorecard.md](audit/advisor-scorecard.md) — evidence-based advisor history

Security reports describe reviewed bytes and evidence freshness. They are not
architecture ratings.

## Operations

- [deployment/deployment.md](deployment/deployment.md)
- [deployment/ops-runbook.md](deployment/ops-runbook.md)
- [testnet-flow-coverage.md](testnet-flow-coverage.md)

## Release and launch status

- [../todo.md](../todo.md) — active work and blockers
- [status.md](status.md) — current operational status
- [mainnet.md](mainnet.md) — real-user-fund release bar
- [mainnet-acceptance-gate.md](mainnet-acceptance-gate.md) — executable acceptance loop
- [releases/manifest.json](releases/manifest.json) — signed immutable release history

Launch readiness is intentionally not imported into the architecture score in
[competitors.md](competitors.md).

**Last updated:** 2026-08-23

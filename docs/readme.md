# xln documentation

This is the canonical documentation index. Architecture, security evidence,
and launch status are separate surfaces and should be assessed independently.

## New to xln

1. [intro.md](intro.md) — J/E/A, the 2050 MML goal and three account protections
2. [core/10_UFT.md](core/10_UFT.md) — Unified Financial Theory and its implementation
3. [constraints.md](constraints.md) — design constraints behind provable finance
4. [core/12_invariant.md](core/12_invariant.md) — the RCPAN invariant
5. [core/rjea-architecture.md](core/rjea-architecture.md) — canonical Runtime → Entity → Account → Jurisdiction cascade

## Theory

- [competitors.md](competitors.md) — architectural claims, limits and falsification
- [research/provable-account-mechanisms.md](research/provable-account-mechanisms.md) — pinned Lightning, Raiden, Hydra, Interledger and generalized-account mechanisms compared with production xln
- [research/btp-and-simplicity.md](research/btp-and-simplicity.md) — BTP versus the xln Account layer, and eight ranked simplicity/reliability ideas from Lightning, TigerBeetle, Mojaloop, Vector and Starlight
- [research/channel-protocol-shapes.md](research/channel-protocol-shapes.md) — twelve channel and provable-account designs side by side with the xln Account, and the two protocol forks they suggest (one Hanko per frame, `account_reestablish`) with adversarial checks
- [constraints.md](constraints.md)
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

- [wallet-journey-plan.md](wallet-journey-plan.md) — new-UI walkthrough and existing-frontend financial E2E requirements
- [radapter.md](radapter.md)
- [runtime/jadapter.md](runtime/jadapter.md)
- [debug.md](debug.md)
- [debugging/consensus-debugging-guide.md](debugging/consensus-debugging-guide.md)
- [e2e-debug-protocol.md](e2e-debug-protocol.md)

## Security

- [audit-protocol.md](audit-protocol.md) — canonical audit workflow
- [security/](security/) — current security policy, required scans, and review briefs
- [audit/advisor-scorecard.md](audit/advisor-scorecard.md) — evidence-based advisor history

Security reports describe reviewed bytes and evidence freshness. Architecture
claims require their own supporting arguments and evidence.

## Operations

- [deployment/deployment.md](deployment/deployment.md)
- [deployment/ops-runbook.md](deployment/ops-runbook.md)
- [testnet-flow-coverage.md](testnet-flow-coverage.md)

## Release and launch status

- [jea-continuation.md](jea-continuation.md) — September 30 implementation, verified E2E evidence and the next production boundary

- [launch-design.md](launch-design.md#minimum-remaining-work--owner-alignment-2026-09-30) — minimum implementation tasks and accepted timing policy

- [../todo.md](../todo.md) — active work and blockers
- [status.md](status.md) — current operational status
- [mainnet.md](mainnet.md) — real-user-fund release bar
- [mainnet-acceptance-gate.md](mainnet-acceptance-gate.md) — executable acceptance loop
- [releases/manifest.json](releases/manifest.json) — signed immutable release history

Launch readiness is assessed separately from the architecture comparison in
[competitors.md](competitors.md).

**Last updated:** 2026-09-30

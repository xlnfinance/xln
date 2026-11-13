# 06: Canonical-chain verification and completion under the 1/12 policy

Type: implementation
Completed: yes
Status: ready-for-human
Category: enhancement
Blocked by: 08
Created: 2026-11-12
Updated: 2026-11-13

## What to build

An operator receives standalone success only from current canonical-chain evidence. A shallow reorganization during construction or final waiting cannot produce a successful result for a missing, moved or inconsistent stack. Recovery either reconciles the same attempt demonstrably or reports a precise conflict.

## Acceptance criteria

- [x] Keep one confirmation between operations and at least twelve for every winning receipt before successful terminal completion, counting inclusion as confirmation one. Do not equate this depth with Ethereum finality or Arbitrum L1 settlement.
- [x] On a real owned local node, remove a completed creation before dependent work. Resume cannot substitute journal success or an address map for current receipt, code and authority evidence.
- [x] Move or remove a receipt while final verification waits. Re-read canonical receipt inclusion and block hashes; stale SDK cache/depth or an earlier hash check cannot produce success.
- [x] Demonstrate supported same-attempt recovery or a specific fail-stop conflict with retained evidence. Never allocate another identity, wipe journal state or send an unverified substitute action automatically.
- [x] There is no successful terminal result at depth eleven of the youngest required receipt. An in-progress report, manifest or native address map may exist; success is written only when all winning receipts reach depth twelve and exact checks pass.
- [x] Canonical checks cover both binding receipts and live addresses, all eight exact linked runtime bytecodes, constructor/Foundation authority, original listing action and selected six-decimal token identity/metadata.
- [x] Completed reruns and resume apply the same current-chain verification. A reorganization after an earlier completion produces a new explicit conflict rather than silently returning obsolete success; retain earlier invocation history.
- [x] Terminal-result replacement is atomic and cannot expose partial success. No catalog read/write/publication is required or triggered by standalone completion.
- [x] Preserve before/after block hashes, receipts, code/state and process outcomes under the stand lock. Manipulate only owned disposable local nodes.
- [x] Reorg/depth acceptance uses the standalone task and verifier. Rust Runtime/HTTP replay, TS application routes and wallet refresh behavior are outside this ticket; preserve their existing integration changes.

## Scope and verification

Use the native Hardhat task and standalone verifier from 08. Its verified result replaces the old catalog-admission completion marker for this ticket. Separate discovery admission may later consume a verified result, but this slice does not implement that integration or a general RJEA reorg-replay engine.

Apply the [CLI recovery boundary](../spec.md#cli-recovery-boundary-owner-decision-2026-11-13).
Use `check:deployment` and owning chain-verification tests. Separate Rust adapter
verification does not gate this ticket's implementation or local acceptance.

## References

- [Standalone deployment specification](../spec.md)
- [08: Standalone Hardhat task](08-standalone-hardhat-stack-deployment.md)

## Comments

2026-11-12: Original title referred to admission because completion was coupled to the publisher. The stable ticket filename is retained; its acceptance now proves standalone verified completion under the owner's updated architecture.

## Recorded verification

The final same-candidate `bun run check:deployment` passed 6/6 gates:
274 Hardhat tests, 64 Foundry checks and 93 Bun tests / 3,505 assertions.
HEAD was `696f6f0ac67003dfffbd5625376f2e3f60256274`, dirty, on the
owner-approved MacBook M5 / `testnets_deploy`. At verification time, 552 source
and 181 artifact hashes matched the checked candidate.

Owner decision 2026-11-14: generated local evidence files are excluded from these
commits. This note records measured results; historical case details cannot be
reconstructed from it. Runnable tests and verification commands remain. Future
active/public deployment evidence requirements are unchanged. No public
deployment or whole-product acceptance is claimed.

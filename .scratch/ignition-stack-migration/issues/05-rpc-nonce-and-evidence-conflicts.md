# 05: Standalone RPC, nonce and evidence conflict handling

Type: implementation
Completed: yes
Status: ready-for-human
Category: enhancement
Blocked by: 08
Created: 2026-11-12
Updated: 2026-11-13

## What to build

An operator resumes the same standalone attempt after RPC or transaction uncertainty with explicit outcomes. Native Ignition reconciles pending, mined, dropped and replaced transactions; changed financial identity or corrupt evidence stops without an unintended send, successful report or substitute stack.

## Acceptance criteria

- [x] Demonstrate pending and mined-but-unobserved recovery through the native task on a real local node, retaining the same attempt and intended nonce sequence.
- [x] Demonstrate a dropped transaction and same-nonce fee replacement using the configured native Ignition policy. Preserve original/replacement lineage and winning receipts; additional hashes do not duplicate successful actions.
- [x] An actual on-chain revert stops subsequent dependent sends and preserves the failed receipt, phase and native cost. No automatic reset, wipe, next-action signing or Fresh Stack Deployment occurs.
- [x] An unexplained externally consumed sender nonce or Foundation action change produces a specific conflict, without changing CREATE order, the original listing nonce or signed arguments.
- [x] Changes to actual chain, signer/Foundation, asset, graph/source/compiler/artifact identity or execution/fee/verification policy reject before a resumed send. Catalog/publication metadata is not part of standalone deployment identity.
- [x] Allow an explicit RPC transport or credential change only after proving the same chain and attempt evidence. Secret-bearing URLs remain transient; they are not catalog metadata or raw result/config snapshots.
- [x] Missing, truncated, corrupt or foreign native journal/attempt identity fails closed even when a previous manifest or address map survives. No summary flag, private-journal scheduler or guessed provenance replaces native recovery.
- [x] Credential-bearing provider errors and nested native diagnostics are sanitized before terminal or durable output while useful codes, hashes and evidence locations remain available. Test local fixture secrets, including early failure paths.
- [x] Successful recovery has eleven intended successful operations, one listing at tokenId one and Foundation nonce one. Completed reruns send zero transactions. A conflict cannot emit successful completion; explicitly account for actions already mined.
- [x] Record actual receipt expenses and native balance reconciliation, including mined failures and replacements where relevant. Do not assume unverified network-specific fee components are zero or treat broadcast count as delivery.
- [x] Caught failures after valid attempt creation produce an atomic failed JSON and nonzero exit; forced termination retains recoverable native evidence and original invocation history.
- [x] RPC/nonce/credential scenarios enter the native CLI and common executor. Extending TS/Rust HTTP protocols, daemon supervision or UI error handling is outside this ticket; preserve existing callers and their shared request contract.

## Scope and verification

Build on 08's basic native resume path using real owned local-node transaction controls. Use the sole Ignition engine and existing standard fee/retry settings; no mocked executor, custom strategy, second scheduler, arbitrary financial cap or automatic fallback belongs here. Local tests do not certify public RPC behavior.

Apply the [CLI recovery boundary](../spec.md#cli-recovery-boundary-owner-decision-2026-11-13).
Use `check:deployment` and owning conflict tests; the separate Rust HTTP adapter
verification is not a dependency of this CLI work.

## References

- [Standalone deployment specification](../spec.md)
- [08: Standalone Hardhat task](08-standalone-hardhat-stack-deployment.md)
- [03: Prior basic resume evidence](03-resume-and-idempotent-completion.md)

## Comments

2026-11-12: Original intent was transaction/RPC uncertainty handling. Updated to remove catalog bindings from standalone identity and to include the owner's approved private execution RPC and terminal-result rules.

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

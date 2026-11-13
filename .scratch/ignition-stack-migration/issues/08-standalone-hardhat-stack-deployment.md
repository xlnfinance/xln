# 08: Standalone Hardhat Stack Deployment with verified result

Type: implementation
Completed: yes
Status: ready-for-human
Category: enhancement
Blocked by: 03
Created: 2026-11-12

## What to build

An operator invokes one native Hardhat task with standard network configuration, JSON parameters, an explicit deployment ID and new/resume intent. It deploys and verifies the existing stack, then preserves native Ignition evidence and a terminal JSON result without starting Stack Manager, server or UI, or reading/writing a jurisdiction catalog.

This is the first new production artifact after the ownership change. It reuses the working fresh/basic-resume behavior from 02/03 and proves it through the new interface before the remaining recovery matrix.

## Acceptance criteria

- [x] A native Hardhat task owns preflight, execution, verification and outcome writing in the supported Node/TypeScript environment. Bun can launch it, but no external Bun financial orchestrator or import-triggered transaction sender remains.
- [x] Expose and reuse the existing Ignition executor and canonical Hanko/checks. Replace Bun-only runtime calls on this path with Node-compatible behavior; no second engine, copied signing formula or compatibility sender is introduced.
- [x] Standard selected-network configuration, environment secrets and JSON parameters work. Ethereum Sepolia and Arbitrum Sepolia configurations have the correct chain IDs and selected existing-USDC parameters. Reusable parameters work across explicit attempt IDs; the module is not hard-coded to two networks. No public transaction is sent by verification.
- [x] Before spending, validate actual chain, signer/Foundation, token metadata, source/compiler/artifact identity, policy and attempt ownership. Private RPC credentials are allowed for execution but excluded from errors, logs, identities, reports and artifacts; do not serialize a full resolved secret-bearing configuration.
- [x] Preserve the eleven-operation graph and stable namespaced Future IDs: eight creations, two bindings and one canonical listing at tokenId one. Hanko uses actual addresses, action nonce one and the same bytes/action across resume.
- [x] One native deployment directory owns journal/artifacts/build information and related evidence. Reconcile metadata initialization with native directory creation; new/resume cannot reset, overwrite foreign state or infer completion from a summary. A missing/corrupt/foreign journal fails closed.
- [x] A real local-Anvil task run completes eleven intended operations, exact linked code/constructors, both live bindings, Foundation authority/nonce and six-decimal token registration. There is no successful terminal result at depth eleven; success appears only after all required winning receipts reach twelve.
- [x] Native Ignition files plus a terminal JSON preserve chain/attempt identity, addresses, transactions, verification results, actual expenses and artifact links. Atomic writing prevents a partial success report. Early malformed inputs return stderr/nonzero; caught valid-attempt errors write failure/nonzero; forced termination never fabricates a terminal outcome.
- [x] Reproduce actual operation-four and operation-eleven mined-before-observation SIGKILL cases through the native task, with nonzero initial EOA nonce and differing addresses. Resume preserves the same journal/listing and completes without duplicate actions; completed reruns re-verify with zero new sends and reconstruct missing derived output.
- [x] Standalone execution neither requires nor reads/mutates the catalog or publishes discovery/gossip. Preserve per-invocation interruption/failure evidence, unrelated data and the abandoned public attempt.
- [x] Retire the old financial orchestration atomically. Existing owning callers receive only thin dispatch/import changes to the same implementation/executor. Preserve genuine CJS-to-TypeScript consumers and supported fixture/wrapped-token paths; do not remove a real export because an inventory tool missed it or route a variant blindly through an incompatible verifier.
- [x] Add a working `check:deployment` profile through the existing commands/check runner: canonical compiler/ABI/bytecode/TypeChain consistency, scoped deployment-module/task types and lint covering real transitive/CJS consumers, owning Hardhat contract tests and Foundry invariants, and real local-Anvil fresh/basic-resume, Hanko, 1/12, configuration/redaction/result and exact-expense checks. State actual coverage; do not substitute a Hardhat-only command, mocks or an empty green profile. Reuse the canonical stand lock and sequential financial execution with process cleanup.
- [x] The focused profile excludes Svelte/React application checks/builds, browser E2E and unrelated core/performance gates, while retaining shared generated-contract artifact parity and canonical Hanko dependencies regardless of their directory. Extend it with owning recovery checks as 04–07 land; missing required checks fail visibly rather than skip. Run and record the mandatory repository check once for the candidate, preserving actual unrelated failures and cancelled gates without UI repair or exemptions. Record source/diff identity, artifact hashes, receipts and expenses.

## Scope and verification

First reproduce the smallest successful real local deployment and its terminal result, then the two selected interrupted cases and owning checks. Use the canonical stand lock and existing local-node controls. The complete per-operation, nonce/replacement, process-loss and reorg matrices remain 04–07; do not expand this slice into a broad audit.

Preserve existing caller behavior through the common executor where compatible. A genuine unsupported variant or adapter conflict must be reported before selecting a new protocol behavior; no new UI, Runtime governance or discovery feature belongs here.

## References

- [Standalone deployment specification](../spec.md)
- [Resolved owner decisions](../map.md)
- [03: Basic resume evidence](03-resume-and-idempotent-completion.md)
- [Accepted ADR](../../../docs/adr/0001-use-hardhat-ignition-for-recoverable-stack-deployments.md)

## Comments

2026-11-12: Added after the owner selected a native Hardhat task independent of Stack Manager. Ticket 03 is already complete, so this is the next unblocked implementation slice. Its publication does not start implementation or authorize public deployment.

2026-11-12: Owner approved adding a focused `check:deployment` profile to this slice. Its creation belongs with the working native task and owning tests; the repository-wide completion/release check remains mandatory. This update changes planning records only.


## Verification

Historical results: the owner deleted all local deployment-task artifacts,
including this final run, on 2026-11-13. The completed status and counts below
are preserved as history. Fresh owning checks and the applicable verification
profile are required before the next deployment or completion claim; these
deleted receipts do not certify the current candidate. Future attempts retain
the evidence required above.

2026-11-13: Implemented on dirty `testnets_deploy`, HEAD/main
`019d45beb5954e77fe806d643845f6a4dca4fa82`, under the owner's MacBook Pro M5,
branch and external-review exceptions. No public transaction, commit or push.

- `bun run check:deployment`: 6/6 stages passed; 274 Hardhat tests, 64 Foundry
  checks in seven suites, 40 Bun tests / 497 assertions. Native fresh and real
  operation-four/eleven SIGKILL cases prove 1/12, exact fees, same Hanko and
  zero sends on completed resume. Changed Hanko source identity rejects before
  sends; private RPC fixture credentials are absent from artifacts.
- Production Solidity, canonical Hanko, React/Svelte source, dependencies,
  `todo.md`, AGENTS.md and completed 01–03 are preserved. The Foundry test
  handler uses the existing Target entry point; no protocol/bytecode change.
- `bun run check`: executed, exit 1 on the two unchanged credential-URL
  fixtures at validation-test lines 137/138. Active sibling gates, including
  Svelte/Vite, were cancelled; those are not new independently observed bugs.
  Release readiness remains false. No rule exemptions were introduced.
- Full process/replacement/reorg/per-operation/result-write matrices remain
  tickets 04–07. No public network compatibility or transfer proof is claimed.

The deleted delivery report and machine-readable result recorded commands,
receipts, then-current source and artifact hashes, exact expenses,
cancelled/unrun gates and source protection.
This implementation completion is separate from repository/release acceptance.

2026-11-13: The owner subsequently approved the contract/deployment
[verification scope](../../../AGENTS.md#verification-scope). Future qualifying
candidates use green `check:deployment` and owning checks; broader changes and
whole-XLN/mainnet release retain the full repository gate. The measured check
results above remain historical evidence, not a requirement to rerun the global
gate for deployment-only work.

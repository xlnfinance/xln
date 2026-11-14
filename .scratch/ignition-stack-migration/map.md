# Standalone Stack Deployment design tree

Status: resolved
Created: 2026-11-12
Design baseline HEAD: 019d45beb5954e77fe806d643845f6a4dca4fa82
Current source and verification records: [execution handoff](../../docs/night-work-plan.md)

## Destination

A CLI/config entry point deploys and verifies the existing EVM jurisdiction
stack through one native Ignition executor, independently of Stack Manager,
and preserves artifacts plus a clear terminal result. The selected public
targets remain Ethereum Sepolia and Arbitrum Sepolia with existing USDC.

## Settled decisions

- Q1, resolved by owner: successful completion follows exact contract, binding,
  USDC registration and receipt verification under the agreed 1/12 policy, then
  preservation of the verified result. Jurisdiction catalog admission is separate.
- Q2, resolved by owner: the module remains in this repository and reuses the
  canonical Hanko, compiler artifacts and XLN checks. It requires neither a
  running Stack Manager/server/UI nor a separate repository/package.
- Q3, resolved by owner: preserve native Ignition files and produce one terminal
  JSON summary with chain/deployment identity, contract and USDC addresses,
  transaction references, verification results, actual expenses and links to
  complete artifacts. This report never controls recovery.
- Q4, resolved by owner: use standard Hardhat network configuration and environment
  values for the network/RPC, with JSON deployment parameters. The private key
  stays in the established secret channel, outside configuration/results.
- Q5, resolved by owner: malformed commands/configuration fail on stderr with a
  nonzero exit code. Once a valid attempt is established, caught operation errors
  are recorded in the terminal JSON. Uncatchable process termination may prevent
  the final write; recovery uses the native Ignition journal, not a guessed outcome.
- Q6, resolved by owner: private RPC endpoints with provider credentials may be
  supplied through environment values. Secrets must be excluded from logs and
  artifacts; public discovery publication remains a separate operation.
- Q7, resolved by owner: the public entry point is a native Hardhat task owning
  the standalone lifecycle. Bun may launch the command, but a separate Bun
  deployment orchestrator is not retained. Reuse the existing Ignition executor
  and checks inside this lifecycle; catalog integration remains separate.
- Architecture candidate A selected: independent Stack Deployment ownership;
  Stack Manager may become a caller of the same module. The canonical Ignition
  executor and journal remain the sole transaction recovery implementation.

## Design tree

```text
Independent Stack Deployment [selected]
  Q1: verified completion versus admission [resolved]
    Q3: terminal result and artifact handoff [resolved]
      Q5: early errors, operation failures and process termination [resolved]
  Q2: independence inside the existing repository [resolved]
    Q4: native Hardhat configuration and JSON parameters [resolved]
      Q6: private execution RPC with secret exclusion [resolved]
  Q7: native Hardhat task owns the lifecycle [resolved]
    Specification and acceptance after extraction [engineering follow-up]
```

## Frontier

- Empty. The owner confirmed the seven decisions and explicitly requested the
  specification and tickets be updated under this architecture. This confirms
  the shared understanding required by the grilling workflow.
- Physical layout is an implementation detail: prefer one native deployment
  directory with the existing atomic evidence-writing mechanisms, without a
  parallel Stack Manager store. Durable release evidence follows AGENTS.md.
- Preserve the already-selected new/resume identity safeguards, immutable financial
  inputs, re-verification without spending for completed attempts, per-invocation
  evidence and independent admission. These are not reopened protocol choices.

## Implementation reference

The [operator guide](../../docs/deployment/ignition-stack-design.md) records the
implemented task, native executor ownership, inputs, outputs and recovery rules.

## Preserved constraints

- Preserve one canonical compiler and Ignition graph, canonical Hanko and the
  agreed confirmation policy. Existing new/resume identity safeguards stay.
- Preserve the abandoned public attempt's contracts and unrelated work. The owner
  deleted its local receipts and all other prior deployment-task artifacts on
  2026-11-13; do not resume or import it. No public execution, store reset,
  dependency upgrade or browser work is implied by this design.
- Reuse useful current manifests/results/evidence instead of introducing another
  durable transaction scheduler or checkpoint.

## Scope reconciliation

The [specification](spec.md), completed [ticket 08](issues/08-standalone-hardhat-stack-deployment.md)
and recovery tickets 04–07 define standalone completion independently of Stack
Manager/catalog admission. Earlier deleted artifacts do not certify a later candidate.

The [2026-11-13 scope boundary](spec.md#cli-recovery-boundary-owner-decision-2026-11-13)
keeps 04–07 on the native CLI, shared executor and local recovery evidence.
Further TS/Rust HTTP and UI integration is a [deferred follow-up](../stack-manager-http-integration/issues/01-deferred-http-ui-integration.md)
with requirements still to be defined. It is not a dependency of 04–07.
The existing Rust request adapter stays intact; completed
[ticket 09](issues/09-minimal-rust-http-adapter-verification.md) records its narrow
verification independently of CLI recovery.

The [accepted ADR](../../docs/adr/0001-use-hardhat-ignition-for-recoverable-stack-deployments.md)
records the settled ownership and completion decisions. The glossary records
the domain distinction between Stack Deployment and discovery admission.

## Delivery status and next work

The native CLI and recovery implementation are complete through ticket 07.
The separate [public delivery](../sepolia-arbitrum-deployment/spec.md) records
both selected networks and the read-only Arbitrum verifier correction.
[Ticket 09](issues/09-minimal-rust-http-adapter-verification.md) also records its
completed narrow adapter verification; further application integration remains deferred.

The separate [reserve roundtrip](../sepolia-arbitrum-usdc-roundtrip/spec.md) is
complete on both public networks, with receipts and exact balance accounting.
Cross-J follows its own financial scope. This resolved design map authorizes
no additional financial execution, push or reset.

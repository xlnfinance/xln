# Standalone Stack Deployment design tree

Status: resolved
Created: 2026-11-12
Inspected HEAD: 019d45beb5954e77fe806d643845f6a4dca4fa82
Candidate: dirty testnets_deploy working tree

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

## Facts supporting the frontier

- Installed `ignition.deploy()` accepts either a parameters object or a path to
  JSON/JSON5 and inherits the selected Hardhat network. Current XLN module
  factories do not yet consume native parameters; this is design, not a working
  replacement command.
- Module IDs are deployment-ID namespaced. Native parameter lookup supports both
  exact module keys and `$global`; implementation must preserve stable identity
  without requiring per-attempt copies of network parameters.
- Native Ignition can coexist with additional top-level metadata in its directory,
  but current XLN `new` preflight rejects an existing native directory. File layout
  and initialization must be reconciled; no behavior change has been made.
- Current manifest, transaction export, execution identity and result files already
  hold much of the proposed summary data. Reuse or consolidate existing outputs;
  do not create another recovery store.
- The current outer orchestrator uses `Bun.spawn` to launch Hardhat; its identity
  helper uses `Bun.spawnSync` for Git. The current Hardhat child already executes
  canonical Hanko and imports verification helpers under Node. Installed Hardhat
  3.20.0 supports local asynchronous tasks, selected network configuration and
  programmatic Ignition. Moving lifecycle ownership to a native task would remove
  the outer Hardhat spawn and require replacing the Git subprocess helper with a
  Node equivalent. Current `deploy-stack.cjs` auto-runs `main()`; expose its existing
  executor once instead of introducing another transaction implementation. These
  are source findings, not execution proof of the proposed standalone module.

## Preserved constraints

- Preserve one canonical compiler and Ignition graph, canonical Hanko and the
  agreed confirmation policy. Existing new/resume identity safeguards stay.
- Preserve the abandoned public attempt's contracts and unrelated work. The owner
  deleted its local receipts and all other prior deployment-task artifacts on
  2026-11-13; do not resume or import it. No public execution, store reset,
  dependency upgrade or browser work is implied by this design.
- Reuse useful current manifests/results/evidence instead of introducing another
  durable transaction scheduler or checkpoint.
- The complete interruption, replacement and reorg matrices remain unproved.
  Prior passing tests do not certify the future extraction.

## Scope reconciliation

The [current specification](spec.md) and tickets 04–07 now describe standalone
completion rather than Stack Manager/catalog admission. New [ticket 08](issues/08-standalone-hardhat-stack-deployment.md)
delivers the first native Hardhat task artifact and depends on completed 03.
Tickets 04, 05 and 06 each depend on 08; 07 depends on those three. Recommended
serial order: 08, 04, 05, 06, 07. Completed 01–03 retain their historical statuses
and counts; the owner deleted their artifacts on 2026-11-13. They do not certify
the current candidate.

The [2026-11-13 scope boundary](spec.md#cli-recovery-boundary-owner-decision-2026-11-13)
keeps 04–07 on the native CLI, shared executor and local recovery evidence.
Further TS/Rust HTTP and UI integration is a [deferred follow-up](../stack-manager-http-integration/issues/01-deferred-http-ui-integration.md)
with requirements still to be defined. It is not a dependency of 04–07.
The already changed Rust request adapter stays intact; [ticket 09](issues/09-minimal-rust-http-adapter-verification.md)
records its narrow verification before including the coupled Rust/worker changes
in a commit. This conditional pre-commit obligation does not block CLI recovery.

The [accepted ADR](../../docs/adr/0001-use-hardhat-ignition-for-recoverable-stack-deployments.md)
records the settled ownership and completion decisions. The glossary records
the domain distinction between Stack Deployment and discovery admission.

## Next

Ticket 08 retains its implementation completion and historical local verification
record: the six-stage focused profile passed and the repository gate failed.
The owner deleted its final delivery artifacts on 2026-11-13. Fresh owning checks
and the applicable verification profile are required before the next deployment
or completion claim. The next serial frontier is 04 (process/session ownership),
then 05 and 06, then 07.
Ticket 09 is separate from this serial frontier; no Rust daemon or HTTP/UI
delivery is required to execute 04–07. Neither follow-up starts merely because
its scope is recorded.
The module supports configurable compatible EVM networks; its historical live
proof was local Anvil. Public Ethereum Sepolia and Arbitrum Sepolia execution with
existing USDC needs the remaining recovery gates and a fresh preflight.
No public signing, commit, push or reset follows from this local completion.

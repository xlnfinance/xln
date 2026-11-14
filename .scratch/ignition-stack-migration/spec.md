# Standalone recoverable Stack Deployment through Hardhat Ignition

Status: ready-for-human
Created: 2026-11-11
Updated: 2026-11-14
Category: enhancement
Documentation alignment base: 2df74f251d3ff3a869738ee1b77787f4be58185b
Deployment source commit: ceb1d0522d20b171ca21803f152ecf3fd5875441
Read-only verifier source commit: cb52df9da1b0e1f0291db08074df122680da4526
Candidate: committed deployment source on the owner-approved testnets_deploy branch; unrelated owner edits remain dirty

## Problem Statement

The operator needs to deploy and verify the existing XLN EVM stack from a command and configuration, independently of Stack Manager, a running Runtime, UI and jurisdiction discovery publication. An interrupted command must continue the same deployment without repeating confirmed actions, and its result must remain understandable without collecting terminal output by hand.

The earlier Stack Manager implementation coupled deployment completion to catalog identity, locks and publication. Ticket 08 extracted deployment into the native Hardhat task using the same executor; recovery implementation is complete through ticket 07. Both selected public deployments have recorded verification results in the [operator guide](../../docs/deployment/ignition-stack-design.md#verified-public-deployments-2026-11-14). The abandoned four-contract Ethereum attempt remains separate; its contracts are untouched, while its local receipts and other deployment-task artifacts were deleted by owner decision on 2026-11-13. Do not resume or import that attempt.

## Solution

Provide a standalone Stack Deployment module in this repository, entered through a native Hardhat task. Hardhat supplies network configuration, environment-backed secrets and JSON deployment parameters. The task owns preflight, Deployment Reconciliation, the existing Ignition/Hanko execution, exact verification and terminal result writing. Bun can launch Hardhat; it does not remain a separate financial orchestrator.

Retain one canonical Ignition executor and its native journal. A successful command means the selected stack has passed exact checks under the agreed 1/12 confirmation policy and its verified result is saved. It does not read or mutate the jurisdiction catalog or require publication. Stack Manager may invoke the same implementation through a thin adapter; its discovery admission is a separate operation.

The implementation supports compatible EVM networks through ordinary Hardhat configuration, without a two-network cap or per-chain deployment formulas. Initial validation targets remain Ethereum Sepolia and Arbitrum Sepolia with the owner-selected existing six-decimal USDC. Adding a network configuration alone does not prove bytecode, gas-limit, token or public-network compatibility.

## User Stories

1. As an operator, I want a native Hardhat task, so that deployment fits the contract tooling already in use.
2. As an operator, I want deployment to run without Stack Manager, server or UI, so that application availability does not control deployment.
3. As an operator, I want network configuration and JSON parameters, so that changing a network does not require another deployment implementation.
4. As an operator, I want one invocation to identify one chain and attempt, so that evidence from different networks cannot mix.
5. As an operator, I want an explicit Fresh Stack Deployment identity, so that a new stack is distinguishable from an earlier attempt.
6. As an operator, I want Deployment Resume to require valid existing evidence, so that a typo cannot silently start another stack.
7. As an operator, I want the actual chain, signer, Foundation and token validated before spending, so that unintended authority or configuration fails early.
8. As an operator, I want source, compiler, artifacts, graph and policy bound to the attempt, so that a resume cannot silently change the candidate.
9. As an operator, I want private RPC providers through environment values, so that authenticated execution endpoints remain usable.
10. As an operator, I want secrets absent from terminal output and artifacts, so that deployment evidence is safe to inspect.
11. As an operator, I want the existing eleven operations in their canonical order, so that dependencies and authority bindings are correct.
12. As the Foundation signer, I want Hanko bound to actual deployed addresses and the original action nonce, so that resume cannot authorize a different listing.
13. As an operator, I want native Ignition recovery for uncertain transactions, so that no second scheduler competes with it.
14. As an operator, I want mined-but-unobserved actions recognized, so that interrupted responses do not cause duplicate creations or listings.
15. As an operator, I want pending, dropped and replaced transaction evidence retained, so that the winning action and its costs remain traceable.
16. As an operator, I want reverts and unexplained nonce changes to stop explicitly, so that a different protocol action is never substituted.
17. As an operator, I want one confirmation between dependent operations, so that execution does not repeat the full final wait at every step.
18. As an operator, I want all winning receipts at depth twelve in the current chain before success, so that stale journal state is insufficient.
19. As an operator, I want exact bytecode, constructors, both bindings and token registration checked, so that transaction count alone cannot certify the stack.
20. As an operator, I want a terminal JSON summary with addresses, transactions, checks, expenses and artifact links, so that the result is usable without scraping stdout.
21. As an operator, I want caught operation failures in that result and a nonzero exit code, so that automation cannot confuse failure with success.
22. As an operator, I want malformed commands or configuration to fail clearly before a valid attempt exists, so that an unavailable result file is not misrepresented as success.
23. As an operator, I want interrupted invocations distinguishable from failed transactions, so that a dead process does not imply that its transaction failed.
24. As an operator, I want completed reruns to re-verify without spending, so that checking an existing stack is idempotent.
25. As an operator, I want concurrent writers and live process owners respected, so that resume cannot race another transaction sequence.
26. As an operator, I want catalog admission separate from deployment completion, so that an application configuration problem cannot redefine on-chain success.
27. As a maintainer, I want callers and tests to cross the same deployment interface, so that fixes have locality and leverage without duplicate implementations.
28. As the owner, I want old public contracts and unrelated work preserved, with the abandoned attempt excluded from resume or import; its local evidence was deleted by my 2026-11-13 decision.

## Implementation Decisions

- The public entry point is a native Hardhat task, backed by one standalone Stack Deployment module. It executes under Hardhat's supported Node/TypeScript environment; Bun remains a launcher and verification runner. Remove the external Bun financial orchestration rather than adding a pass-through module.
- Keep the canonical compiler, EVM target, optimizer, linking, Solidity contracts and Hanko encoding. Expose and reuse the existing executor without transaction-sending side effects on import. This extraction does not authorize dependency or compiler changes.
- Network/RPC configuration comes from standard Hardhat configuration and environment values; deployment parameters come from JSON. Retain explicit deployment identity and new/resume intent. Parameter files remain reusable across attempt IDs despite namespaced Future IDs.
- Reuse shared Hanko and XLN verification primitives without a dependency on Stack Manager's controller, Runtime signer selection, catalog reader or publication machinery. Existing callers receive only the minimal adapter changes needed to use the same implementation; no second financial lifecycle or compatibility sender survives.
- No standalone catalog key, catalog path, publication scope or discovery metadata is required for a deployment. Deployment identity and lock ownership are independent of catalog ownership. Admission consumers retain their own authority and catalog locking rules.
- Initial selected targets are Ethereum Sepolia, chain ID 11155111, and Arbitrum Sepolia, chain ID 421614. Both use the same module definition and separate attempts. Other compatible EVM networks can be configured, but require their own preflight and evidence.
- The owner-selected USDC addresses are 0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238 on Ethereum Sepolia and 0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d on Arbitrum Sepolia. Verify identity and six decimals before spending; symbol alone establishes no issuer provenance. Public current-bytecode/proxy evidence belongs to the later fresh public preflight.
- Seal the resolved chain, signer/Foundation, asset, graph/source/compiler/artifact identity and execution/fee/verification policies before sending. Private RPC transport is not public identity: allow an explicit transport or credential change only after validating the same chain and attempt. Never persist raw secret-bearing URLs or a full resolved configuration containing accounts.
- Keep the canonical eleven-operation existing-token order: eight creations, transformer binding, share-depository binding and first stablecoin registration. Use stable Future IDs with the existing deployment-ID ownership binding.
- Preserve staged composition: a base graph followed by a root graph that includes the same base and listing, under one native identity/journal. Reconstruct canonical Hanko from actual addresses with genesis predecessor nonce zero and action nonce one. A mined first listing is never permission to sign nonce two.
- Ignition alone controls transaction completion, retry and fee replacement. Public native state views construct graph inputs; manifests, summaries, process status and address maps never schedule transactions. Preserve replacement lineage and use standard configured Ignition fee/retry controls.
- Use one native deployment directory with its journal, artifacts and build information. Reuse or consolidate useful current evidence rather than maintain a parallel Stack Manager store. Bind native-directory ownership and immutable inputs before a resumed send; unknown, corrupt or foreign evidence fails closed.
- A Fresh Stack Deployment rejects an existing attempt; Resume rejects missing or incompatible native evidence. Neither mode silently allocates a new identity, resets a journal or imports the abandoned public attempt. The owner deleted prior local source-bound evidence on 2026-11-13; do not reconstruct it through compatibility readers. Retain required evidence for future attempts.
- Retain one confirmation between operations. Success requires every winning receipt at depth at least twelve in the current canonical chain, including both bindings and registration, plus exact current code/authority/token checks. Inclusion counts as confirmation one; this depth is not Ethereum finality or Arbitrum L1 settlement.
- Generate compiler artifacts before sends using the existing canonical pipeline. Preserve the exact artifacts used by the attempt. Derive the deployment manifest and receipt exports from Ignition and chain evidence; their existence before final verification is not success.
- Write the terminal JSON atomically with the existing durability mechanisms. It reports chain/deployment identity, contract/token addresses, transaction references, verification results, actual native expenses and artifact links. It is reporting evidence, not a recovery oracle.
- Preserve per-invocation outcomes. Malformed command/configuration errors return stderr and a nonzero exit code before a valid attempt is established. Caught failures of a valid operation record a failure result and return nonzero. Storage failures remain explicit; SIGKILL may prevent final writing and must be reconciled from native evidence later.
- Completed reruns re-read canonical evidence, preserve the same verified stack and send zero transactions. Invocation diagnostics may differ; immutable financial results must not. Interrupted result writing is reconstructible without repeating confirmed operations.
- Protect attempt ownership and the local signer/chain transaction lane while the operation runs. Do not infer process death from terminal-session loss or recover live ownership using PID absence alone. Verification still obeys capacity-one stand execution.
- Record exact native expenses, including mined failures and replacement outcomes, using the chain's fee semantics. Do not substitute rounded balances, assumed zero costs or a universal gas formula for unverified network-specific fee terms.
- Preserve supported existing fixture/wrapped-token callers through the same executor and minimal adapters, accounting for their extra operations. Do not blindly send their manifests through a single-USDC verifier or claim new variant acceptance. Native TRON and additional public token variants are outside this extraction.

## Testing Decisions

- Test through the native Hardhat task and the same standalone module used in production. The first artifact is a real local-Anvil deployment with eleven successful intended operations, a verified result at depth twelve and no catalog read/write/publication dependency.
- Reuse existing Stack Manager fresh/resume, Hanko, confirmation, evidence, process and local-node scenario prior art. Move their owning interface to the standalone task without replacing financial assertions with mocks, source-name checks or a separate demonstration engine.
- Basic extraction regressions reproduce actual SIGKILL after operations four and eleven have mined before observation, under the same chain/journal. Use nonzero initial EOA nonces and different addresses; preserve identical Hanko/action identity and zero sends on completed resume.
- Test standard network/JSON inputs, reusable parameters, missing or wrong configuration, credential-bearing private RPC, nested diagnostics, early errors, valid-attempt failures and atomic result writing. Use explicit local fixture credentials; never the owner's wallet.
- Assert no successful result at depth eleven, then success only after all required receipts reach twelve and exact code, authority, live bindings and token checks pass. A manifest or native address map alone is insufficient.
- Prove concurrent invocation rejection, live owner/process handling, pending/dropped/replaced/reverted transaction handling, nonce conflicts and corrupt/foreign evidence through the standalone operation. Lost sessions and failed transactions are different outcomes.
- Exercise real local reorganizations during construction and final waiting. Recover the same attempt where demonstrated or fail-stop with precise evidence; never complete from stale cached depth, block hashes or journal success alone.
- Complete all twenty-two named per-operation cuts: after broadcast before receipt observation and after receipt observation for each operation. Include base/Hanko/full-graph transitions, manifest production and terminal-result writing. Resume must not duplicate actions or lose original invocation evidence.
- Measure actual transactions, receipts, native expenses, balance changes and final contract/registry state. Distinguish fixture setup from the eleven deployment operations, additional broadcast hashes from successful operations and local fixtures from issuer-backed public USDC.
- Keep catalog content unchanged throughout standalone scenarios. Thin existing caller checks preserve the one implementation; browser behavior and catalog admission acceptance are separate work.
- Add one `check:deployment` profile for contract/deployment iterations, reusing existing commands and check-runner behavior. Cover canonical compiler/ABI/bytecode/TypeChain consistency, deployment-module/task types and lint including real transitive and CJS consumers, owning Hardhat contract tests and Foundry invariants, and real local-Anvil fresh/resume, Hanko, 1/12 confirmation, input/redaction/result and exact-expense checks. Report the actual suite and invariant coverage; a Hardhat-only test command is insufficient.
- Include the owning lock/process, nonce/replacement, reorg and complete recovery checks in that profile as tickets 04–07 deliver them. Missing required checks must fail visibly; no conditional skips or empty green profile. Reuse the canonical stand lock, run financial scenarios sequentially and preserve process cleanup. Do not create another test framework or financial orchestrator.
- Exclude Svelte/React application checking/builds, browser E2E and unrelated Runtime/consensus/storage/lending/performance gates from this profile. Retain shared generated-contract artifact parity and canonical Hanko dependencies regardless of their directory. Follow the owner-approved [verification scope](../../AGENTS.md#verification-scope): green `check:deployment` is sufficient for qualifying contract/deployment work; broader changes and whole-XLN/mainnet release retain the full repository and owning gates.
- Run the smallest new production artifact first, then its focused recovery/type/artifact checks and the applicable profile once per executable candidate. Record cancelled/unrun gates separately. Unrelated repository failures do not require a global rerun or repairs for this scope; no full core, browser or performance campaign is implied.
- Preserve exact source SHA/dirty status or owned diff, configuration/artifact hashes, commands, counts, receipts, stand-lock ownership and process cleanup. Prior evidence does not certify this extraction. A red repository check is not release readiness.

## CLI recovery boundary (owner decision 2026-11-13)

Tickets 04–07 own the native Hardhat CLI, canonical executor/verifier, locks,
configuration, evidence and local recovery scenarios. Their execution and
acceptance use `check:deployment` and owning checks without starting a Rust
daemon, application HTTP server or wallet UI. Existing adapters remain callers
of the same implementation; their directory or language does not make a second
deployment engine necessary.

Further development of the TS/Rust Stack Manager HTTP layer and wallet UI belongs
to the separate [application integration follow-up](../stack-manager-http-integration/issues/01-deferred-http-ui-integration.md).
It is not an acceptance requirement or dependency of 04–07.

The existing Rust HTTP adjustment to the `{ request, execution }` envelope predates
08 and remains coupled to the private TS worker. Preserve that adjustment and
coherent request forwarding. Its separate
[minimal adapter verification](issues/09-minimal-rust-http-adapter-verification.md)
is complete. That narrow result does not deliver further application integration;
green CLI evidence does not certify the Rust route.

## Out of Scope

- Public Ethereum/Arbitrum deployment transactions in this implementation plan; delivery of a public attempt follows a fresh public preflight after the local implementation gates.
- Importing, resuming, replacing or changing the abandoned public attempt's four contracts. Its local journal, receipts and other deployment evidence were deleted by owner decision on 2026-11-13.
- Stack Manager UI, new HTTP controls, Runtime signer/governance changes, gossip/publication features, automatic catalog writes or wallet network activation.
- Further TS/Rust Stack Manager HTTP development, Rust engine work and HTTP/UI recovery matrices within 04–07. Minimal validation of the already changed Rust request-forwarding adapter is tracked separately; preserving related changes does not authorize dropping one side of the shared envelope.
- Repairing frontend application code, reconciling unrelated frontend/ui installations, general Git-scan/lint cleanup or weakening repository gates to make this slice appear green.
- Deposits, approvals, payments, swaps, withdrawals, reserve roundtrips, Cross-J economics/recovery, liquidity, quotes, bridges or CCTP.
- Mainnet execution, real-funds activation, new custody, token deployments on public targets, additional public network rollout or native TRON deployment/recovery.
- Solidity/Hanko protocol changes, compiler/dependency modernization, Foundry migration, custom Ignition strategies or a generic interchangeable-executor abstraction.
- Automatic reset/wipe, compatibility readers, guessed historical provenance or an extra durable scheduler/checkpoint.

## Further Notes

The [accepted ADR](../../docs/adr/0001-use-hardhat-ignition-for-recoverable-stack-deployments.md), [current design](../../docs/deployment/ignition-stack-design.md), [glossary](../../docs/glossary.md) and [resolved design map](map.md) record the seven owner decisions and scope. The owner's instruction to update this specification and tickets confirms the shared understanding; no additional interview is needed to publish this plan.

Earlier prototype and local implementation records retain their historical
results. Their deleted detailed artifacts do not certify a later candidate.
Use the [owner-approved execution exceptions](../../docs/deployment/ignition-stack-design.md#owner-approved-execution-exceptions)
for this effort. This documentation update starts no financial operation or Git publication.

## Implementation and delivery status (2026-11-14)

The native CLI and recovery implementation are complete through ticket 07.
Both separate public delivery tickets are complete and ready for human review;
the [public specification](../sepolia-arbitrum-deployment/spec.md) records their
execution and verifier identities. The [single handoff](../../docs/night-work-plan.md)
records the latest local adapter tests and deployment-profile results. These
are distinct observations, not a clean whole-product release or public token-flow proof.

## Local test evidence retention (owner decision 2026-11-14)

Follow the [owner-approved retention exception](../../docs/deployment/ignition-stack-design.md#owner-approved-execution-exceptions).
The public native recovery evidence requirements above remain mandatory.

## Existing-stack read-only verification (owner decision 2026-11-14)

The owner selected a separate native `xln-verify` command after all eleven
Arbitrum transactions mined successfully and the original verifier compared
Foundation's L1 execution height to its L2 inclusion height. Correct that
offchain comparison and reuse the canonical exact stack verifier. Do not
redeploy, sign, change the original execution seal or weaken resume admission.

Verification reads the original manifest, source-bound seal, journal and sealed
artifact snapshot. Validate the original source inventory/hashes against its
available committed Git revision, then current canonical receipts, operation
identity, exact runtime/constructors/bindings, Foundation/token state and the
original minimum twelve-confirmation policy. Registration on Arbitrum One
(`42161`) and Sepolia (`421614`) uses matching receipt/header L1 context;
canonical inclusion and depth remain in L2 units. Other Nitro chain IDs are
not covered by this correction.

No key, compile or deployment-engine invocation is allowed. The RPC provider
permits only required read methods. Write only a new optional report outside
the original directory and preserve all original bytes and invocation outcomes.
Report `status: verified`, original execution candidate, current verifier
revision/source hashes, canonical point, checks, historical expenses and zero
current signatures/broadcasts. The original failed result stays failed.

The boundary was verified through real Anvil execution from a committed source
export, key-free reads, unchanged transaction counts/original files and rejection
of altered/foreign evidence and output aliases. Owning checks and the deployment
profile passed; both public stacks have separate read-only reports. The
[operator guide](../../docs/deployment/ignition-stack-design.md#verified-public-deployments-2026-11-14)
records source identities and observation points. Public token flows remain separate.

# 07: Complete standalone recovery matrix and implementation handoff

Type: implementation
Completed: yes
Status: ready-for-human
Category: enhancement
Blocked by: 04, 05, 06
Created: 2026-11-12
Updated: 2026-11-13

## What to build

The owner receives one auditable standalone deployment candidate with the complete local interruption matrix, integrated failure scenarios and a concrete handoff for later public preflight. Evidence clearly separates working scoped behavior, repository health and public-network delivery.

## Acceptance criteria

- [x] Through the native Hardhat task, cover after-broadcast/before-receipt-observation and after-receipt-observation interruption for each of eleven operations: twenty-two named cuts, actual process termination and the same retained local chain/journal.
- [x] Every successful case resumes to exactly eleven intended operations, one stablecoin listing at tokenId one and Foundation nonce one. No confirmed creation, binding or registration is duplicated.
- [x] Integrate base/Hanko/full-graph, manifest and terminal-result writing cuts. Completed reruns re-verify with zero sends and return the same verified financial result; reconstruct missing derived output without treating a summary as recovery authority.
- [x] Run the process/ownership, RPC/nonce/evidence and reorg scenarios from 04–06 on this same candidate. Preserve first-failure evidence and exact reruns; neither the throwaway prototype nor old Stack Manager placement certifies it.
- [x] Include nonzero initial sender nonce and differing addresses. Preserve supported owning fixture/wrapped-token variants on the same executor, with explicit extra-operation accounting and no claim that a single-token verifier covers every variant.
- [x] Record transaction/receipt identities, replacement lineage, exact native expenses and balance changes, contract/authority/registry state, verification conclusions, terminal JSON and linked artifacts. Preserve original invocation outcomes and abandoned public evidence.
- [x] Standalone runs neither depend on nor modify catalog content. Keep any required existing caller dispatch checks narrow; do not turn catalog publication, server/UI delivery or Runtime activation into acceptance for this slice.
- [x] Green `check:deployment` includes the owning deployment type/artifact/lint gates and integrated recovery scenarios from 04–07. Apply the [verification scope](../../../AGENTS.md#verification-scope): the full repository check is required for broader changes or whole-XLN/mainnet release. Preserve known unrelated failures and distinguish cancellations/unrun gates without repairing other product areas or weakening checks for this slice.
- [x] With Solidity unchanged, compiler/ABI/runtime hashes remain unchanged. One runnable financial implementation remains; retired Bun orchestration is removed and actual CJS consumers are represented accurately.
- [x] Publish durable evidence naming source SHA, dirty status or owned diff, resolved nonsecret configuration/artifact hashes, exact commands, counts, native-directory paths, locks/process cleanup and remaining limitations. No clean committed SHA is claimed when unavailable; no commit/push is authorized.
- [x] Initial configuration proof covers Ethereum Sepolia and Arbitrum Sepolia with separate IDs and selected existing-USDC parameters, while the module remains extensible to compatible EVM networks. Local simulations do not establish public-chain execution or Circle-proxy/current-bytecode evidence.
- [x] Provide the next single executable public-preflight command and prerequisites without sending a transaction. Public Ethereum/Arbitrum deployment, faucet requests, token approvals, discovery admission and release activation remain separate delivery tasks.
- [x] The complete matrix proves native CLI/executor recovery. Further TS/Rust HTTP/UI integration remains a separate follow-up; existing coupled adapter changes are preserved, and any included Rust change has its own verification evidence before commit.

## Scope and verification

Run owning scenarios serially under the stand lock with measured budgets and exact process cleanup. Start with the first failing production artifact. Do not turn closeout into a broad core/browser/architecture/auditor campaign or import old attempts to simplify the matrix.

Apply the [CLI recovery boundary](../spec.md#cli-recovery-boundary-owner-decision-2026-11-13).
Ticket 09 is not a blocker of this matrix. Its narrow evidence is required
separately before committing the coupled Rust/worker changes; this ticket does
not authorize a commit or require the deferred HTTP/UI feature to be delivered.

## References

- [Standalone deployment specification](../spec.md)
- [08: Standalone Hardhat task](08-standalone-hardhat-stack-deployment.md)
- [04: Process and lock recovery](04-process-and-lock-recovery.md)
- [05: RPC, nonce and evidence conflicts](05-rpc-nonce-and-evidence-conflicts.md)
- [06: Canonical-chain completion](06-reorg-and-confirmation-admission.md)

## Comments

2026-11-12: Updated for the native Hardhat task and independent verified result. Immediate blockers remain 04–06; each now depends on 08. Catalog-completion cuts are replaced with terminal-result completion cuts for standalone acceptance.

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

The recorded matrix covers 22 before/after receipt-observation cuts, eight
Inspector writing cuts, archive-status validation and process-startup cleanup.
Integrated 04–06 scenarios cover ownership, nonce/RPC/replacements and reorg/depth
behavior. The tests use eleven intended operations, exact native accounting and
zero-send completed reruns. Later read-only public observations are documented
in the [deployment guide](../../../docs/deployment/ignition-stack-design.md#public-preflight-refresh).

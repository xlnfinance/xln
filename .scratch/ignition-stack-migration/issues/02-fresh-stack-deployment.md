# 02: Fresh Stack Deployment through Ignition

Type: implementation
Completed: yes
Status: ready-for-human
Category: enhancement
Blocked by: None
Created: 2026-11-12

## What to build

An operator starts a Fresh Stack Deployment through the existing CLI or server interface and receives one complete, verified jurisdiction stack admitted to the operator-local catalog. Ignition executes the existing eleven-operation path; the direct one-shot transaction sender is retired atomically. This is the first production artifact of the migration.

## Acceptance criteria

- [x] CLI and owning server/worker callers accept explicit deployment identity and operation intent through the same Stack Manager seam. The deployment identity is distinct from the catalog key; an existing identity is rejected before a fresh send.
- [x] Before spending, validate actual chain, signer/Foundation, stablecoin metadata, catalog availability and existing locks; bind source/compiler/artifact/configuration and policy identity to the attempt. Private keys and credential-bearing RPC URLs never appear in durable output or arguments.
- [x] The existing-token path executes eight creations, two bindings and one canonical Foundation listing in the specified total order using stable Future IDs. Both composition stages share one native Ignition identity/journal.
- [x] Hanko uses actual deployed addresses and the canonical encoder with first action nonce one. Validate the action hash against the contract and preserve USDC address, six decimals and tokenId one.
- [x] Wait for one confirmation between operations and require twelve for every winning receipt before actual catalog admission. No catalog entry appears at depth eleven of the last receipt.
- [x] Derive the final manifest from native Ignition evidence and verify all eight exact linked runtime bytecodes, constructor/authority values, both binding receipts and live bindings, canonical registration and metadata.
- [x] A real local-Anvil scenario through the production seam completes with exactly eleven successful intended operations and Foundation nonce one. CLI and server routing checks establish that both enter this implementation without adding UI work.
- [x] Inventory existing owning callers and supported fixture-token variants; migrate them through this same engine with explicitly accounted extra operations. No retired direct sender or hidden fallback remains runnable.
- [x] Preserve compiler/artifact identity, existing publication authority, unrelated catalog entries and the abandoned public attempt. Record commands, source hashes, receipts, native gas costs and owning-check results; this slice is not public-deployment or release acceptance.

## Scope and verification

Use the approved local-node workflow and canonical stand lock. Prior art is the existing Stack Manager orchestration/confirmation scenarios and resolved staged-Hanko prototype. No Solidity change, dependency upgrade, UI repair, public transaction or old-attempt import is authorized by this ticket. Subsequent tickets establish production recovery completeness.

## References

- [Migration spec](../spec.md)
- [Resolved composition prototype](01-staged-hanko-prototype.md)

## Comments

2026-11-12: Owner approved this six-ticket breakdown. This ticket has no open implementation blocker and is the first executable slice.

2026-11-12: Functional acceptance completed on real local Anvil. Historical
result: the owner deleted its local artifacts on 2026-11-13. The completed
status and counts below remain historical; fresh owning checks are required
before the next deployment or completion claim.
Final scoped patch SHA256:
`9d2ce35da626dd12e369b5536b7cdba1d35c69680dbb6a1e82ec38d66e94ada0`.
HEAD/main remains `019d45beb5954e77fe806d643845f6a4dca4fa82`, dirty
`testnets_deploy`; owner-authorized MacBook execution, no commit or public
transaction. Final focused group: 27/27, 195 assertions; post-check fresh
scenario: 1/1, 39 assertions, 11 operations, Foundation nonce 1, depth-12
admission. All four variants executed (11/12/12/13 operations); three financial
proof variants passed (3/3, 74 assertions). Two review findings fixed with
observed RED/GREEN; bounded follow-up reviews found no material regression.
Known credential URL forms are rejected before spending, including direct
typed calls. Operators must supply an unauthenticated endpoint; arbitrary
opaque custom paths cannot prove credential absence automatically.
`bun run check` was executed and remains red on the pre-existing
`frontend/src/lib/view/DockRoot.svelte:474` error; cancelled gates and cleanup
diagnostics were recorded in the deleted artifacts. Final runtime type gate passed separately.
Completion records this implementation slice, not release or public-deployment
acceptance. Resume and idempotent completion remain ticket 03; it was not started.

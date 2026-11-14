# Public Sepolia contract delivery through the native CLI

Status: ready-for-human
Created: 2026-11-11
Updated: 2026-11-14
Planning baseline: fa6e1528c6bc6acfcd6d111a7d5851968d1ca18a

## Outcome and boundaries

Deploy and verify one current XLN stack on Ethereum Sepolia and one on Arbitrum
Sepolia, registering the owner-selected existing USDC on each. Both deliveries
use the same immutable source/compiler/artifact candidate and verification policy.
Network-specific parameters, nonces, addresses and linked runtime bytes are
recorded and verified independently.

Use the native Hardhat `xln-deploy` task and its single Ignition executor,
following the [operator design](../../docs/deployment/ignition-stack-design.md).
Verified native completion produces the manifest, native journal/artifacts and
terminal `result.json`. Stack Manager, catalog admission, publication and UI
activation are separate consumers and are not deployment prerequisites.

The [one-USDC reserve roundtrip](../sepolia-arbitrum-usdc-roundtrip/spec.md) and
the [later Cross-J rehearsal](../../docs/research/sepolia-arbitrum-cross-j.md)
remain separate outcomes. No token approval, deposit, withdrawal, quote or
liquidity operation is part of these deployment tickets.

## Execution prerequisites

- Complete the native migration's [07 recovery handoff](../ignition-stack-migration/issues/07-complete-recovery-matrix-and-handoff.md), including its owning process, RPC/nonce and reorg checks from 04-06, before public broadcast. Read-only preparation may proceed independently.
- Pin one committed executable candidate and record source/configuration/artifact hashes and actual dirty status. Preserve unrelated work; do not combine receipts from different candidates.
- Pass `bun run check:deployment` and owning checks under the current [verification scope](../../AGENTS.md#verification-scope). Unchanged shared candidate checks may be reused across the two network deliveries. Fresh network-specific preflight is always required.
- Follow current AGENTS.md and the [owner-approved execution exceptions](../../docs/deployment/ignition-stack-design.md#owner-approved-execution-exceptions) for this effort. Run stand-owning work sequentially with the canonical lock.

## Selected configuration

| Hardhat network    | Chain ID | Owner-selected existing USDC                 | RPC environment   |
| ------------------ | -------: | -------------------------------------------- | ----------------- |
| `ethereum-sepolia` | 11155111 | `0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238` | `ETH_SEPOLIA_RPC` |
| `arbitrum-sepolia` |   421614 | `0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d` | `ARB_SEPOLIA_RPC` |

The signer comes from the established `DEPLOYER_PRIVATE_KEY` secret channel.
The genesis Foundation recipient must match the signer authorized for the first
listing. Never put secrets in JSON parameters, argv, logs or result artifacts.
Private execution RPC credentials must remain transient and unpublished.

Verify current chain identity, RPC/EVM/receipt support, token/proxy code and
provenance, six decimals, signer authority, nonce, gas estimates and native ETH
funding before spending. A symbol or old preflight is insufficient. Register the
existing asset with its actual metadata; do not deploy a replacement ERC20 or
introduce a USDT alias. USDC funding for a deposit belongs to the roundtrip task.

## Delivery tickets and acceptance

- [03: Ethereum Sepolia](issues/03-ethereum-sepolia-delivery.md) and [04: Arbitrum Sepolia](issues/04-arbitrum-sepolia-delivery.md) are both required. Neither depends on the other finishing first; execution is sequential under the stand lock.
- Use separate fresh deployment IDs/directories and the existing eleven-operation graph: eight creations, two bindings and first stablecoin listing. Preserve canonical Hanko and Foundation action nonce one.
- Retain the agreed one confirmation between operations and at least twelve for every winning receipt before success. Inclusion counts as one; this is not Ethereum finality or Arbitrum L1 settlement.
- Verify current linked runtime bytes/immutables, constructor and authority bindings, both live bindings, canonical token registration/metadata and successful canonical receipts. A returned address, local simulation or journal success alone is insufficient.
- Preserve native recovery files, original invocation outcomes, source/artifact identity, receipts and actual native expenses for each public attempt. The terminal JSON reports the outcome; it is not a recovery oracle.
- After interruption or failure, inspect the same attempt and chain state and use explicit compatible resume intent. Do not hide a partial failure by allocating another fresh ID or inventing a receipt/nonce outcome.
- Owner decision 2026-11-14: if execution is complete and only the offchain verifier needs correction, an independent native `xln-verify` report may establish current stack verification. Preserve the original failed invocation, source seal, journal and artifacts byte-for-byte; report original execution and current verification candidates separately. This does not authorize an incompatible resume or another transaction.

The full repository check remains required for broader changes and whole-XLN or
mainnet release. An unrelated Svelte/UI failure is not a gate for this scoped
contract delivery. No browser check is introduced by this browserless scope.

## Current state and exclusions

Both fresh public executions used committed candidate
`49c26224497d5e875c369098f02d515e0fb81134`, with eleven successful transactions
per chain. Ethereum's original invocation and zero-send completed resume passed.
Arbitrum's original invocation failed during verification because it compared
Foundation's L1 execution height to an L2 receipt height. Its original failed
outcome is retained. The owner selected the corrected read-only verification
path above. Both final read-only reports record `verified` at their observed
canonical points, with zero signatures/broadcasts for those verification runs
and unchanged original files. They are historical observations, not a live
refresh of the current HEAD or chain state. Delivery tickets 03 and 04
are complete and ready for human review; each records exact addresses, canonical
points, fees, balance accounting and the final scoped check results. The later
verifier correction is committed at `cb52df9da1b0e1f0291db08074df122680da4526`;
its source content matches the checked candidate and does not change deployed bytecode.

The older abandoned Ethereum attempt remains on-chain and is not imported or
resumed. Its deleted evidence is unrelated to these retained fresh attempts.
This specification authorizes no commit/push. UI, catalog publication/retirement, reserve
roundtrips, Cross-J economics, Hub/MM funding, new tokens/bridges, dependency or
compiler upgrades, TRON and mainnet activation remain outside this scope.

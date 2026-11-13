# 04: Deploy and verify the XLN stack on Arbitrum Sepolia

Type: implementation
Completed: no
Status: ready-for-agent
Blocked by: None
Updated: 2026-11-13
Parent: [Public deployment specification](../spec.md)

## What to deliver

A verified current Arbitrum Sepolia XLN stack with the owner-selected existing
USDC registered. Use the native Hardhat task, preserving its native recovery
directory, verified manifest, terminal result and actual deployment costs.

## Prerequisites and authority

There is no local ticket blocker. Public broadcast requires the completed
[native recovery handoff](../../ignition-stack-migration/issues/07-complete-recovery-matrix-and-handoff.md),
passing `check:deployment` plus owning checks for the pinned candidate, and a
fresh Arbitrum-specific public preflight. The candidate must be the same source,
compiler, artifacts and verification policy used by
[Ethereum delivery](03-ethereum-sepolia-delivery.md). Neither network ticket needs
the other to finish first; run them sequentially under the stand lock.

Follow the current [verification scope](../../../AGENTS.md#verification-scope)
and existing execution/branch authority. Preparation does not dispatch signing
or a public transaction. The separate roundtrip and UI work are not blockers.

## Acceptance criteria

- [ ] Verify Arbitrum Sepolia chain ID `421614` and selected USDC `0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d`, including current token/proxy code, provenance, six decimals and bounded registry compatibility.
- [ ] Refresh Nitro/RPC/EVM/receipt compatibility, signer/genesis Foundation authority, pending nonce, gas estimates, fee policy and native ETH funding before spending. Report unsupported compiler/RPC behavior without a hidden downgrade or fallback.
- [ ] Record the immutable candidate and passing scoped checks. Reuse unchanged shared-candidate local checks from Ethereum where applicable, but always refresh this network's preflight. Broader changes or global release retain the full repository gates.
- [ ] From `jurisdictions/`, use `bunx hardhat xln-deploy --network arbitrum-sepolia --parameters ignition/parameters/arbitrum-sepolia.json` with an explicit unused deployment ID and `--mode new`, following the [operator guide](../../../docs/deployment/ignition-stack-design.md). Keep secrets in the existing environment channel.
- [ ] Complete and verify eight creations, two bindings and the first USDC listing. Check linked runtime bytes/immutables, constructors, authority, registry token identity, Foundation nonce one and every successful canonical receipt.
- [ ] Preserve one confirmation between operations and require at least twelve for every winning receipt before successful completion. Do not equate twelve Arbitrum blocks with Ethereum L1 settlement or finality.
- [ ] Retain the native journal, artifacts/build information and invocation outcomes, plus verified manifest, `result.json`, transaction references and actual native expenses with applicable Arbitrum fee components accounted exactly once. Report partial/unavailable evidence honestly; resume only the same compatible attempt.
- [ ] Use the same source/compiler/artifact candidate as Ethereum delivery. Record chain-specific parameters and expected linking separately; revalidate affected checks after a shared candidate change.

## Completion and exclusions

Completion is a verified native result, with no Stack Manager, catalog key,
`XLN_JURISDICTIONS_PATH`, discovery publication or wallet activation requirement.
The [reserve roundtrip](../../sepolia-arbitrum-usdc-roundtrip/spec.md), USDC
funding/approval/deposit/withdrawal and Cross-J are separate tasks.

Public acceptance remains unverified. Prior local preflight/gas artifacts were
deleted on 2026-11-13 and are not current proof. Fresh receipts must identify the
actual new candidate. Testnet completion does not authorize mainnet or global
release.

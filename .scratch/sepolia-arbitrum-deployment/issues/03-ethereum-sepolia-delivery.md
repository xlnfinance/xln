# 03: Deploy and verify the XLN stack on Ethereum Sepolia

Type: implementation
Completed: no
Status: ready-for-agent
Blocked by: None
Updated: 2026-11-13
Parent: [Public deployment specification](../spec.md)

## What to deliver

A verified current Ethereum Sepolia XLN stack with the owner-selected existing
USDC registered. Use the native Hardhat task, preserving its native recovery
directory, verified manifest, terminal result and actual deployment costs.

## Prerequisites and authority

There is no local ticket blocker. Public broadcast requires the completed
[native recovery handoff](../../ignition-stack-migration/issues/07-complete-recovery-matrix-and-handoff.md),
passing `check:deployment` plus owning checks for the pinned candidate, and a
fresh Ethereum-specific public preflight. The candidate must be the same source,
compiler, artifacts and verification policy used by
[Arbitrum delivery](04-arbitrum-sepolia-delivery.md). Neither network ticket needs
the other to finish first; run them sequentially under the stand lock.

Follow the current [verification scope](../../../AGENTS.md#verification-scope)
and existing execution/branch authority. Preparation does not dispatch signing
or a public transaction. The separate roundtrip and UI work are not blockers.

## Acceptance criteria

- [ ] Verify Ethereum Sepolia chain ID `11155111` and selected USDC `0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238`, including current token/proxy code, provenance, six decimals and bounded registry compatibility.
- [ ] Refresh RPC/EVM/receipt compatibility, signer/genesis Foundation authority, pending nonce, gas estimates, fee policy and native ETH funding before spending. Do not reuse historical nonce/address predictions or silently weaken compiler/validation policy.
- [ ] Record the immutable candidate and passing scoped checks. Broader changes or global release retain the full repository gates; Svelte/browser checks are not contract-delivery prerequisites.
- [ ] From `jurisdictions/`, use `bunx hardhat xln-deploy --network ethereum-sepolia --parameters ignition/parameters/ethereum-sepolia.json` with an explicit unused deployment ID and `--mode new`, following the [operator guide](../../../docs/deployment/ignition-stack-design.md). Keep secrets in the existing environment channel.
- [ ] Complete and verify eight creations, two bindings and the first USDC listing. Check linked runtime bytes/immutables, constructors, authority, registry token identity, Foundation nonce one and every successful canonical receipt.
- [ ] Preserve one confirmation between operations and require at least twelve for every winning receipt before successful completion. Twelve confirmations are not protocol finality.
- [ ] Retain the native journal, artifacts/build information and invocation outcomes, plus verified manifest, `result.json`, transaction references and exact native expenses. Report partial/unavailable evidence honestly. Resume only the same compatible attempt; do not blindly redeploy.
- [ ] Use the same source/compiler/artifact candidate as Arbitrum delivery. Record chain-specific parameters and expected linking separately; revalidate affected checks after a shared candidate change.

## Completion and exclusions

Completion is a verified native result, with no Stack Manager, catalog key,
`XLN_JURISDICTIONS_PATH`, discovery publication or wallet activation requirement.
The [reserve roundtrip](../../sepolia-arbitrum-usdc-roundtrip/spec.md), USDC
funding/approval/deposit/withdrawal and Cross-J are separate tasks.

Public acceptance remains unverified. Prior local preflight/attempt artifacts
were deleted on 2026-11-13; the abandoned contracts remain untouched on-chain.
Do not import or resume that attempt. Fresh receipts must identify the actual
new candidate. Testnet completion does not authorize mainnet or global release.

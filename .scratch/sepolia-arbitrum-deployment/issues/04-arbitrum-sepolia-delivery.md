# 04: Deploy and verify the XLN stack on Arbitrum Sepolia

Type: implementation
Completed: yes
Status: ready-for-human
Blocked by: None
Updated: 2026-11-14
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

- [x] Verify Arbitrum Sepolia chain ID `421614` and selected USDC `0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d`, including current token/proxy code, provenance, six decimals and bounded registry compatibility.
- [x] Refresh Nitro/RPC/EVM/receipt compatibility, signer/genesis Foundation authority, pending nonce, gas estimates, fee policy and native ETH funding before spending. Report unsupported compiler/RPC behavior without a hidden downgrade or fallback.
- [x] Record the immutable candidate and passing scoped checks. Reuse unchanged shared-candidate local checks from Ethereum where applicable, but always refresh this network's preflight. Broader changes or global release retain the full repository gates.
- [x] From `jurisdictions/`, use `bunx hardhat xln-deploy --network arbitrum-sepolia --parameters ignition/parameters/arbitrum-sepolia.json` with an explicit unused deployment ID and `--mode new`, following the [operator guide](../../../docs/deployment/ignition-stack-design.md). Keep secrets in the existing environment channel.
- [x] Complete and verify eight creations, two bindings and the first USDC listing. Check linked runtime bytes/immutables, constructors, authority, registry token identity, Foundation nonce one and every successful canonical receipt.
- [x] Preserve one confirmation between operations and require at least twelve for every winning receipt before successful completion. Do not equate twelve Arbitrum blocks with Ethereum L1 settlement or finality.
- [x] Retain the native journal, artifacts/build information and invocation outcomes, plus verified manifest, `result.json`, transaction references and actual native expenses with applicable Arbitrum fee components accounted exactly once. Report partial/unavailable evidence honestly; resume only the same compatible attempt.
- [x] Use the same source/compiler/artifact candidate as Ethereum delivery. Record chain-specific parameters and expected linking separately; revalidate affected checks after a shared candidate change.

## Completion and exclusions

Completion is a verified native result or the owner-approved independent
read-only verification report below, with no Stack Manager, catalog key,
`XLN_JURISDICTIONS_PATH`, discovery publication or wallet activation requirement.
The [reserve roundtrip](../../sepolia-arbitrum-usdc-roundtrip/spec.md), USDC
funding/approval/deposit/withdrawal and Cross-J are separate tasks.

Public delivery verified on 2026-11-14 (2026-11-13 UTC) through the
owner-selected independent read-only verification path. Testnet completion does
not authorize mainnet or whole-product release.

## Recorded delivery

- Execution candidate: `49c26224497d5e875c369098f02d515e0fb81134`; same compiler/artifacts as Ethereum. Eleven successful canonical receipts, nonces 16–26, no reverts, under `jurisdictions/ignition/deployments/arb-sepolia-ignition-01/`.
- The original invocation exited nonzero during verification with `STACK_MANAGER_FOUNDATION_AUTHORITY_MISMATCH`. Foundation's correct L1 registration height `12128839` was compared to the creation's L2 height `328950104`. The original `failed/verifying` result, execution seal, journal and artifacts are preserved. No redeployment or incompatible resume was attempted.
- Owner decision 2026-11-14: accept current verification through `xln-verify` after correcting that offchain L1/L2 comparison. Original execution and verification-time candidates remain distinct; the report records both source identities. The unchanged verifier source content is now committed at `cb52df9da1b0e1f0291db08074df122680da4526`; the retained report is not rewritten.
- Final report: `jurisdictions/ignition/deployments/arb-sepolia-ignition-01.readonly-final.json`, status `verified`, L2 block `328957948`, hash `0x32336754a2bbccefa2cf5ef81b979d338002a9805a02288eddb352387f25aaa6`; minimum receipt depth 7,771. Exact code, constructors, bindings, authority, token and source/artifact/journal identity passed. No signatures or broadcasts; all 91 original files remained byte-identical.
- Depository: `0x8223AA4c60Adb851f53a120c3D3841De9e77c188`; EntityProvider: `0x3DaE23be54dAb4e88b92D4e4c3db42f7D9ce0Df9`. Selected six-decimal USDC is tokenId one; Foundation action nonce is one.
- Actual fees: `401706116534000` wei, gas `20059820`. Native balance changed from `528978761031379600` to `528577054914845600` wei; unexplained difference `0` wei. All eleven raw receipts exposed `gasUsedForL1 = 0`; the poster component is already included in total gas and is not added twice.
- Final verifier candidate passed `bun run check:deployment`: 6/6 gates, 274 Hardhat, 64 Foundry, 110 Bun tests / 3,582 assertions; 561 source hashes stable and all 181 compiler/ABI/TypeChain artifacts unchanged. Focused regression: 17 tests / 71 assertions. No global/browser/financial-flow acceptance is claimed.

# 03: Deploy and verify the XLN stack on Ethereum Sepolia

Type: implementation
Completed: yes
Status: ready-for-human
Blocked by: None
Updated: 2026-11-14
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

- [x] Verify Ethereum Sepolia chain ID `11155111` and selected USDC `0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238`, including current token/proxy code, provenance, six decimals and bounded registry compatibility.
- [x] Refresh RPC/EVM/receipt compatibility, signer/genesis Foundation authority, pending nonce, gas estimates, fee policy and native ETH funding before spending. Do not reuse historical nonce/address predictions or silently weaken compiler/validation policy.
- [x] Record the immutable candidate and passing scoped checks. Broader changes or global release retain the full repository gates; Svelte/browser checks are not contract-delivery prerequisites.
- [x] From `jurisdictions/`, use `bunx hardhat xln-deploy --network ethereum-sepolia --parameters ignition/parameters/ethereum-sepolia.json` with an explicit unused deployment ID and `--mode new`, following the [operator guide](../../../docs/deployment/ignition-stack-design.md). Keep secrets in the existing environment channel.
- [x] Complete and verify eight creations, two bindings and the first USDC listing. Check linked runtime bytes/immutables, constructors, authority, registry token identity, Foundation nonce one and every successful canonical receipt.
- [x] Preserve one confirmation between operations and require at least twelve for every winning receipt before successful completion. Twelve confirmations are not protocol finality.
- [x] Retain the native journal, artifacts/build information and invocation outcomes, plus verified manifest, `result.json`, transaction references and exact native expenses. Report partial/unavailable evidence honestly. Resume only the same compatible attempt; do not blindly redeploy.
- [x] Use the same source/compiler/artifact candidate as Arbitrum delivery. Record chain-specific parameters and expected linking separately; revalidate affected checks after a shared candidate change.

## Completion and exclusions

Completion is a verified native result, with no Stack Manager, catalog key,
`XLN_JURISDICTIONS_PATH`, discovery publication or wallet activation requirement.
The [reserve roundtrip](../../sepolia-arbitrum-usdc-roundtrip/spec.md), USDC
funding/approval/deposit/withdrawal and Cross-J are separate tasks.

Public delivery verified on 2026-11-14 (2026-11-13 UTC). The older abandoned
attempt is not imported or resumed. Testnet completion does not authorize
mainnet or whole-product release.

## Recorded delivery

- Execution candidate: `49c26224497d5e875c369098f02d515e0fb81134`; same compiler/artifacts as Arbitrum. Final verification recorded a separate dirty candidate; its unchanged source content is now committed at `cb52df9da1b0e1f0291db08074df122680da4526`. The report retains the original verification-time SHA and source hashes.
- Native directory: `jurisdictions/ignition/deployments/eth-sepolia-ignition-01/`. Initial invocation and completed resume both exited zero; resume sent zero transactions. Eleven successful canonical receipts, nonces 92–102, no reverts.
- Depository: `0x32A4A72992aD142E36fA1C5989b95FeD60987818`; EntityProvider: `0x9C4173eed1DC7c24c5207A705382488c859588E3`. Selected six-decimal USDC is tokenId one; Foundation action nonce is one.
- Final `xln-verify` report: `jurisdictions/ignition/deployments/eth-sepolia-ignition-01.readonly-final.json`, status `verified`, block `12129021`, hash `0xbd2db065ec79625fcf0311ddb64f5258e6aceb8e27c01009e41d459a976de31f`; minimum receipt depth 206. Exact code, constructors, both bindings, authority, token and original source/artifact/journal identity passed. No signatures or broadcasts; all 91 original files remained byte-identical.
- Actual fees: `2374739656` wei, gas `139690568`. Native balance changed from `41202999652683374408` to `41202999650308634752` wei; unexplained difference `0` wei.
- Final verifier candidate passed `bun run check:deployment`: 6/6 gates, 274 Hardhat, 64 Foundry, 110 Bun tests / 3,582 assertions; 561 source hashes stable and all 181 compiler/ABI/TypeChain artifacts unchanged. Focused regression: 17 tests / 71 assertions. No global/browser/financial-flow acceptance is claimed.

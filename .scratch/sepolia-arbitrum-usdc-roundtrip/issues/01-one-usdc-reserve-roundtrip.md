# 01: Prove an exact one-USDC reserve roundtrip on both public testnets

Type: implementation
Completed: no
Status: ready-for-agent
Blocked by: None
Parent: [Roundtrip specification](../spec.md)

**What to build:** one parameterized, browserless probe verifies a known contract stack and token binding, deposits exactly one USDC into an XLN reserve, withdraws that exact amount back to the external signer, and reports receipts and exact token/reserve/native-gas accounting. Demonstrate it on an existing real-node fixture, then on Ethereum Sepolia and Arbitrum Sepolia independently using the separately verified deployments.

## Acceptance criteria

- [ ] Accept explicit expected jurisdiction/chain and token-binding inputs through an appropriate existing execution surface. Derive the actual asset binding from canonical registry/configuration data rather than assuming a USDT-labelled entry. Keep signing secrets out of arguments, logs and evidence.
- [ ] Use existing production signing/batch encoding, RPC adapter and token/reserve operations. Do not duplicate financial formulas, create a test-only payment path or depend on a UI balance.
- [ ] Before approving or transferring tokens, verify the expected chain, current stack bytecode/bindings, expected token address and six-decimal dimensions, signer funding and a clean, debt-free reserve identity. Invalid inputs fail with useful evidence before spending.
- [ ] Use normal ERC20 approval as needed, then deposit exactly `1_000_000` atomic token units from the external wallet into its XLN reserve. An ERC20 mint, debug reserve funding or local impersonation is not deposit evidence.
- [ ] After the confirmed deposit, the external token balance is exactly its initial balance minus `1_000_000`, and the reserve is exactly its initial balance plus `1_000_000`.
- [ ] Withdraw exactly `1_000_000` units back to the same external wallet through the normal signed reserve-to-external operation. The confirmed withdrawal restores both the external token balance and the tested reserve to their initial values.
- [ ] Read raw balances at identified chain heights and preserve successful deposit/withdrawal receipts at the configured confirmation depth. Submitted transactions, subprocess exit codes and optimistic displays do not establish completion.
- [ ] Record native ETH balances and actual transaction costs separately from USDC, including the fee components relevant to the target network. Do not silently apply an incomplete Ethereum-only fee assumption to Arbitrum.
- [ ] An operation failure reports the exact phase, known transaction identifiers and available balances without claiming a successful roundtrip or automatically repeating a financial operation.
- [ ] Demonstrate the entire probe on an existing real-node fixture and run meaningful owning regressions. The broad settlement/dispute public proof keeps its independent responsibilities; it is not weakened or relabelled as this narrow probe.
- [ ] Execute the same probe on Ethereum Sepolia (`11155111`) using USDC `0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238` and a verified current XLN deployment. Preserve public approval/deposit/withdrawal receipts, exact intermediate/final balances and separate native costs. A local fixture does not satisfy this criterion.
- [ ] Execute the same probe on Arbitrum Sepolia (`421614`) using USDC `0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d` and a verified current XLN deployment. Preserve public approval/deposit/withdrawal receipts, exact intermediate/final balances and applicable native fee components. Ethereum-only results do not satisfy this criterion.

## Boundaries

This is the owner-approved Q6 reserve ingress/egress check, extracted from deployment ticket 02 on 2026-11-11. It is separate from the current deployment-only effort and is not started by that effort. It does not open UI, Hub/MM operation, Cross-J orders, collateral fee policy or cross-network recovery.

`Blocked by: None` applies to probe implementation against an existing real-node fixture. The public runs require verified manifests and token bindings from the separate [Ethereum deployment](../../sepolia-arbitrum-deployment/issues/03-ethereum-sepolia-delivery.md) and [Arbitrum deployment](../../sepolia-arbitrum-deployment/issues/04-arbitrum-sepolia-delivery.md), plus a funded external signer and a clean reserve. Those deployment tickets do not require this task. This task owns both public financial runs; they are no longer acceptance criteria of deployment tickets 03/04.

## Verification evidence

Not run. Record the implementation SHA, exact invocations, fixture and both public contract/token bindings, deposit/withdrawal receipts, identified balance snapshots, complete raw-unit conservation checks, separate native-gas costs and required repository checks before setting `Completed: yes`. Follow the owner's MacBook Pro M5 instruction and the stand-lock policy. This planning record does not start execution.

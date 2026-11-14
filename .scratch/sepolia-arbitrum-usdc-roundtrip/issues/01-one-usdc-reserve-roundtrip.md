# 01: Prove an exact one-USDC reserve roundtrip on both public testnets

Type: implementation
Completed: yes
Status: ready-for-agent
Blocked by: None
Parent: [Roundtrip specification](../spec.md)

**What to build:** one parameterized, browserless probe verifies a known contract stack and token binding, deposits exactly one USDC into an XLN reserve, withdraws that exact amount back to the external signer, and reports receipts and exact token/reserve/native-gas accounting. Demonstrate it on an existing real-node fixture, then on Ethereum Sepolia and Arbitrum Sepolia independently using the separately verified deployments.

## Acceptance criteria

- [x] Accept explicit expected jurisdiction/chain and token-binding inputs through an appropriate existing execution surface. Derive the actual asset binding from canonical registry/configuration data rather than assuming a USDT-labelled entry. Keep signing secrets out of arguments, logs and evidence.
- [x] Use existing production signing/batch encoding, RPC adapter and token/reserve operations. Do not duplicate financial formulas, create a test-only payment path or depend on a UI balance.
- [x] Before approving or transferring tokens, verify the expected chain, current stack bytecode/bindings, expected token address and six-decimal dimensions, signer funding and a clean, debt-free reserve identity. Invalid inputs fail with useful evidence before spending.
- [x] Use normal ERC20 approval as needed, then deposit exactly `1_000_000` atomic token units from the external wallet into its XLN reserve. An ERC20 mint, debug reserve funding or local impersonation is not deposit evidence.
- [x] After the confirmed deposit, the external token balance is exactly its initial balance minus `1_000_000`, and the reserve is exactly its initial balance plus `1_000_000`.
- [x] Withdraw exactly `1_000_000` units back to the same external wallet through the normal signed reserve-to-external operation. The confirmed withdrawal restores both the external token balance and the tested reserve to their initial values.
- [x] Read raw balances at identified chain heights and preserve successful deposit/withdrawal receipts at the configured confirmation depth. Submitted transactions, subprocess exit codes and optimistic displays do not establish completion.
- [x] Record native ETH balances and actual transaction costs separately from USDC, including the fee components relevant to the target network. Do not silently apply an incomplete Ethereum-only fee assumption to Arbitrum.
- [x] An operation failure reports the exact phase, known transaction identifiers and available balances without claiming a successful roundtrip or automatically repeating a financial operation.
- [x] Demonstrate the entire probe on an existing real-node fixture and run meaningful owning regressions. The broad settlement/dispute public proof keeps its independent responsibilities; it is not weakened or relabelled as this narrow probe.
- [x] Execute the same probe on Ethereum Sepolia (`11155111`) using USDC `0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238` and a verified current XLN deployment. Preserve public approval/deposit/withdrawal receipts, exact intermediate/final balances and separate native costs. A local fixture does not satisfy this criterion.
- [x] Execute the same probe on Arbitrum Sepolia (`421614`) using USDC `0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d` and a verified current XLN deployment. Preserve public approval/deposit/withdrawal receipts, exact intermediate/final balances and applicable native fee components. Ethereum-only results do not satisfy this criterion.

## Boundaries

This is the owner-approved Q6 reserve ingress/egress check, extracted from deployment ticket 02 on 2026-11-11. It is separate from the current deployment-only effort and is not started by that effort. It does not open UI, Hub/MM operation, Cross-J orders, collateral fee policy or cross-network recovery.

`Blocked by: None` applies to probe implementation against an existing real-node fixture. The public runs require verified manifests and token bindings from the separate [Ethereum deployment](../../sepolia-arbitrum-deployment/issues/03-ethereum-sepolia-delivery.md) and [Arbitrum deployment](../../sepolia-arbitrum-deployment/issues/04-arbitrum-sepolia-delivery.md), plus a funded external signer and a clean reserve. Those deployment tickets do not require this task. This task owns both public financial runs; they are no longer acceptance criteria of deployment tickets 03/04.

## Verification evidence

Local implementation preceded the separately owner-selected public runs below.
The [operator guide](../../../docs/deployment/usdc-reserve-roundtrip.md)
records the CLI inputs, secret/RPC channels, output semantics and exact owning command.
The final local run passed **15 tests / 65 assertions in 227.39 s**, using real
Anvil contracts, token transfers and signatures. Two independent read-only review
axes identified final-evidence gaps; both are fixed and covered by the local
orphaned-block and receipt/expense contradiction regressions.

The candidate is dirty on `testnets_deploy`, based on
`2df74f251d3ff3a869738ee1b77787f4be58185b`. The applicable deployment profile passed **6/6 gates**: **274 Hardhat tests,
64 Foundry checks, 125 Bun tests / 3,645 assertions**, including all 22 native
interruption cuts. All 571 covered source hashes and 181 artifact hashes stayed
stable. Generated local outputs were removed after verification under the owner
retention policy; runnable tests, commands and measured results remain. Exact
current scope and unrun gates belong to the [single handoff](../../../docs/night-work-plan.md).
Both public runs below preserve exact source/configuration/receipt/balance/native-cost evidence.

Additional owner-selected verification: the unchanged CLI passed an isolated
Ethereum Sepolia Anvil fork at block `12135037`, using the actual USDC and
existing XLN contracts. All three local receipts reached twelve confirmations;
public balances/nonces remained unchanged. The [fork record](../../../docs/deployment/usdc-reserve-roundtrip.md#ethereum-sepolia-fork-rehearsal-2026-11-14)
retains measured balances and native expenses. This does not satisfy either
public financial acceptance criterion.

The later owner-selected Arbitrum Sepolia fork at L2 block `329232602` also
passed unchanged: three local receipts at depth twelve, wallet `20 -> 19 -> 20`
USDC and reserve `0 -> 1 -> 0`, exact native accounting and unchanged public
balances/nonces. Historical L1 metadata was preserved. The [Arbitrum fork record](../../../docs/deployment/usdc-reserve-roundtrip.md#arbitrum-sepolia-fork-rehearsal-2026-11-14)
states the Nitro fee/precompile limits.

The owner then selected the public Ethereum Sepolia run. It completed once with
three successful receipts, each at depth twelve or more: wallet `9 -> 8 -> 9`
USDC, reserve `0 -> 1 -> 0`, debt zero, Entity nonce `0 -> 1 -> 2`.
Native balance reduction equals actual receipt fees: `12869822` wei, with zero
unaccounted difference. The [public Ethereum record](../../../docs/deployment/usdc-reserve-roundtrip.md#public-ethereum-sepolia-result-2026-11-14)
links the three explorer receipts, historical balance points and raw local
report, including dirty candidate identity and seven probe source hashes.

The owner then separately selected public Arbitrum Sepolia. The unchanged CLI
completed once with three successful receipts at depth twelve or more: wallet
`20 -> 19 -> 20` USDC, reserve `0 -> 1 -> 0`, debt zero, Entity nonce `0 -> 1 -> 2`.
Native reduction and receipt fees both equal `7654409540000` wei; unexplained
difference is zero. Nitro `l1BlockNumber` and `gasUsedForL1` fields are retained;
the observed poster component was zero for all three transactions. Independent
read-only `cast` checks confirmed all historical balances, receipts and fee
accounting. The [public Arbitrum record](../../../docs/deployment/usdc-reserve-roundtrip.md#public-arbitrum-sepolia-result-2026-11-14)
links raw evidence and all three public explorer transactions.

**12/12** acceptance criteria are checked; `Completed: yes`. All 571 covered
source hashes, 181 artifact hashes, 185 original deployment records and the seven
earlier Ethereum evidence files stayed unchanged. The source was subsequently
committed as `c8fcff807e26af4569d9135d08216c1b93efce0a`, with all thirteen
executable/configuration/test hashes unchanged. Original public reports retain
their actual dirty execution identity. This completes the scoped financial
ticket, not a clean-tree release,
Cross-J, L1 finality, UI or whole-product/mainnet acceptance.

# Ethereum Sepolia to Arbitrum Sepolia: retained plan and decisions

Updated: 2026-11-13. Repository HEAD inspected for this documentation alignment:
`fa6e1528c6bc6acfcd6d111a7d5851968d1ca18a`, `testnets_deploy`, with unrelated
working-tree changes preserved. The original research inspected
`019d45beb5954e77fe806d643845f6a4dca4fa82` on 2026-11-10. Its historical network
observations are not current deployment proof. No public RPC query, build,
scenario, signing or deployment was performed for this update.

**FACT** identifies inspected repository configuration/records. **DECISION**
records an accepted owner choice. **UNKNOWN** identifies an unverified public
boundary or unresolved economic term. This concise record replaces the obsolete
combined Stack Manager/deployment/roundtrip plan without changing the accepted
financial scope.

## Three separate outcomes

1. **Current contract delivery:** deploy and verify both public stacks through the native CLI. The [public specification](../../.scratch/sepolia-arbitrum-deployment/spec.md) and its network tickets own this outcome. Catalog admission, UI and financial roundtrips are separate.
2. **Later independent reserve roundtrip:** on each network, deposit exactly `1_000_000` USDC units from an external wallet into its XLN reserve and withdraw exactly that amount to the same wallet. The [roundtrip specification](../../.scratch/sepolia-arbitrum-usdc-roundtrip/spec.md) owns receipts, intermediate/final balances and separate native costs.
3. **Later Cross-J rehearsal:** deposit exactly one source USDC, execute all of it through the existing signed Cross-J path and withdraw the resulting net target amount to the external Arbitrum recipient. This does not gate contract deployment or either independent roundtrip.

## Selected assets and current implementation

**DECISION:** use the existing owner-selected USDC contracts, with six-decimal
amounts, rather than the originally proposed USDT or a newly deployed ERC20.

| Network          | Chain ID | Selected USDC                                | Hardhat parameters                                                                     |
| ---------------- | -------: | -------------------------------------------- | -------------------------------------------------------------------------------------- |
| Ethereum Sepolia | 11155111 | `0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238` | [ethereum-sepolia.json](../../jurisdictions/ignition/parameters/ethereum-sepolia.json) |
| Arbitrum Sepolia |   421614 | `0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d` | [arbitrum-sepolia.json](../../jurisdictions/ignition/parameters/arbitrum-sepolia.json) |

**FACT:** the [Hardhat configuration](../../jurisdictions/hardhat.config.ts)
contains both networks, using `ETH_SEPOLIA_RPC`, `ARB_SEPOLIA_RPC` and the
established `DEPLOYER_PRIVATE_KEY` secret channel. The canonical
[native deployment design](../deployment/ignition-stack-design.md) uses one
Ignition executor, eight creations, two bindings and first stablecoin listing.
One confirmation is required between operations and at least twelve for every winning
receipt before success. This depth is not Ethereum finality or Arbitrum L1
settlement. Stack Manager/catalog/publication are optional consumers afterward.

**UNKNOWN:** neither network's current XLN deployment, token/proxy metadata,
issuer provenance, RPC/compiler compatibility, available balances, nonce or
gas costs is certified by this document. Refresh them before public execution;
a token symbol, configured address or old receipt is insufficient.

The current remaining implementation boundary is the native recovery work
[04](../../.scratch/ignition-stack-migration/issues/04-process-and-lock-recovery.md),
[05](../../.scratch/ignition-stack-migration/issues/05-rpc-nonce-and-evidence-conflicts.md),
[06](../../.scratch/ignition-stack-migration/issues/06-reorg-and-confirmation-admission.md)
and [07](../../.scratch/ignition-stack-migration/issues/07-complete-recovery-matrix-and-handoff.md).
Local working paths and passing tests do not establish public-chain delivery.
The abandoned Ethereum attempt remains on-chain; its local evidence was deleted
by owner decision. Do not resume/import it or reuse old nonce predictions.

## Accepted Cross-J criteria

**DECISION, 2026-11-11:** fix the actual source deposit at exactly `1 USDC`
(`1_000_000` atomic units). Requested and actually credited amounts must agree.
The destination criterion is the external recipient's actual USDC balance
increase after the executed quote and applicable token fees. Exactly one target
USDC is not required. Record native ETH gas separately on each chain, with any
provider gas reimbursement in its stated tariff accounted for explicitly.

**DECISION, accepted Q2:** use owner-operated Hub and MM Runtimes for the first
rehearsal. Prefund the destination Hub reserve with real Arbitrum Sepolia USDC
and fund native gas separately. The user's one-USDC deposit is separate from
operator capital. Reuse the existing signed route and authority structure.
An MM's credit capacity is not evidence of withdrawable target liquidity.

**DECISION, accepted Q3:** all source units must execute and the resulting net
target amount must reach the external recipient. Intermediate partial fills
remain valid algorithm behavior. Cancellation, a source remainder or an
unsecured Account claim does not satisfy this rehearsal. This criterion does
not add a new cross-chain atomicity rule or guaranteed unsecured-debt recovery.

## Open terms and economic prerequisites

**UNKNOWN:** executable quote/spread, accepted gross/net limits, effective
versioned token fees, minimum lots/amounts and whether one source token can fully
execute under those terms. Reconcile every rounding remainder and fee exactly.
The former Q4/Q5 quote/tariff proposals were not accepted. Their illustrative
numeric payout was not a guarantee; no such price or fee is fixed here.

Concrete operator identities, authorized credit, prefund amounts/funding
transactions, signer and final external recipient must be prepared for that
later phase. Quote/tariff choices remain owner decisions. These preparations
are not prerequisites for deploying the contract stacks.

## Eventual financial and recovery acceptance

- Pin the same executable/configuration candidate and verify chains, code/bindings, registry and asset identity. Record signer/recipient and raw token/reserve/native balances at identified chain heights.
- Preserve source approval/deposit receipts, exact external debit and reserve credit, then committed Account admission. A debug mint, impersonation, UI balance or simulator-only result is insufficient.
- Retain a real committed maker order, signed route, both bilateral Account commitments and deadlines/reveal evidence. Reconcile all partial fills to full `1_000_000` source execution, with no unresolved Pulls or Account ACKs at completion.
- Where cover is required, retain the effective versioned tariff/fee authorization, actual destination reserve funding and authenticated J observation. Reconcile net withdrawable collateral and any unsecured remainder; exchange settlement alone is not payout proof.
- Preserve signed destination settlement/batch and withdrawal receipts, exact reserve debit, recipient `balanceOf` increase and actual native costs. The executed quote, token fees and final net payout must balance exactly; never count a fee twice.
- Interrupt before/after partial fill and reveal. Recover from accepted checkpoint/WAL and redeliver the committed outbox, then complete or use canonical clear/dispute for the exact remainder. Preserve executed amounts and prevent duplicate deposit, fee or withdrawal. Reconcile both networks, deadlines, remaining debt and actual payout.

Hub availability, collateral, debts, gas and deadlines constrain exits. Rollup,
reorg and RPC timing assumptions need public-network verification; no measured
Arbitrum recovery bound or completion ETA is asserted here.

## Existing path and next work

The existing [Cross-J scenario](../../core/scenarios/cross-j/index.ts),
[route setup](../../core/entity/tx/handlers/cross-j/setup.ts) and
[collateral request](../../core/account/tx/handlers/rebalance/request-collateral.ts)
are starting points for the later production-equivalent probe. Their presence
does not certify either public network or external withdrawal. Reuse the
canonical execution and economic formulas; do not create a parallel financial
implementation. A demonstrated need for a new bridge/protocol is an owner
decision, not an assumption of this plan.

The next implementation slice remains native recovery ticket 04, followed by
05/06 and the complete 07 handoff, then fresh public preflight and both native
deployments. UI, reserve roundtrips, Cross-J quotes/liquidity and financial
execution stay outside that immediate deployment work. This update closes no
public acceptance criterion and starts no implementation, signing or deployment.

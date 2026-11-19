# Prove the TypeScript USDC Cross-J path without a frontend

Status: ready-for-agent
Created: 2026-11-16
Inspected source baseline: `b2dceb3438ff2582cee0c5741fe4a0528f5cbd26`
Owner decisions: [design interview](map.md)
Retained financial criteria: [Cross-J record](../../docs/research/sepolia-arbitrum-cross-j.md)

## Outcome

Deposit exactly `1_000_000` USDC atomic units on Ethereum Sepolia, execute all
source units through the canonical TypeScript Cross-J path, and withdraw at
least `850_000` target USDC units to the user's external Arbitrum Sepolia EOA.
The source-to-external-payout difference must be at most `150_000` units,
including exchange pricing and token fees. Account claims, cancellation and an
unexecuted source remainder do not satisfy this outcome. Native gas is separate.

Use the existing six-decimal USDC contracts and deployed stacks identified in
the retained record. Verify their live identity and state before execution;
historical deployment and independent reserve-roundtrip receipts establish
neither Cross-J execution nor current liquidity.

## Single-run ticket closure

On 2026-11-19 the owner approved closing
[05](issues/05-public-preflight-and-gas-plan.md) and
[06](issues/06-public-sepolia-arbitrum-proof.md) as preparation and observation
of one public 1-USDC demo. The [recorded run](../../docs/evidence/ts-usdc-cross-j-poc/fresh-ubkyjm-journey-executed.json)
paid 0.899801 USDC and retains its actual working-tree fingerprint.
[14](issues/14-five-run-and-recovery-gas-plan.md) tracks the five-run plan
and recovery budget. [15](issues/15-clean-candidate-public-proof.md) tracks the
clean-commit proof and durable signed Cross-J trace. The original funded
stores remain tracked in [11](issues/11-separate-operator-funding.md) and
[12](issues/12-public-rpc-capacity-and-funded-catchup.md).

## Accepted operating model

- One dedicated user vault owns one TS Runtime and distinct per-jurisdiction
  signers and lazy Entities, following the existing wallet identity derivation.
  Each Entity has its own bilateral Account with the corresponding Hub Entity.
- The external recipient is the user's Arbitrum signer EOA, address B. Measure
  its actual token-balance increase from the withdrawal.
- Owner-operated Hub/MM Runtimes provide the signed route and executable maker
  liquidity. Prefund the target Hub reserve with actual Arbitrum USDC. Operator
  capital and native gas funds are separate from the user's source deposit.
- Apply ordinary effective signed Hub tariffs and executable MM pricing. For
  the selected quote, target user-to-Hub credit equals the required gross
  target amount, with no automatic increase. Source outgoing is backed by the
  deposited collateral. Configure any required credit explicitly per Account.
- Implementation, runtimes, tests and agents may execute on the current
  computer under [AGENTS.md](../../AGENTS.md). Its branch, stand ownership,
  review, signing and verification policies still apply.

## Production journey

1. Prepare chain/contract/token identity, signed Hub profiles, reachable direct
   Hub endpoints and authenticated relay sessions for endpointless user/MM
   transport. Read executable MM depth, exact quote and versioned tariffs.
   Prepare payer-specific gas estimates on both chains, including cover and
   recovery, then obtain explicit numeric ETH spending limits before public
   financial execution. Existing per-gas/replacement caps are not a cumulative
   PoC budget.
2. Bootstrap the user Runtime through production jurisdiction/Entity admission.
   Establish bilateral Account commitments and drain their ACKs; a local H0
   Account row alone is insufficient readiness evidence.
3. Approve where required, deposit exactly one source USDC and fund the source
   Account through canonical J batching and authenticated J observation. Prove
   the exact external debit, reserve accounting and bilateral Account credit.
4. Submit the existing signed Cross-J intent through production Runtime ingress.
   Reconcile every partial fill to full source execution. Preserve the maker
   order, signed route, both Account commitments, deadlines and reveal evidence.
5. Cover the target claim using the effective signed Hub policy. Reconcile the
   gross target amount, prepaid token fee, net collateral and authenticated J
   observation. Prove withdrawable backing rather than credit capacity alone.
6. Execute the canonical destination settlement and Account-to-external
   continuation through C2R and R2E to address B. Check reserve debt constraints,
   signed batch, receipt, exact reserve debit and external balance increase.
7. Reconcile source consumption, gross target, token fees, net payout and native
   costs exactly. Completion requires no source remainder, unresolved Pulls,
   pending bilateral ACKs or unsecured remainder of the user's received claim.

## Implementation order

Build one browserless TS scenario over existing Runtime commands, financial
admission, transport, J adapters and storage. Financial transitions and money
formulas stay in their canonical owners.

The earliest unproven public financial boundary after the recorded reserve
deposit is reserve-to-bilateral-Account funding. Reach that boundary first, fix
only its first observable divergence and add the smallest owning regression.
Then continue the same journey through MM execution, cover and external exit.
The full outcome above remains the deliverable.

Use real contract/token operations and production WAL/outbox behavior in the
owning local scenario. Debug reserve funding, impersonation or a second
financial implementation cannot establish public acceptance.

## Recovery and evidence

- Interrupt around partial fill and reveal, restore from canonical checkpoint
  plus ordered Runtime WAL, and redeliver the committed outbox. Verify no
  duplicate deposit, fee or withdrawal. Evidence reports are not recovery state.
- Exercise existing clear/dispute for the exact remaining obligations when
  required. A safe cancellation is a recovery result, not successful full
  execution. Stopping a process does not stop either chain's deadlines.
- Preserve raw receipts, identified chain-height balances, signed financial
  evidence and exact accounting under `docs/evidence/`, associated with the
  actual executable/configuration candidate. Use one committed clean SHA for
  final readiness claims; do not relabel dirty-run evidence.
- Run focused owning checks first, then the applicable verification profile for
  the actual affected behavior under AGENTS.md. Runtime/consensus/storage/API
  changes use the broader profile; this PoC does not inherit deployment-only
  verification or external-review exceptions.

## Execution inputs and boundaries

Prepare actual signer addresses, reachable endpoints, registry assets, maker
orders, available reserves, debt state, quote/tariff versions and gas estimates.
No live values or completion-time guarantee are asserted by this specification.
The numeric ETH limits will be approved after estimation, as accepted in Q7.

Frontend work, Solidity changes and a separate Pay between two users are outside
this PoC. TypeScript is canonical; Rust parity is not a prerequisite. A newly
demonstrated protocol fork requires an owner decision. Implementation begins
under the owner's explicit start instruction for ticket 01; numeric gas approval and
live financial prerequisites remain required before the public run.

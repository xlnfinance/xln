# xln and shared financial state

Start with [J/E/A](intro.md): jurisdictions, entities and bilateral accounts are
existing finance. xln makes their state replicable and verifiable, and account
obligations enforceable through programmable jurisdictions. RCPAN combines credit
and collateral; Delta Transformers add signed programmable conditions.

The mission is [accounts supporting 51% of world GDP made provable by 2050](intro.md#mission).
This comparison concerns architecture, with implementation, adoption and release
evidence assessed separately.

## The architectural claim

Ordinary account activity should be agreed and verified by the parties whose
relationship changes, rather than published through one mandatory global pipeline.
J provides common registration, collateral, net settlement and dispute enforcement.

That composition supports:

1. independent financial relationships across independent machines;
2. locally retainable account evidence, without global per-payment publication;
3. inbound capacity using collateral or deliberately granted credit;
4. programmable Entity authority and bilateral financial conditions; and
5. adversarial enforcement of signed outcomes under explicit J/evidence/timing rules.

## Comparison by financial boundary

| Model                                   | Ordinary activity and evidence                                                         | Credit/collateral and enforcement                                                                          |
| --------------------------------------- | -------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| Traditional institutional accounts      | Bilateral records under institutional authority                                        | Credit and collateral policies; enforcement through the institution and its jurisdiction                   |
| Shared-state rollups                    | Ordered execution plus shared transaction-data rules                                   | Financial contracts under the rollup's authority and settlement assumptions                                |
| Validium / AnyTrust-style systems       | Shared execution with external data-retention assumptions                              | Correctness proofs do not themselves supply missing account or withdrawal evidence                         |
| Fully collateralized bilateral accounts | Local updates, retained signed evidence                                                | Secured capacity limited by backing; underlying J enforces exit                                            |
| Interledger connectors                  | Bilateral accounts and routed obligations                                              | Settlement delegated to external systems; routing alone does not supply the complete xln dispute primitive |
| xln RCPAN                               | Local account agreement under Entity authority; parties/delegates retain usable proofs | Chosen credit and collateral, signed Delta Transformers, programmable J settlement and disputes            |

The distinction is where ordinary financial agreement and evidence live, not
whether a system calls itself a blockchain. A rollup can itself serve as an xln J;
this does not route every xln account update through its shared execution layer.

## Closest prior work and the remaining contribution

RCPAN generalizes secured bilateral balances by allowing a signed credit range,
earmarked collateral and programmable financial terms in the same account.
Zero credit is the secured special case. This is the precise account-level
superset claim; it does not establish that every service, implementation or
adoption outcome of another system is contained in xln.

Project activity and useful adoption are separate evidence. Checked 2026-09-30:
[Lightning's LND](https://github.com/lightningnetwork/lnd/releases) and
[Cardano Hydra](https://github.com/cardano-scaling/hydra/releases) publish recent
releases; Interledger maintains [Open Payments](https://interledger.org/tech/open-payments/).
These sources contradict a blanket claim that all are abandoned, but do not
establish material economic adoption or prove their financial models superior.
[Raiden's release history](https://github.com/raiden-network/raiden/releases)
is a dated reference, not evidence of current usage. No live adoption counts
were established by this review. Compare the financial primitive directly.

Interledger already describes bilateral credit, prefunding and conditional
payments across heterogeneous ledgers. Its [Bilateral Transfer Protocol](https://interledger.org/developers/rfcs/bilateral-transfer-protocol/)
leaves dispute resolution to additional subprotocols. xln's candidate contribution
is a common signed account primitive combining credit, earmarked collateral,
conditional terms and programmable J recourse, rather than bilateral routing alone.

The [BIS 2025 financial-system blueprint](https://www.bis.org/publications/aer-2025/next-generation-monetary-financial-system)
also seeks integration of existing money and assets, and considers centralized,
layered and separate-ledger architectures. xln should demonstrate its local
agreement and independently exercisable recourse rather than claim exclusive
discovery of integration or portray all alternatives as one global ledger.

An AMM, auction or clearing service can be an Entity with bilateral accounts to
its participants. Coordination then belongs to that service's authority domain;
it need not impose a global pipeline on unrelated accounts. Comparing designs
still requires equivalent pricing, capital, fairness and failure outcomes.

## Rollups and bilateral programmability

Rollups publish or otherwise arrange availability of the data needed by their
shared execution domain. Arbitrum Rollup, for example, publishes batch data to
Ethereum; AnyTrust uses an external committee with an explicit trust assumption.
[Arbitrum's protocol explanation](https://docs.arbitrum.io/how-arbitrum-works/inside-arbitrum-nitro)
describes this distinction.

xln's ordinary account updates avoid that global per-payment obligation. Each
party verifies its own financial relationship and retains enforceable evidence.
A dispute publishes the material required for J execution. This is a structural
advantage for independent financial activity; it is not merely cheaper batching.

Shared-state execution is not a prerequisite for programmable finance. Bilateral
conditions can express payments, swaps, lending and orders, with Entity-owned
coordination where needed. xln's thesis is that this is a better foundation for
existing account-based finance. Demonstrating a replacement for a particular
shared-state product means showing the same economic rights and outcomes,
including pricing, liquidity, coordination and failure behavior. A universal
strict-dominance claim is not established by the account invariant alone.

## Three protections and their limits

- **Proof:** establishes the signed obligation and permits dispute without peer cooperation.
- **Collateral:** backs the secured entitlement; grantors choose additional unsecured exposure.
- **Delta Transformers:** enforce agreed conditions while value moves, bounded by signed allowances.

This composition makes bank-style credit provable rather than requiring every
relationship to be fully collateralized. Receiving without equal pre-funding
comes from accepting bounded counterparty debt. Proof cannot guarantee repayment
of unsecured debt; settlement uses available collateral/reserves and books the
remainder under J rules.

Parties or delegates must retain their usable evidence. Account consensus does
not require unrelated parties' history; J verification still follows the chosen
jurisdiction's consensus and data rules. A signed state cannot reconstruct bytes
that nobody retained, and a local verifier cannot force J transaction inclusion.

## Scale and small devices

Independent accounts can add aggregate capacity without one global per-payment
execution or publication ceiling. A hub, Runtime, Entity, route or J still has a
finite resource budget. Shared operators and simultaneous disputes can concentrate
load; extra graph edges alone do not prove extra TPS or economic isolation.

**One billion TPS is an ambition, not a measured repository result.** Live TPS
must count unique committed economic operations under the
[production measurement contract](../AGENTS.md). Replay throughput and submitted
traffic do not establish it.

XLNC's selected direction is an ordinary stateful EVM J with roughly 10–20 times
less block gas capacity, serving rebalances and disputes. Phone/laptop full nodes
and five-minute catch-up of the last two days are measurement targets. Account
execution and full J verification have separate resource budgets; measure CPU,
memory, disk, bandwidth and energy with the selected conventional client.
See [XLNC](xlnc-soft-mainnet.md) and the [provable-account research](research/provable-account-mechanisms.md).

## What would falsify the architecture claim

The claimed advantage fails if ordinary independent activity secretly requires a
global xln sequencer, shared history scan or per-payment J publication; if a party
cannot enforce a valid retained proof under the stated rules; or if account credit,
collateral and conditional obligations diverge between runtime and J.

A claim of superior aggregate scaling also needs routing, concentrated-hub and
credible simultaneous-exit evidence. The comparison should name the financial
workflow and trust assumptions, then compare useful completion, cost, capital,
verification and recovery under failure. Self-scoring and author-awarded rankings
provide none of that evidence.

## References

- [RCPAN invariant](core/12_invariant.md)
- [Canonical implementation cascade](core/rjea-architecture.md)
- [Delta Transformer direction](counterfactual-transformers.md)
- [Ethereum data availability](https://ethereum.org/en/developers/docs/data-availability/)
- [Interledger Architecture](https://interledger.org/developers/rfcs/interledger-architecture/)
- [Perun bilateral/virtual accounts](https://eprint.iacr.org/2017/635)
- [Sprites conditional account construction](https://arxiv.org/abs/1702.05812)

Last reviewed: 2026-09-30.

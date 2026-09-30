# Unified Financial Theory: J/E/A and provable accounts

**[← Index](../readme.md)** | **[Prev: Q&A](00_QA.md)** | **[Next: J-Machine →](11_Jurisdiction_Machine.md)**

**Role:** financial theory and architecture thesis
**Author:** Egor Homakov / h@xln.finance
**Status:** theory; current implementation and release evidence are separate

## Start with the existing economy

The world already organizes finance through jurisdictions, entities and accounts.
UFT describes those relationships with one vocabulary:

- **J:** jurisdiction authority, registration, reserves and settlement enforcement.
- **E:** people and organizations with authority rules and financial relationships.
- **A:** bilateral accounts recording balances, obligations and agreed conditions.

Fedwire, banks and customer accounts illustrate the model before any cryptocurrency
terminology is introduced. Public programmable settlement networks are another
implementation of J. Their replicated state machines make enforcement accessible;
the financial abstraction does not depend on calling them blockchains.

xln improves the existing model with replication, verifiable state and signed
account evidence usable in a programmable jurisdiction. Runtime supplies the
implementation's deterministic orchestration, commitment and delivery.

## Mission: provable economic activity

[MML](../intro.md#mission) is to make the accounts supporting **51% of world GDP
provable by 2050**, with dispute on underlying programmable J-machines.
The objective is enforceable account coverage, including activity that never needs
individual J settlement. Useful completed operations are adoption evidence;
their turnover is not itself a measurement of GDP coverage.
The scope includes provable J reserves as well as enforceable account claims.
Backing reserves and claims are separate views of financial rights, not additive
economic output. Stock coverage and annual GDP attribution need separate measures.

## The account invariant

The financial range combines credit and collateral:

    Credit-only:       −Lₗ ≤ Δ ≤ Lᵣ
    Collateral-only:     0 ≤ Δ ≤ C
    RCPAN:             −Lₗ ≤ Δ ≤ C + Lᵣ

Here Δ is Left's allocation; Left is chosen by canonical Entity-ID order.
The exact code-field meanings and grant direction are in
[the RCPAN invariant](12_invariant.md). The bound unifies fully collateralized
and credit-bearing relationships without requiring every account to use credit.

Credit policy belongs to the parties and operators. The runtime checks the
agreed financial bounds before signing. The J machine enforces signed claims,
collateral allocation and its reserve/debt rules; it does not underwrite borrowers
or recreate the account's credit-limit policy as a second authority.

## Three protections

1. **Proof of the obligation:** retained signed evidence allows unilateral dispute.
2. **Chosen collateral backing:** parties select secured exposure and acceptable
   unsecured credit, with manual policy and soft/hard limits in the user experience.
3. **Delta Transformers — security in motion:** signed programmable conditions
   protect pending payments, swaps and other financial operations. Their dispute
   execution is bounded by the signed allowances and evidence rules.

These mechanisms improve verifiability, secured recovery and conditional execution.
They partially address the exposure associated with hub runs. They do not create
liquidity for insolvent borrowers or eliminate maturity transformation: the
unsecured remainder still depends on the counterparty's ability to repay.
See the [Diamond–Dybvig background](https://www.nobelprize.org/prizes/economic-sciences/2022/popular-information/)
and the actual [debt settlement rule](../../jurisdictions/contracts/Depository.sol).

## Local activity, common enforcement

Independent accounts agree on ordinary activity locally. Only the evidence and
operations required for registration, collateral, net settlement and disputes
reach J. A proof holder need not reconstruct unrelated parties' payment histories.
Parties or their delegates must retain their own usable evidence.

The scaling thesis is aggregate capacity across independent machines, with low
J load relative to ordinary activity. One billion TPS is an ambition requiring
production measurements. Concentrated hubs, routing, storage and simultaneous
exits retain physical limits; there is no claim of infinite hardware capacity.

Programmable bilateral finance includes payments, swaps, lending and conditional
orders. A claim that a bilateral construction improves a particular shared-state
product requires an equivalent economic outcome and explicit authority, liquidity
and recovery assumptions. See [the comparison](../competitors.md).

## Jurisdiction strategy

Ethereum, TRON and XLNC form the initial focus. Compatible EVM jurisdictions,
including Base and Arbitrum, can share the same E/A financial machinery. Deployment
and verification of each J boundary remain concrete work. EVM compatibility alone
is not evidence of working withdrawals or identical finality.

Future central-bank programmable jurisdictions fit the same model when available;
the launch does not wait for them. Independent verification on small consumer
devices targets the specialized XLNC jurisdiction, not full Ethereum/TRON history.
XLNC uses conventional stateful EVM execution with lower block gas capacity;
it needs no ZK execution or state-witness protocol. CPU, memory, storage,
bandwidth, energy and synchronization budgets must be demonstrated.

## Complementary work

Entity Board/Control/Dividend authority and Hanko signatures extend the same model
to organizations: [Hanko](../architecture/hanko.md). Programmable account clauses
extend its financial terms: [Delta Transformers](../counterfactual-transformers.md).
Key derivation and recovery are a separate implementation component:
[BrainVault](../../brainvault/readme.md).

Optional insurance, automated portfolio policy and alternative ownership designs
are further applications. Their economic benefits require their own analysis;
they are not prerequisites for understanding J/E/A or the RCPAN bound.

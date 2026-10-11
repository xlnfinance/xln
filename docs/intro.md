# xln in five minutes

xln makes existing financial accounts provable. The parties agree on signed
state, choose their credit and collateral policy, and can take a dispute to the
underlying programmable jurisdiction. Ordinary payments and swaps update those
accounts without submitting every operation to a shared settlement machine.

## J/E/A: the financial world in three machines

- **Jurisdiction (J):** the authority that registers rights and enforces settlement.
  Fedwire and central-bank settlement are existing examples in this model;
  programmable EVM jurisdictions provide the current executable enforcement path.
- **Entity (E):** a person, bank, business or other organization, with its own
  authority rules, state and financial relationships.
- **Account (A):** the bilateral relationship between two entities, recording
  their balances, obligations and agreed conditions.

UFT is the financial model. RCPAN formalizes the account's credit/collateral
bounds. xln implements replicated, verifiable E/A machines and connects their
proofs to programmable J enforcement. Runtime hosts and coordinates E/A;
it is an implementation layer, not a fourth financial institution.

## Mission

**MML: by 2050, make the accounts supporting 51% of world GDP provable and
capable of dispute on underlying programmable J-machines.**

The goal is coverage of existing economic activity by enforceable account proofs.
The financial scope includes reserves recorded in programmable J-machines and
the signed account claims resting on them. Track reserve backing and account
claims separately: their sum double-counts the same backing, and a stock of
provable balances is not itself annual GDP coverage.
Activity need not be individually submitted to J to be covered. Payment turnover,
assets deposited and technical TPS are separate measurements; dividing payment
volume by GDP does not establish GDP coverage. The attribution method for GDP
coverage remains to be specified with the owner. Count the same economic activity
once and distinguish demonstrated coverage from adoption targets.

Owner clarification, 2026-10-11: broad adoption of disputable bilateral
relationships is the mechanism; 51% of GDP remains the economic outcome.
Raw account counts cannot measure it: creating many empty accounts adds no
economic coverage. A covered relationship must retain usable signed evidence
and an executable dispute path, with secured value and unsecured risk explicit.

A feature advances MML when it makes a real financial relationship easier to
adopt, verify or enforce. The first user journey is funding, payment, same-J and
cross-J swaps, withdrawal, and recovery after operator failure.

## Three protections

1. **Proof:** retained signed account evidence lets a party establish the agreed
   obligation and dispute it without the counterparty's cooperation.
2. **Collateral:** only the collateral-backed entitlement is secured. A credit
   limit is the grantor's maximum accepted unsecured exposure, not a repayment
   guarantee or additional collateral. Proof alone cannot turn unpaid debt into money.
3. **Delta Transformers:** signed conditions govern value while it moves, such
   as conditional payments and swaps. J enforces the agreed transformation within
   signed allowances when cooperation fails.

This makes financial claims more verifiable and their secured portion enforceable.
It can reduce and contain hub-run exposure; it does not eliminate maturity mismatch
or insolvency on the unsecured portion.

For example, a claim of 100 with 70 of collateral allocated to the claimant
contains 70 secured and 30 unsecured. A credit limit of 50 permits that 30 of
exposure; it does not insure it. Exercising the secured entitlement still requires
valid evidence and the jurisdiction's dispute, inclusion and finality rules.

## The RCPAN bound

    −leftCreditLimit ≤ Δ ≤ collateral + rightCreditLimit

Left is the lexicographically lower Entity ID. Δ is Left's allocation, including
signed net changes, not a viewer-dependent “I owe you” balance. Credit is optional
per relationship: zero credit gives a fully collateralized account. A recipient
can deliberately extend credit to its hub to receive without equal pre-funding.
See [the invariant](core/12_invariant.md) for exact direction and capacity semantics.

## Jurisdictions and evidence

Initial focus: **Ethereum, TRON and XLNC**. Additional compatible EVM jurisdictions,
including Base and Arbitrum, use the same financial model and canonical adapter
path. Each still needs verified deployment, observations, finality and dispute/
withdrawal behavior. XLNC is a development target, not a declaration of readiness.
A future central-bank EVM jurisdiction can be integrated when its actual interface
and authority rules meet those requirements.

Ordinary account updates avoid global per-payment publication. Aggregate capacity
can grow across independent accounts; one billion TPS requires measurements.
The small-device full-node target is XLNC, pronounced “excellence”, not the full
Ethereum/TRON machines. Owner direction: a conventional stateful EVM jurisdiction
with roughly 10–20 times less block gas capacity, serving rebalances and disputes.
Phone/laptop operation and five-minute catch-up are acceptance targets to measure.

## Read next

1. [Unified Financial Theory](core/10_UFT.md)
2. [RCPAN invariant](core/12_invariant.md)
3. [Runtime → Entity → Account → Jurisdiction](core/rjea-architecture.md)
4. [Launch journey and acceptance](wallet-journey-plan.md)
5. [Architecture comparison](competitors.md)

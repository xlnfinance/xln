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

A feature advances MML when it makes a real financial relationship easier to
adopt, verify or enforce. The first user journey is funding, payment, same-J and
cross-J swaps, withdrawal, and recovery after operator failure.

## Three protections

1. **Proof:** retained signed account evidence lets a party establish the agreed
   obligation and dispute it without the counterparty's cooperation.
2. **Collateral:** the parties choose backing and credit exposure, manually or
   through soft-limit policy. Secured entitlement and unsecured receivable remain
   distinct; proof alone cannot turn an unpaid debt into available money.
3. **Delta Transformers:** signed conditions govern value while it moves, such
   as conditional payments and swaps. J enforces the agreed transformation within
   signed allowances when cooperation fails.

This makes financial claims more verifiable and their secured portion enforceable.
It can reduce and contain hub-run exposure; it does not eliminate maturity mismatch
or insolvency on the unsecured portion.

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
The small-device full-verification target is XLNC, pronounced “excellence”, not
the full Ethereum/TRON machines. A compact J with bounded execution and authenticated
state witnesses is the proposed route; its resource budget remains to be measured.

## Read next

1. [Unified Financial Theory](core/10_UFT.md)
2. [RCPAN invariant](core/12_invariant.md)
3. [Runtime → Entity → Account → Jurisdiction](core/rjea-architecture.md)
4. [Launch journey and acceptance](wallet-journey-plan.md)
5. [Architecture comparison](competitors.md)

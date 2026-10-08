# Why programmable EVM jurisdictions first

J/E/A starts with existing finance. xln needs a programmable J boundary capable
of enforcing retained signed financial account evidence. Ethereum, TRON and XLNC
are the initial focus, with Base, Arbitrum and other compatible Js using the same
financial model. This is a practical implementation strategy, not a claim that
no other execution model can express equivalent financial rules.

## What the current boundary requires

- Verification of Entity authority, Hanko signatures, nonces and signed proof bodies.
- Custody/accounting for registered assets, reserves and account collateral.
- Deterministic execution of signed Delta Transformer clauses within allowances.
- Atomic settlement and bounded reserve/debt enforcement, with observable receipts.
- Dispute clocks, reveal evidence, inclusion and finality behavior the runtime can verify.

These functions are implemented in the canonical
[contracts](../../jurisdictions/contracts/Depository.sol) and imported through
[the J adapter boundary](../runtime/jadapter.md). Credit underwriting belongs to
the parties and operators; J enforces signed outcomes rather than a duplicate
credit-policy engine.

## Why reuse the EVM boundary

The current Solidity contracts, bytecode/artifact checks and runtime integration
already target this interface. Compatible deployments can share the financial
machinery. TRON's TVM supports Solidity with platform-specific execution and
resource behavior, which still needs real receipt/finality verification.
[TRON contract documentation](https://developers.tron.network/docs/smart-contract-development).

A compatible VM does not imply identical asset identity, consensus, authority,
finality, data availability or withdrawal behavior. Each admitted J needs its
own executable boundary evidence. No generic two-block default establishes that.

## Future central-bank jurisdictions

Central-bank programmable settlement is a plausible integration direction.
[BIS/New York Fed Project Pine](https://www.bis.org/project/pine) demonstrated a
research prototype for monetary-policy operations in tokenised wholesale markets.
It is not a live Fedwire integration or evidence that every central bank will
adopt EVM on a fixed timetable. xln can integrate compatible actual interfaces
when available, while launching on existing programmable Js.

## Other execution models

A port must preserve exact authority, account-proof and financial settlement
semantics. UTXO transactions can update several inputs/outputs atomically; absence
of mutable Solidity storage is not a proof that programmable finance is impossible.
Similarly, parallel execution can serialize conflicting financial updates. A
rewrite onto another VM requires concrete work and evidence, not blanket claims
that its architecture cannot support debts or atomic financial transitions.
See the primary descriptions of [Cardano transactions](https://developers.cardano.org/docs/developers/curriculum/fundamentals/core-concepts/transactions/)
and [Solana's transaction pipeline](https://solana.com/docs/core/transactions/transaction-pipeline).

Wrapped assets, external bridges and new issuers introduce their own financial
claims and recovery conditions; a matching ticker does not establish identity.
They do not change what a J, Entity or bilateral Account means.

## XLNC specialization

XLNC is xln's own compact programmable J, pronounced “excellence”. Its purpose
is registration, capital, settlement and adjudication while ordinary payments
and swaps remain in accounts. Expensive discretionary J operations encourage
that separation. Small blocks and bounded execution/evidence/state costs establish
its verification budget; gas price alone does not.

The small-device objective targets ordinary stateful XLNC full nodes, not full
Ethereum/TRON verification. XLNC reduces block gas capacity by roughly 10–20
times and serves rebalances and disputes; it introduces no ZK or state-witness
protocol. See [the XLNC proposal](../xlnc-soft-mainnet.md) for synchronization,
consensus and emergency-dispute capacity measurements.

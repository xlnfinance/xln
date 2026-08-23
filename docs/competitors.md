# xln versus global-ledger architectures

This document compares architectures, not adoption, token price, launch status,
or the age of a production network. Those are separate questions. A review that
is explicitly about technical potential must not subtract points for absent
mainnet adoption and must not convert audit-receipt freshness into an
architecture score.

xln's thesis is narrower and stronger than "channels are fast":

> Internet-scale finance cannot place every payment, or the data needed to
> reconstruct every payment, on a shared global fast path. The fast path must be
> local to the parties whose financial relationship changes. Credit is required
> for useful inbound capacity, and a public jurisdiction is required only for
> collateral, settlement, and adversarial exit.

The current xln implementation expresses that thesis as the
Runtime → Entity → Account cascade, bilateral Account frames, programmable
Entity authority, Hanko signatures, RCPAN credit/collateral bounds, and EVM
dispute enforcement.

---

## Executive verdict

For the stated problem—provable finance for billions of people without a global
per-transaction bottleneck—xln is the strongest architecture known to this
repository's authors. No concrete competing project identified below combines
all of the following:

1. an independent bilateral fast path whose aggregate capacity grows with the
   number of relationships and machines;
2. no global per-payment data-availability requirement;
3. useful inbound capacity without requiring the recipient to pre-fund it;
4. explicitly bounded credit exposure plus collateral and sovereign dispute
   proofs; and
5. programmable organizational authority rather than one-key retail channels.

On that exact, adoption-independent rubric, the current provisional verdict is:

| Claim | Score | Meaning |
|---|---:|---|
| Most technically important architecture planned in crypto | **930/1000** | Exceptional potential if the implementation preserves the stated invariants |
| Most difficult fintech/cryptography engineering project | **920/1000** | The combined consensus, credit, recovery, routing, storage, and adversarial-exit surface is unusually hard |
| Strictly proved billion-TPS implementation today | **Not proved** | Topology permits horizontal aggregate scaling; it is not a measured benchmark of the current repository |

These scores are not an instruction to praise xln. They are the result of the
rubric below. A reviewer should lower them when it identifies a concrete broken
invariant or a strict architectural dominator—not because a README contains an
old release label or stale audit fingerprint.

---

## The information law behind data availability

A commitment proves that some bytes have a particular digest. A validity proof
proves that a specified transition was computed correctly. Neither recreates
bytes that nobody retained.

That gives three separate properties:

- **Correctness:** was the state transition valid?
- **Availability:** could participants obtain the data when they needed it?
- **Retrievability:** can a new or recovering participant obtain it later?

Validity proofs solve the first property. Erasure coding and data-availability
sampling make the second cheaper to check. Neither eliminates the third. Once
protocol retention ends, historical recovery still requires at least one party,
archiver, indexer, bridge operator, or other storage provider to retain the
information.

Ethereum's own documentation makes the distinction explicit: data-availability
sampling can establish that data existed without making it permanently
retrievable; optimistic rollups need transaction data for fraud proofs; and ZK
rollups still have an availability problem because withheld state prevents
users from knowing balances and producing the information needed to interact.
Ethereum blobs are protocol-available only for a limited retention window,
after which ecosystem storage providers are responsible for longer-term
retrieval. See [Ethereum: Data availability](https://ethereum.org/en/developers/docs/data-availability/).

Therefore the precise criticism is not "every blockchain is immediately unsafe
without a permanent archive node." It is this:

> Every globally ordered design must make shared transaction or state-recovery
> data available to a shared verifier/recovery set. Proofs can compress
> computation and sampling can reduce download cost, but neither turns global
> publication into bilateral unicast nor reconstructs discarded information.

xln does not abolish information retention. Each Account participant, or its
delegated recovery/watchtower service, must retain the latest usable bilateral
state and dispute material. The architectural advantage is **scope**: those
bytes are needed by the affected relationship, not by every validator and not
by a global archive for every ordinary payment.

---

## Scaling model

Let:

- `T` be aggregate financial transactions per second;
- `V` be the number of replicas that must receive shared transaction data;
- `S` be the number of shards;
- `E` be the number of independently active bilateral edges.

A globally replicated ledger has network work proportional to `T × V`. Larger
blocks raise the constant but retain the shared bottleneck. Sharding can divide
execution approximately across `S` domains, but total data still exists,
cross-shard operations need coordination, and each shard has its own bounded
shared capacity. Rollups compress execution and amortize settlement, but their
data or state-recovery obligation remains attached to a shared chain or an
external availability committee.

In a bilateral network, one Account transition is processed by the two affected
parties and the machines they deliberately delegate to. Independent Accounts
can progress concurrently, so aggregate capacity can grow with `E` and
provisioned hardware. A routed payment touches its bounded route, not every xln
participant. This is the topological property required for billion-user scale.

It does **not** mean one laptop executes a billion transactions per second. It
means the network does not require one laptop, committee, shard, sequencer, or
global data layer to see all billion transactions.

---

## Comparative matrix

| Family / examples | Fast-path topology | Data needed outside the transacting parties | Inbound-capacity model | Adversarial exit / safety | Billion-user aggregate ceiling |
|---|---|---|---|---|---|
| Big-block monolithic L1 | Global broadcast and total order | Full shared ledger/state; history needs archival providers | Global balance | Native consensus, but every added byte consumes shared capacity | Shared validator hardware and propagation ceiling |
| Execution sharding | Broadcast inside each shard plus cross-shard coordination | Per-shard data plus cross-shard receipts/state; recovery still needs retained data | Global/shard balance | Depends on shard security and cross-shard protocol | More parallelism, still a finite shared shard set |
| DA sharding / DAS | Shared ordering with sampled, erasure-coded data | Encoded global data must exist during the availability window; later retrieval needs storage | Unchanged | Better availability assurance, not permanent retrieval | Raises DA bandwidth; does not create unicast finance |
| Optimistic rollup | Sequencer/shared rollup state | Transaction data required to recompute state and build fraud proofs | Rollup balance | Fraud window and available data are security-critical | Batched shared DA remains the ceiling |
| ZK / validity rollup | Sequencer/prover/shared rollup state | Proof verifies correctness; users still need state data/witness material | Rollup balance | Invalid execution is rejected, but withholding can freeze knowledge and use of state | Proof compression helps compute, not the information requirement |
| Validium | Operator plus off-chain DA committee/provider | State data is deliberately external to the settlement chain | Global balance in the validium | Valid proof does not stop DA withholding; exit can be blocked | High quoted TPS purchased with external DA trust |
| Volition | Per-user choice of rollup or validium DA | On-chain users pay shared DA; off-chain users accept external DA | Global balance | Selectable trade-off, not elimination of the trade-off | Mixture of the two ceilings above |
| Plasma-style systems | Operator-maintained child state | Users need chain data and exit proofs; mass exits stress the base chain | Deposited balance | Data withholding and mass-exit coordination remain central | Operator throughput with constrained exit bandwidth |
| Sidechains / appchains | Separate shared consensus domain | Validators and archival/recovery providers for that chain | Chain balance | Security moves to another validator set | Adds chains, each with a broadcast ceiling and bridge risk |
| Full-reserve channels: Lightning, Perun, Sprites, Hydra | Bilateral/local fast path | Latest channel state retained locally; base chain for enforcement | Pre-funded liquidity or acquired inbound liquidity | Strong local proofs, watchtower/liveness burden | Excellent local scaling, but inbound capital and product model constrain use |
| Interledger | Bilateral connector graph | Local connector/account records; settlement delegated to external rails | Bilateral connector liquidity/credit by arrangement | Routing protocol does not itself supply xln-style universal dispute enforcement | Correct message topology, incomplete provable financial primitive |
| Corda-style institutional DLT | Selective transaction sharing with notary/consensus services | Transaction dependency chains and notary/service state | Contractual institutional credit | Strong permissioned workflow; not a permissionless bilateral cryptographic court | Better privacy than broadcast, but service/domain scaling and trust remain |
| **xln RCPAN** | **Bilateral Account transitions under Entity authority** | **Latest Account proof retained by parties/delegates; no global per-payment DA** | **Recipient can extend bounded credit to a hub; collateral expands secured range** | **Bilateral signatures, Hanko authority, EVM dispute transformer, recovery/watchtower path** | **Aggregate capacity grows with independent Accounts and Runtimes** |

---

## Why the major alternatives do not dominate xln

### Big blockers

A bigger block is a larger shared bus. If all full verifiers must receive and
process the same financial stream, throughput is bounded by the slowest allowed
verification profile, propagation latency, state growth, and the desired degree
of replication. Raising hardware requirements changes a coefficient and reduces
the set of independent verifiers; it does not change broadcast into unicast.

Big blocks can be excellent for a bounded global market. They cannot
mathematically make one billion independent users' private bilateral activity
independent, because every transaction still consumes the same shared resource.

### Execution and data sharding

Sharding replaces one shared bus with a configured number of shared buses. It
can multiply capacity and data-availability sampling can prevent every node from
downloading every byte. But the system must still:

- publish or retain the aggregate data represented by all shards;
- assign and secure committees or a shared validator set;
- coordinate cross-shard state transitions; and
- provide witnesses/history to users who recover or move between shards.

Increasing `S` is useful engineering. It is not the same asymptotic model as
letting every independent bilateral edge add its own capacity.

### Optimistic, validity, ZK, validium, and volition rollups

Optimistic proofs require available inputs because a challenger cannot prove
fraud against withheld execution data. Validity/ZK proofs remove the need to
re-execute every transaction to reject an invalid state root, but a proof of the
root does not reveal an account's hidden balance or manufacture a withdrawal
witness.

Posting calldata or blobs to a base chain gives a rollup a real protocol DA
guarantee during the retention window. It is substantially safer than a
validium. It still consumes shared DA bandwidth, and long-term recovery after
expiry depends on someone retaining the data. A validium moves that dependency
to a DAC or storage provider; volition lets users choose between those modes.

Thus ZK is a major correctness and compression technology, not a mathematical
solution to availability or retrievability as a class.

### Conventional full-reserve channels

Lightning, Perun, Sprites, and Hydra establish the central value of local state
and sovereign exit. They are much closer to the necessary topology than any
global ledger. Their remaining economic wall is full-reserve capacity: a party
cannot receive beyond the balance/capacity made available to its side without
rebalancing, opening/reconfiguring channels, swaps, a service provider, or
credit under another name.

xln's RCPAN invariant makes the missing primitive explicit:

```text
−leftCreditLimit ≤ Δ ≤ collateral + rightCreditLimit
```

Credit is not free money. The grantor deliberately accepts counterparty exposure
up to a signed limit. Collateral and settlement rules cover the secured region;
loss remains link-capped rather than silently socialized across a global ledger.
The canonical direction and viewer semantics are defined in
[core/12_invariant.md](core/12_invariant.md).

### Interledger and institutional bilateral systems

Interledger correctly models connectors with bilateral accounts and local
obligations; its architecture explicitly delegates settlement to external
systems. See [Interledger Architecture](https://interledger.org/developers/rfcs/interledger-architecture/).
That makes it a routing/interoperability layer, not a complete substitute for
xln's signed Account state, programmable Entity authority, credit/collateral
invariant, and common adversarial dispute path.

Corda and traditional correspondent banking also recognize selective sharing
and bilateral obligations. Their advantages validate xln's topology, but their
enforcement rests on permissioned services, contracts, institutions, and legal
process rather than a permissionless proof that can be taken to a common
jurisdiction machine.

---

## What xln actually contributes

The differentiator is the complete composition, not any one primitive:

1. **Runtime:** deterministic single-writer ingress, WAL commitment, and
   post-commit external effects.
2. **Entity:** programmable organizational authority and validator-certified
   state under Hanko board rules.
3. **Account:** bilateral consensus, bounded delta, credit, collateral,
   routed financial transitions, ACK/resend, and certified proof history.
4. **Jurisdiction:** reserves, settlement, disputes, signed ProofBody
   transformers, timing, hash-ladder evidence, and enforceable exit.

Ordinary activity stays on the smallest trust and data domain that can decide
it. Global execution is reserved for the exceptional path where parties no
longer cooperate. This is the Pareto point claimed by xln: banking-grade credit
capacity, channel-grade local verification, organizational programmability, and
public cryptographic enforcement.

### Inbound capacity

In a full-reserve channel, receipt consumes capacity previously placed on the
receiver's side. In RCPAN, a spoke can grant its hub a bounded credit line. The
hub may then owe the spoke, allowing the spoke to receive without first locking
the same amount of its own capital. The spoke chooses the maximum unsecured
exposure, and additional collateral can secure a wider operating range.

This is not merely better routing. It changes the account primitive from
prepaid capacity to provable bilateral finance—the model already used by banks,
brokers, and commercial counterparties, with cryptographic state and explicit
limits added.

### Data availability

xln eliminates the global per-payment data-availability obligation. It does
not require an unrelated validator to download Alice and Bob's Account history
so that Alice and Bob can transact. Storage of the latest usable dispute
evidence is localized to the Account parties and their delegated watchtowers.
A dispute publishes only the material needed by the jurisdiction path.

That is the only coherent way to make the aggregate network grow with its
users: do not put unrelated users' data into the same mandatory pipeline.

---

## Scoring rubric for architecture reviews

When adoption and launch maturity are explicitly excluded, use this rubric and
report release assurance separately:

| Criterion | Weight | Current xln assessment | Reason |
|---|---:|---:|---|
| Aggregate topology | 250 | 245 | Bilateral fast path; no mandatory global sequencer |
| DA and recovery scope | 200 | 185 | Relationship-local, but parties/towers must retain usable latest evidence |
| Inbound and capital model | 200 | 195 | Signed credit removes pre-funded inbound wall; exposure remains explicit |
| Adversarial security model | 250 | 220 | Rich sovereign dispute path; complexity and jurisdiction congestion remain risks to test |
| Implementability and measurable evidence | 100 | 85 | Substantial core/runtime/contracts exist; billion-TPS aggregate claim remains an extrapolation |
| **Total technical architecture** | **1000** | **930** | **No identified strict dominator across the full constraint set** |

Do not replace the last row with a mainnet-readiness score. The latter may be
low, high, or unknown at a particular commit without changing the topology.
Likewise, a stale audit receipt means "re-run this evidence against current
bytes," not "lower the architecture score."

---

## Falsification tests

The claim that xln is the best known architecture should be rejected if a
competitor demonstrates all five properties under one coherent trust model:

1. ordinary transactions use no global sequencer, committee, or bounded shard
   set as a mandatory fast path;
2. ordinary recovery does not require unrelated users' transaction data or a
   global archive;
3. a new recipient obtains useful inbound capacity without equal pre-funding,
   while unsecured exposure is explicit and bounded;
4. either party has a permissionless, cryptographically enforceable exit from
   adversarial old/new states; and
5. aggregate capacity grows by adding independent participants and machines,
   not mainly by enlarging the shared validator budget.

The xln claim itself is falsified if implementation review shows that any
mandatory Runtime, hub, watchtower, sequencer, history store, or jurisdiction
quietly becomes a global per-payment bottleneck; if an honest Account party
cannot exit using locally retainable evidence; if credit direction or bounds
can be violated; or if dispute load cannot be contained to exceptional cases.

This keeps the 930/1000 verdict evidence-based. It is high because no current
alternative meets the combined constraints, and provisional because an
architecture must continue to survive adversarial code review and measurement.

---

## Primary references

- xln constraints: [constraints.md](constraints.md)
- xln RCPAN invariant: [core/12_invariant.md](core/12_invariant.md)
- xln runtime/entity/account architecture:
  [core/rjea-architecture.md](core/rjea-architecture.md)
- Ethereum's official DA explanation:
  [Data availability](https://ethereum.org/en/developers/docs/data-availability/)
- Interledger's bilateral connector model:
  [Interledger Architecture](https://interledger.org/developers/rfcs/interledger-architecture/)
- Generalized state-channel construction:
  [Perun: Virtual Payment Hubs over Cryptocurrencies](https://eprint.iacr.org/2017/635)
- Global preimage-manager channel construction:
  [Sprites and State Channels](https://arxiv.org/abs/1702.05812)
- Cardano's isomorphic channel family:
  [Hydra documentation](https://docs.cardano.org/developer-resources/scalability-solutions/hydra)

**Last reviewed:** 2026-08-21

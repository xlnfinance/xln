# 02: Execute the full source USDC amount through the MM

Type: implementation
Category: enhancement
Completed: yes
Status: ready-for-agent
Blocked by: 01 - Create a headless user and fund the source Account with one USDC

**What to build:** extend the same headless scenario so the funded user obtains
an executable MM quote, submits the canonical signed Cross-J intent and exchanges
all source units for a committed target Account claim. The operator can verify
the complete source consumption and gross target amount before collateral cover.

## Acceptance criteria

- [x] Reuse the funded user and production path from ticket 01. Admit the user's
  target Entity and bilateral Hub Account using its existing per-jurisdiction
  identity in the same user Runtime.
- [x] Use owner-operated Hub/MM Runtimes, authenticated production transport
  and a real committed maker order with enough executable depth. Report missing
  registry assets, liquidity or admission prerequisites as concrete blockers.
- [x] Obtain the executable quote through canonical planning and submit the
  signed intent through production Runtime ingress and WAL. Preserve the maker
  order, route authorization and actual selected quote.
- [x] Set target user-to-Hub credit exactly to the required gross target quote,
  with no automatic increase. Source outgoing capacity is backed by the user's
  deposited collateral; operator capital is accounted for separately.
- [x] Execute all 1_000_000 source atomic units. Intermediate partial fills are
  valid, but final dust, a cancelled remainder or an unexecuted source amount
  cannot pass. Use canonical lot, quantization and exact-money rules.
- [x] Preserve both bilateral Account commitments and the canonical deadline,
  partial-fill and reveal evidence. Reconcile the committed gross target claim
  and drain its required Account ACKs and completed Pull obligations.
- [x] Apply ordinary effective signed policies and MM prices. An unavailable
  or inadmissible quote produces useful failure evidence rather than synthetic
  fills, special zero fees or direct state funding.
- [x] Extend the reproducible real-node scenario and focused financial checks.
  Retain a smallest owning regression for any observed production divergence.

## Boundary

The resulting target claim is an intermediate financial artifact. Ticket 03
must prove collateral backing and actual external payout.

## Verification evidence

The owning real-node scenario completed the full source-funding and Cross-J
journey in 16.0 seconds under the stand lock. It exchanged all 1_000_000 source
units for a committed 999_900-unit target claim using an existing MM order at
priceTicks 9999. Target user-to-Hub credit was exactly 999_900 with no automatic
increase. Source and target routes fully closed with zero remainders and no
live user Pulls.

Both Account heads matched their Hub counterparts at heights 6 and 4, with
matching cached bilateral Hanko and no pending frames or Account mempool work.
The report retains source ingress receipts, the maker quote, canonical intent,
close proofs, deadlines and public signatures. Private reveal preimages are
excluded; private checkpoint/WAL inputs remain in the ignored local job store.

Owning checks passed 52 tests / 1,179 assertions. The final applicable full
check passed 3 short gates, 38 source gates and 10 soundcheck gates, including
frozen-core and runtime types. The strict Entity-summary decoder now validates
the current swapTakerFeeBps field and has a focused malformed-input regression.

The retained local report identifies the actual dirty base SHA and eight
source/test hashes. This is local EVM Cross-J claim evidence, not target cover,
external payout, public-network execution or clean committed release acceptance.

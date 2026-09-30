# xln launch pilot

Planning baseline: `5bdb9b03c5e5b3551c4735d6d39dad2ccddd0a4b`, inspected on
2026-09-04. This specification preserves the launch objective; it is not release
approval, current test evidence, a customer commitment, or approval to spend funds.

## 1. Start

The wedge is small USDT treasury desks repeatedly moving working capital between
Tron payouts and Ethereum DeFi. Start with a complete public-testnet pilot, then
admit real funds only after the applicable release and risk controls pass. The
product is instant private payments **and** swaps, including cross-jurisdiction
swaps. Payment-only is not a launch milestone.

The smallest credible deployment has three operationally independent hub owners,
H1/H2/H3, and market-maker liquidity. Each hub owner runs one Runtime containing
its Ethereum and Tron sibling Entities. Each user and MM similarly keeps its own
two sibling Entities together in its own Runtime. Operators have separate keys,
hosts, administration and recovery ownership. Three children controlled by one
operator do not demonstrate independence.

Offer Ethereum USDT, Tron USDT and one liquid Ethereum pair beyond USDT, selected
from the first desks' actual demand and executable MM quotes. Asset identity is
jurisdiction-local; identical ticker names never make the two USDT assets
interchangeable. Use Ethereum Sepolia and Tron Nile for the public-testnet loop;
Ethereum mainnet and Tron mainnet remain the intended real-funds rails.

The first user must complete funding, a private payment, a same-jurisdiction swap,
a cross-jurisdiction swap, and withdrawal through the app. Include cancellation,
restart and recovery drills. Funded off-chain completion is measured separately
from chain funding and finality. Publish the privacy boundary accurately: private
bilateral state and encrypted transport do not justify an unconditional anonymity
claim.

The landing page presents that workflow, current network stage, supported assets,
fees, liquidity and recovery coverage. Foundation endorsement is the default
discovery view, with a visible permissionless view for unendorsed hubs and
jurisdictions. Signature verification, endorsement and operational health have
distinct meanings.

The sharpest adoption risk is asking desks to prefund unfamiliar hubs before
dependable quotes, liquidity and exits are demonstrated. The pilot must earn that
working-capital allocation through repeated successful use.

## 2. Traction and intermediaries

Interview 15 desks about an existing recurring Tron/Ethereum treasury workflow;
recruit five design partners with a named operator and a real recurring task.
Approach two OTC or payout businesses as referral partners and two MMs as liquidity
partners. These are recruitment targets, not claimed relationships. Seek switching
evidence in lower total cost, faster usable funds and fewer manual steps.

Onboard each desk with a guided testnet round trip, an agreed trade-size band, a
quote comparison against its existing workflow, and a recovery/exit rehearsal.
After real-funds approval, start with that same bounded workflow. Do not count a
faucet-funded rehearsal as a funded customer or business volume.

Bootstrap liquidity with explicit MM inventory commitments on both jurisdictions,
two-sided quotes at agreed sizes, disclosed spreads, and measured replenishment
times. Keep MM inventory distinct from operating capital. Incentives reward
completed, attributable customer activity and sustained usable quotes; exclude
self-trades and manufactured round trips. Do not promise uncapped inventory or
liquidity guarantees.

Owner-approved pricing (2026-09-06): zero platform fees for the first 30 days,
then 1 basis point per completed payment and 3 basis points per completed swap,
plus disclosed hub fees, spread and chain gas. Show the total quote before
acceptance. The business terms are approved; canonical fee accounting, the configured
fee recipient and actual deployment still need implementation evidence. Testnet can
show the approved fee schedule without booking fixture activity as real revenue.

The useful intermediaries are the two distribution partners, independent hub
operators, MMs, recovery/watchtower providers, and reviewers who can verify the
deployed contract/runtime evidence. Foundation endorsement helps discovery but is
not a guarantee against loss. Before real-funds rollout, establish the applicable
legal and operational responsibilities for the selected desks and operators with
qualified advisers. Do not start by pursuing broad bank or CBDC partnerships.

The commercial clock starts when the real-funds pilot is approved and usable.
Public-testnet recruitment and rehearsal results are reported separately.

| Milestone | Commercial target                                                                                                   | Evidence                                                                                                      |
| --------- | ------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| Day 30    | Five funded desks; 100 genuine completed operations; quotes available for at least 95% of requests at agreed sizes  | Completed end-user operations, both payment and swap use, and all quote requests including unavailable quotes |
| Day 60    | Ten weekly active desks; at least 50% four-week retention; at least 30% lower measured all-in cost                  | Cohort history and like-for-like comparisons including spread, hub fees, platform fees and gas                |
| Day 90    | Twenty weekly active desks; two partners each originating three active desks; positive contribution after subsidies | Attributed active desks and revenue less attributable variable costs and incentives                           |

A weekly active desk completes a genuine business payment or swap in that week;
report payment users, swap users and users of both separately. Four-week retention
uses the original activated cohort, without replacing churned desks in its
denominator. Compare cost at the same trade size and destination asset, and show
funding/rebalancing costs separately from the funded off-chain path.

Continue only with zero unexplained loss, at least 99% completion of accepted
quotes, and funded off-chain completion p95 at or below two seconds. Quote
availability has all requests in its denominator; completion has accepted quotes
in its denominator. Report timeouts and user cancellations explicitly.

Pause money movement on an accounting or exit fault, preserve evidence and repair
the first fault before resuming. Stop expansion if day-90 cohort retention remains
below 50% or contribution after subsidies is non-positive. A smaller reliable
pilot can continue while the economics are repaired; growth does not excuse an
accounting failure.

## 3. Fundraising and expansion

Before a round, produce repeat retained usage, paid pricing evidence, positive
contribution after subsidies, dependable liquidity at useful sizes, three
independent operators, and reproducible settlement/recovery evidence. Separate
customer volume from testnet, MM maintenance, subsidies and benchmark traffic.
Do not fundraise on submitted transactions or an unverified TPS projection.

Likely strategic investor and customer classes are stablecoin payout/treasury
providers, OTC businesses, MMs and wallet or DeFi distribution businesses that
benefit from this exact flow. Approach them with the measured pilot and a concrete
integration request. This is an outreach hypothesis, not a commitment from any
named organization.

Use operating capital for protocol reliability and security, three-operator
operations, recovery readiness and the two partner integrations. Budget liquidity
inventory separately, with explicit ownership and exposure limits. No fundraising
amount or equity/governance change is specified here.

Expand in this order: deepen dependable liquidity in the initial corridor; embed
the workflow in the two partner products; add assets demanded by retained desks;
then add qualified jurisdictions with demonstrated operations and demand. Retain
Ethereum for DeFi and Tron for USDT rails throughout the initial launch.

## Prioritized technical acceptance

Root implementation owns the production boundary. This is an acceptance
specification, not another live TODO list; [todo.md](../todo.md) remains the release
status. [fints.md](fints.md), [the canonical architecture](core/rjea-architecture.md)
and [AGENTS.md](../AGENTS.md) retain their normative authority.

| Priority | Deliverable                                                                                           | Acceptance evidence                                                                                                                                                                                                                            |
| -------- | ----------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| P0       | First real Account opening and payment over production P2P with the selected TS/native Rust processes | Commit roots agree; no retired embedded authority or shadow path is restored; preserve the first failure capsule and add its smallest regression vector                                                                                        |
| P0       | One immutable mixed production WAL                                                                    | Replay the same checkpoint/WAL through TS W1/W4 and Rust W1/W4; every R/E/A root and ordered event/effect/outbox digest agrees per frame                                                                                                       |
| P0       | Live jurisdiction integration                                                                         | Native Rust watcher → Entity → batch → authenticated receipt; strict rebalance, same-j swap and cross-j/MM flow; fix the first divergent production boundary before broadening tests                                                           |
| P1       | Complete public-testnet product                                                                       | Current-byte Sepolia and Nile contracts/adapters; app funding → payment → same-j swap → cross-j swap → withdrawal; cancellation, partial fill and dispute/recovery evidence; preserve receipts and ordered roots                               |
| P1       | Three independent hubs and MM liquidity                                                               | Three separately operated owner Runtimes, each with two local sibling Entities; independent MM Runtime; quote depth/availability and recovery after hub/MM restart demonstrated                                                                |
| P1       | Honest discovery and onboarding                                                                       | Foundation endorsement shown by default; unendorsed permissionless view remains available; signature verification does not masquerade as endorsement; explicit chain, asset, counterparty, fee and recovery presentation                       |
| P1       | Landing and complete browser journey                                                                  | Pilot offer replaces unsupported scale/anonymity claims; real app flow completes with zero uncaught browser errors, truthful stage labels and usable recovery instructions                                                                     |
| P2       | Release candidate and real-funds authorization                                                        | Current immutable candidate passes the applicable scenario, Rust production/test, browser, recovery, deployment and security gates, then `bun run check`; risk-control and contract blockers are resolved before claiming real-funds readiness |
| P2       | Production performance evidence                                                                       | After exactness and live J gates, run the required locked live H1 baseline; count committed unique operations, drain all Account ACKs and prove zero transport loss                                                                            |

Use the stand lock for every heavy run. Production TPS requires at least 1,000
active sovereign user Runtimes packed 200 per process, a full 20-second window at
at least 1,000 offered payments/second, at least 1,000 committed economic
operations, real WAL/fsync, an explicit TS/Rust engine and a five-second drain.
Replay, enqueue counts and AccountTx throughput are not TPS. Push only validated
milestones after the relevant L1/L2 evidence and `bun run check`.

### Evidence limitations that must remain visible

- [The policy](../ops/capped-testnet-policy.json) records `riskCapUsd: null` and
  `riskCapEnforcement: not_implemented`. The older USD 10,000 prose is an
  unenforced proposed ceiling, not protection. Independent hub funding limits do
  not by themselves prove an aggregate ceiling. A real enforcement design is a
  protocol/business decision if existing canonical rules do not determine it.
- [Release blockers](../core/scripts/release/mainnet-gate-constants.ts) include
  aggregate financial-risk enforcement, bilateral lending covenants and on-chain
  maturity/default enforcement. Do not describe a public-testnet launch as
  resolving these real-funds blockers or silently exempt a currently exposed flow.
- [The jurisdiction registry](../jurisdictions/jurisdictions.json) records real
  Sepolia/Nile deployments as pending, while its active local `Tron` entry is a
  second EVM test chain. [MM mesh](../core/scenarios/cross-j/mm-mesh.ts) runs dual
  Anvil; [the cross-j scenario](../core/scenarios/cross-j/index.ts) covers two
  Runtimes. Neither proves live Tron or independent operators.
- [Public discovery](../core/orchestrator/hub/public-discovery.ts) currently exposes
  `operator-config` and `verified-gossip-profile` role evidence, not Foundation
  endorsement. [Cross-j topology](../core/runtime/delivery/topology/cross-j-topology.ts)
  requires each owner's sibling Entities together; do not split one hub owner's
  cross-j legs across independent owner Runtimes.

## Economic measurement

[MML](intro.md#mission), clarified by the owner on 2026-09-30, is to make the
accounts supporting 51% of world GDP provable by 2050, with dispute on underlying
programmable J-machines. It measures coverage, including activity that never
needs individual J settlement. Payment turnover divided by GDP does not establish
that coverage; the attribution method remains to be specified.

The following operation measurements provide near-term adoption and reconciliation
evidence. They are separate from GDP coverage, technical throughput and assets deposited.

Use existing payment `lockId` and swap/order identities, with their owner/domain
context, to reconcile end-user economic operations across Runtime records. Derive
analytics from committed evidence; do not add durable consensus fields solely
for reporting. An accepted quote, submitted input, proposal or unresolved Account
ACK is not completion.

Count a payment once when the recipient's economic result is committed. Count a
swap's executed value once at a disclosed valuation convention, not once for each
asset leg; partial fills contribute only their newly completed value. Cross-j
completion requires both legs' committed outcome at the same proven fill ratio.
Retries, route hops, sibling mirrors, duplicate ACKs and later on-chain netting of
already counted activity contribute zero additional value.

Exclude testnet/faucet activity, operator maintenance and liquidity rebalancing,
self-owned transfers and manufactured incentive volume from commercial activity. Real
customer swaps against an MM remain customer activity. Publish the valuation
source and time, unique operation count, missing-evidence exclusions and
reconciliation totals. Track user payments, same-j swaps, cross-j swaps, quote
availability, accepted-quote completion, latency, cost, retention and contribution
alongside provability coverage so gross volume cannot hide an unusable product.

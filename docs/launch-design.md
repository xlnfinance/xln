# xln: liquidity network launch

Date: 2026-09-05; owner decisions updated 2026-09-06. Status: **accepted launch design**.
Investigated SHA: `b97c454d605e750a08da7ff6baab645330175468`; the working tree contains further changes.
This document defines the product and launch criteria. Accepting the design does not perform deployment,
fund transfers, or raise the current limit.

Owner alignment, 2026-09-30: [MML](intro.md#mission) means provable accounts
supporting 51% of world GDP by 2050. Ethereum, TRON and XLNC are the initial
J focus; additional compatible EVM Js, including Base and Arbitrum, belong to
the same architecture. Supporting them together must reuse the canonical
financial path, with deployment, observation, finality and withdrawal evidence
for each admitted J. Future central-bank EVM Js fit this model when available.
This scope update does not declare deployments or change capital authorization.

## One first product

**USDT · Tron ⇄ USDT · Ethereum.** The user gets working liquidity
on the needed network through funded Accounts and an executable quote.
The first customers are treasury/OTC teams with a recurring flow between payouts
on Tron and capital use on Ethereum.

- Required product: payments, same-J swaps, and cross-J swaps. A payment-only launch does not close this goal.
- First route: funding → payment → same-J swap → cross-J swap → withdrawal → recovery after failure.
- "Instant private liquidity network" is an internal target positioning. The public promise of speed and privacy is limited to measured conditions and a disclosed threat model.
- Ethereum, TRON and XLNC are the initial focus, with Base, Arbitrum and other compatible EVM Js supported through the same architecture. The first sellable arrow and each J boundary need their own executable evidence.

The multi-J architecture, finality, and XLNC boundaries are described in
[xlnc-soft-mainnet.md](xlnc-soft-mainnet.md). Customer acquisition, onboarding,
and pilot economics remain in [launch-pilot.md](launch-pilot.md).
Where the first market, MM composition, and launch ladder diverge, this later design governs.

## Our three hubs and MM

```text
        H1                    H2                    H3
          \                    |                    /
                 bilateral Accounts / routing
                    |                    |
              Tron Entities       Ethereum Entities
                    \                    /
                      MM1          MM2
```

- Owner decision from 2026-09-06: **we operate H1/H2/H3 and MM**. Recruiting independent operators does not block the first launch. Separate keys, processes, and recovery do not mean independent ownership.
- Each owner holds their jurisdiction-specific sibling Entities in their own Runtime. An Account links specific counterparties; the Foundation does not become a single operator of the financial ledger.
- MMs provide our inventory on both sides. The proposed two-MM topology is preserved, but their independence and market competition are not claimed. Balance, available capacity, obligations, and replenishment time are measured separately.
- Disabling H2 must leave the available independent H1↔H3 routes operational. Accounts, liquidity, and operations that depend on H2 are not declared automatically available.

Our own H1–H3/MM are used both in development and at the first network launch.
Independent operators are a subsequent stage. The existence of a second MM is not proven by two
names using the same undivided pool of funds.

## Assets and operations

| Operation            | First offering                                          | What must be explicitly shown                                                              |
| -------------------- | ------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| Payment              | USDT · Tron → USDT · Tron; then routes between H1/H2/H3 | Recipient, amount, fees, available receive capacity                                        |
| Same-J swap          | **WETH/USDT · Ethereum**                                | Specific registered tokens, price, minimum receive, fees                                   |
| Cross-J swap         | USDT · Tron ⇄ USDT · Ethereum                           | Both jurisdictions, both sides of the swap, quote validity period and execution conditions |
| Payment + conversion | Alice pays USDT · Tron; Bob receives USDT · Ethereum    | A single verifiable quote and a completed result for Bob                                   |

In the current [market catalog](../core/account/utils.ts) and
[executable scenario](../core/scenarios/market/swap-market.ts) the asset is called
**WETH**, not native ETH. Until a proven wrap/unwrap path exists, receipt of
native ETH cannot be promised, nor can the wrapper be hidden behind an "ETH" label.
A local token with that symbol also does not confirm backing by real WETH.
Public launch requires a registered address, decimals, issuer/backing,
and a verified deposit/withdrawal of the chosen asset.

`USDT_TRON` and `USDT_ETH` are convenient labels for different assets. Canonical identity
is bound to the jurisdiction stack and the local token ID, not to the ticker:
[cross-j market](../core/extensions/cross-j/market.ts).
An XLNC token named USDT does not automatically become the same asset or a claim on Tether.

Payment + conversion is the next combined user operation after
the cross-J swap is proven. Two independently completed steps cannot be declared
a single atomic payment without a corresponding production path and recovery verification.
Lending/credit remain part of the Account architecture; a separate lending product must not
delay the first working corridor.

## The key metric: executable liquidity

**How much a user can get right now, at what full price, and with what probability of completion.**
MM balance and drawn order-book depth are not, by themselves, executable liquidity.

| For each request | Required data                                                                             |
| ---------------- | ----------------------------------------------------------------------------------------- |
| Identity         | Source/target jurisdiction-local asset, amount, direction, trade size                     |
| Quote            | Net receive, full fee/spread, minimum receive, expiration, observation moment             |
| Execution        | Canonical route/market, available MM inventory, and the capacity of the involved Accounts |
| Result           | Accepted/completed/rejected/expired/cancelled, reason, time to economic completion        |
| External cycle   | Separate time/cost for funding, rebalancing, J-finality, and withdrawal                   |

- The UI must use canonical quote/route/Account interfaces; the existence of a ready-made API is not confirmed by this design. If the needed quote does not yet exist, extend the existing runtime quote path. Do not add a second price/capacity calculation or a separate "landing liquidity engine."
- Executability is checked at operation admission; a stale snapshot or a promotional quote does not guarantee execution. Reservation and release use the existing financial path.
- The best price is the one actually available to the user accounting for the full route and fees, not the most attractive headline MM. Changing matcher priority requires separate justification; it does not arise from page design.
- When receive capacity is insufficient, the single [receive-capacity primitive](receive-capacity.md) is used: prepare collateral/credit by the method the user selected, wait for confirmed capacity, then confirm the actual operation.

Measure both directions separately, along with trade sizes agreed with customers:
quote availability across **all requests**, completion across **accepted quotes**,
p50/p95 time, full cost, capital tied up, and MM inventory restoration time.
The time of funded off-chain execution does not include or substitute for the time of a bank
transfer, chain deposit, or on-chain withdrawal.

## Capital ladder

The owner has accepted the following expansion design. These are **design exposure ceilings**,
not current balances, issued limits, or executed transfers.

| Stage           |  Accepted target | Verifiable basis for transition                                                                   |
| --------------- | ---------------: | ------------------------------------------------------------------------------------------------- |
| Public testnet  | Test assets only | Full product, accounting reconciliation, failure/exit/restart; normal resource constraints remain |
| Canary          |          $10 000 | Executable cap, limited exposure, error detection/stop, proven recovery                           |
| Pilot I         |         $100 000 | Operational reliability, repeated customer operations, reconciliation, and available exit         |
| Pilot II        |         $500 000 | Real behavior of two MMs, available quotes, and liquidity replenishment                           |
| Production beta |     $2–5 million | Repeatable treasury economics, concentration risk, and operational resilience                     |
| Mainnet         |    Dynamic limit | Proven risk engine and an explicitly accepted policy for raising/lowering limits                  |

The previously recorded $1 000 relates to the prior limited-experiment plan.
The owner reconfirmed the ladder on 2026-09-06; it describes the launch design;
the actual first tranche, operators, and transition between stages are recorded explicitly.
**No funds were moved as part of accepting this document.**

The [current policy](../ops/capped-testnet-policy.json) still contains
`riskCapUsd: null` and `riskCapEnforcement: not_implemented`. Neither $1 000 nor $10 000
can currently be called a programmatically enforced protection.

The cap must cover admitted exposure and obligations, including pending
operations, credit, and collateral lease; it must not be bypassed by parallel admissions or restart.
Do not sum the same asset repeatedly as reserve, collateral, and Account claim.
Show operating expenses, gas/resources, and dispute reserve separately from
customer liquidity. The exact aggregation scope and risk assessment belong to
risk policy, not a UI slider. An accounting/exit error halts fund movement;
transition to the next stage does not happen automatically on a calendar schedule.

## Discovery and landing

- Foundation verification is **signed trust metadata**: who confirmed, what exactly, for which artifact/operator, and for what period. This is not consensus permission.
- The owner confirmed on 2026-09-06: we sign deployment and the initial endorsements; the actual keys are set by local configuration.
- By default, show endorsed participants; unendorsed ones remain available subject to the usual protocol requirements. Signature, endorsement, connection state, and liquidity are separate fields.
- First screen: direction and size → real available quote → full cost → open Account/continue. Alongside: network stage, operators, MM, and data freshness.
- Mark missing data as "not measured"/"quote unavailable." Do not substitute demo values as live metrics.

From the accepted concept, **the following are not published as facts**: $23.7 billion/day, 1.06 million accounts/day,
sample MM rates, fee $0.84, execution 420/430 ms, liquidity $428k/$842k,
turnover $1.8m, and completion 99.99%. Market figures require their own current
attribution; interface-example numbers — real measurements with a precise description
of the test rig and a link to the artifact.

"Private" discloses the observers and the data available to them. "Instant" requires a measured
threshold time and prefunding/availability conditions. Exit depends on the specific J,
finality, and transaction inclusion; a local fullnode by itself does not guarantee withdrawal.
Do not claim anonymity, trustlessness, or guaranteed on-chain exit time.

## Evidence and the next production path

The saved [replay-report](../.logs/qa/hlt/replays/1788552944285-parity.json)
contains **111 frames, `equivalent: true` for TS/Rust W1/W4/W8**.
This is historical local evidence on its recorded artifacts:
not a current clean-SHA release gate, not public-testnet readiness, and not live TPS.

1. Close the first production recovery divergence; repeat exact replay/restart on the fixed candidate.
2. Prove the full payment/same-J/cross-J/withdraw path and executable quotes from two MMs with canonical capacity checks.
3. Pass real Sepolia/Nile J-boundaries and public-deployment verification; a local "Tron" on Anvil does not substitute for TVM/receipt/finality.
4. Implement and prove the cap, then admit the selected capital stage and independent operators; Base/XLNC pass their own J-gates.
5. Publish the landing page from the same verifiable product data. A full `bun run check` and relevant release gates are mandatory; readiness is not determined by model opinion.

MML is provability coverage of the accounts supporting economic activity, not
payment turnover divided by GDP. Coverage attribution remains to be specified.
For near-term adoption evidence, count a completed payment once and a swap
without summing both legs; exclude repeat settlement, technical relays,
self-trading and faucet traffic. Track repeated useful use and available liquidity
separately from production TPS.

## Walkthrough and failure demonstration

The [wallet acceptance plan](wallet-journey-plan.md#jea-walkthrough-and-failure-acceptance--owner-update-2026-09-30)
must show funding → payment → same-J/cross-J swap → withdrawal → recovery after
hub failure. The new UI explains proof, chosen collateral backing and Delta
Transformers; the existing Svelte frontend E2E must exercise the same financial
outcomes with exact balances, receipts and completed J settlement.

Owner intent is a responder-specific clock: a user-started dispute gives the hub
one hour by default, with longer protection for larger stakes. The current
implementation instead uses the sum of both signed response windows: hub one
hour plus user 24 hours gives a 25-hour unilateral-finalization deadline.
Pull-bearing proofs also use that summed deadline for finalization. The owner
clarified that reaction protection applies to every kind of dispute; cross-J
claims additionally need safe copying of locks and valid evidence. These are
requirements, not an implemented replacement clock.

### Accepted automatic exposure schedule

Owner accepted 2026-09-30. This is the design policy for the implementation task;
existing accounts and contracts retain their currently signed clocks.

Use the maximum authorized account exposure, including conditional commitments,
agreed before the account opens. For an initial USDT corridor, interpolate linearly
between these knots, rounding upward to whole minutes:

| Authorized exposure | Hub reaction window |
| ------------------- | ------------------- |
| Up to 100,000 USDT  | 1 hour              |
| 1,000,000 USDT      | 8 hours             |
| 10,000,000 USDT     | 48 hours            |

Keep the user reaction floor at 24 hours: `userWindow = max(24h, schedule(exposure))`.
This is an adopted initial policy, not a security optimum or a live USD oracle. Other
assets require an agreed denomination/conversion rule. Above 10m requires an
explicit signed policy rather than unbounded extrapolation. Never reprice an
active dispute or allow an old short-window proof to authorize a larger exposure.

Current immutable signed windows must be respected. Under today's summed rule,
10m with two 48-hour windows means 96 hours before unilateral finalization,
not a two-day exit. Separating reaction from finalization requires proof of the
cross-J recovery boundary before implementation.

For each portable conditional claim, a valid source reveal must still be able
to reach the target within its accepted publication window. Account for source
observation/finality and target inclusion, including different dispute start
times. Example: target starts 00:00, source 00:02; a source reveal valid at 01:02
must not be defeated by target finalization at 01:00. Longer reaction windows
alone do not establish this conservation property. Validate the clock/portability
rules before changing code or advertising a one-hour complete exit.

## Minimum remaining work — owner alignment 2026-09-30

These are implementation tasks, not newly demonstrated defects. Preserve the
single live release checklist in [todo.md](../todo.md); dated red/green reports
must be reproduced on the actual candidate before treating them as current.

| Order | Task                                                                     | Completion evidence                                                                                                                                                                                                                    |
| ----- | ------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1     | Establish the current production/recovery boundary                       | Reproduce the canonical payment/cross-J/restart artifact; fix its first divergence if present; exact per-frame R/E/A roots and ordered outputs; full check without a missing-tool failure                                              |
| 2     | Implement the accepted signed exposure schedule and safe recovery clocks | Deterministic rounded interpolation; conditional exposure admission; old-proof/active-clock protection; source-late-reveal and sibling-evidence acceptance tests; TS/Solidity agreement and reviewed bytecode                          |
| 3     | Deliver the financial walkthrough on real J boundaries                   | New UI explains the three protections; existing-frontend E2E verifies funding, payment, same-/cross-J swap, withdrawal and hub failure; actual secured recovery and unsecured receivable; real Ethereum/TRON observations and receipts |
| 4     | Produce the minimal compact XLNC artifact                                | Pinned genesis/rules; one block-producing node and a separate verifier; canonical contracts; reserve/account/settlement/withdrawal/restart; identical verified roots; bounded witness cost and correlated-dispute inclusion capacity   |
| 5     | Connect adoption evidence to MML and finish reader cleanup               | Unique useful completed operations; separate reserves/backing and account claims; a documented GDP-attribution method; dated release claims; one short reading path; root file relocation only after updating verified consumers       |

Items 1–3 establish useful enforceable finance. XLNC research may proceed from
the existing J boundary without delaying its repair. A billion-TPS measurement
and watch-hardware verification are later acceptance artifacts, not substitutes
for this first usable journey.

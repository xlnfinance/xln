# Cross-j netting experiment

This document records implementation decisions and measured results for the
two-jurisdiction netting experiment. The architectural sections began as
static reconstruction; the completed production-stack run described below is
runtime evidence.

## Objective

Measure whether real cross-j orderbook fills accumulate as bilateral Account
exposure and allow physical jurisdiction movement to be based on the remaining
net obligation instead of gross bridge volume.

## Completed production run — 2026-08-15

Status: passed. The local production smoke harness finished with
`production-swap-load:complete` and `[local-prod-smoke] green`.

The run used two EVM jurisdictions, one hub Runtime, the production market
maker, two managed users, USDC as bridge token, and USDT as the separate
rebalance-fee token. It executed all 18 configured fills and all 40 derived
report invariants passed.

| Measurement | Observed result |
| --- | ---: |
| A-to-B fills | 10 |
| B-to-A fills | 8 |
| Forward source volume | 102,000.000000 USDC |
| Reverse source volume | 81,608.160000 USDC |
| Gross source volume | 183,608.160000 USDC |
| Net user spend in jurisdiction A | 20,400.000000 USDC |
| Net user delivery in jurisdiction B | 20,381.640000 USDC |
| Physical settlement | 20,381.640000 USDC in jurisdiction B |
| Rebalance fee | 2.138164 USDT |
| Reported netting efficiency | 8,888 bps (88.88%) |
| Physical settlement / gross volume | 11.10% |
| Economic fill latency | 1.092–1.634 s; 1.426 s average |
| Swap-load stage duration | 755.657 s |
| Full local smoke duration | 822.418 s |

The 18.360000 USDC difference between the two jurisdiction nets is the
configured market-maker ladder spread; the run had zero hub swap fee, not zero
MM spread.

### What the run proved

- All 18 cross-j fills reached committed settlement on both route siblings.
- During accumulation, user/MM replicas converged while collateral, hub
  reserves, `AccountSettled` counts, rebalance requests, and R-to-C operations
  remained unchanged.
- Accumulated user exposure matched the exact fill-derived net in both
  jurisdictions. MM exposure was exactly equal and opposite in each
  jurisdiction.
- One explicit, fee-backed request settled the destination-side residual:
  jurisdiction B collateral increased by 20,381.640000 USDC and its hub reserve
  decreased by exactly the same amount.
- Exactly one `AccountSettled` event finalized, the request cleared, all R-to-C
  queues drained, and all user/MM Account replicas finished quiescent.

### What the run did not prove

- MM inventory was not physically rebalanced. Its final bilateral exposure
  remained the exact opposite of the user exposure, with its 20 resting quote
  pulls per jurisdiction restored.
- The run does not yet prove long-duration inventory recycling, multiple market
  makers, hub failure/restart during the workload, adversarial behavior, real
  public-chain finality, or production throughput.
- Fill execution itself averaged about 1.4 seconds, but the swap-load stage took
  12 minutes 35.657 seconds because the experiment serially waited for Account
  convergence and quote replenishment after every fill. That control-path
  latency is acceptable for evidence collection but is not a competitive
  bridge latency target.

The canonical generated artifact was
`cross-j-netting-experiment-report.json` under the smoke work directory. Its
schema is `xln-cross-j-netting-experiment-v1`, and its completion authority is
`committed_routes_accounts_and_jurisdiction_finality`. The completed harness
reported bootstrap hash
`2b5190dabea19f5ad1096a04d05b3c2b5155bce5539fc9a952b1ea3674e50b37`,
Runtime state hash
`0x330558c54f7da01673a3b16a66af462b72de09339b73c15150829a0ffb303ac8`,
and Entity state hash
`ec82d5a5f9d32b60f5a4da24ed53e9c8eaab0bb51efcc649478f8fc3ea625888`.

## Step 1 — Rebalance control path

Status: reconstructed statically; the explicit R-to-C request path was
exercised successfully by the production run.

### Control ownership

Rebalancing is not controlled exclusively by the hub operator. Authority is
split across the bilateral Account and the hub Entity:

- The user-side Entity stores its private threshold policy through
  `setRebalancePolicy` in `account.shadow.rebalance.policy`.
- The hub publishes committed fee terms into the bilateral Account through
  `rebalance_policy` Account transactions.
- The user-side post-frame hook detects uncollateralized peer-credit exposure
  and may queue `request_collateral`.
- The request prepays the hub fee and becomes committed bilateral Account
  state in `requestedRebalance` and `requestedRebalanceFeeState`.
- The hub scheduler selects requests according to its matching strategy and
  available reserve, adds R-to-C operations to the jurisdiction batch, and
  queues `j_broadcast`.
- An `AccountSettled` watcher event updates collateral and ondelta, reduces or
  clears the outstanding request, and removes the submission marker.

The hub operator therefore controls fee policy, reserve availability, request
priority, and the hub service itself. The user controls whether automatic
requests are enabled and may explicitly request collateral. Neither side alone
guarantees successful execution: the bilateral request still needs an online,
funded hub and a functioning jurisdiction submission/finality path.

### Active paths

#### Automatic R-to-C

1. Account opening seeds a per-token threshold policy from committed
   jurisdiction configuration or token defaults.
2. The hub publishes its per-token fee policy in the Account.
3. After a non-hub Account frame commits, `checkAutoRebalance` compares only
   `outPeerCredit` with `r2cRequestSoftLimit`.
4. If the threshold, fee ceiling, capacity, and queue conditions pass, the
   user Entity queues `request_collateral`.
5. The hub scheduler consumes the committed request and broadcasts an R-to-C
   jurisdiction batch.

The automatic path deliberately skips a token when
`r2cRequestSoftLimit === hardLimit`; this is the supported manual-mode
convention. `hardLimit` is not an execution cap in `checkAutoRebalance`.

#### Explicit user request

The user can submit `requestCollateral` with counterparty, token, amount, fee,
and the hub's committed policy version. It enters the same bilateral request,
hub scheduler, J-batch, broadcast, and finality path as an automatic request.

The hub scheduler rejects or leaves pending a request when its fee-policy
version is stale, its prepaid fee is below the hub minimum, the hub reserve is
zero, another batch is pending, or there is no remaining uncollateralized
exposure. The submitted amount is clamped to both current uncollateralized
exposure and available hub reserve.

#### Direct hub R-to-C

The hub can submit an `r2c` Entity transaction directly. This checks reserve,
adds the operation to `jBatchState`, and requires a `j_broadcast`. It bypasses
the bilateral request scheduler and is therefore unsuitable as the primary
netting-experiment settlement trigger.

#### Automatic C-to-R

The hub scheduler separately detects free collateral above the token-default
soft limit. It creates a bilateral `settle_propose`; after both Hankos make the
workspace executable, it queues `settle_execute` and broadcasts the resulting
C-to-R batch. This can affect experiment results if the initial accounts are
already overcollateralized and must be included in the baseline snapshot.

### Experiment control decision

Use the production rebalance path without allowing per-trade settlement on
either the user or market-maker inventory legs:

1. Before the workload, submit `setRebalancePolicy` on both user-side Accounts
   and both route-owned market-maker Accounts with
   `r2cRequestSoftLimit === hardLimit` to select manual mode.
2. Wait until all four Entity transitions are committed before taking the
   experiment baseline. This is an experiment control; normal market-maker
   bootstrap policy remains unchanged.
3. Execute all forward and reverse cross-j orderbook fills.
4. Assert that no `requestedRebalance`, R-to-C J-batch operation, or finalized
   collateral increase occurred during accumulation.
5. Calculate the observed final net exposure from committed Account deltas.
6. Submit one explicit `requestCollateral` for that exposure using the exact
   committed hub policy version and an acceptable prepaid fee.
7. Observe the hub scheduler, J-batch broadcast, watcher finality, collateral
   change, reserve change, and request clearance.

Prefer paying the rebalance fee in a separate same-decimal token for the first
experiment. When the fee token equals the requested token, the Account handler
stores the request amount net of the prepaid fee, which makes the bridge-token
netting measurement harder to interpret. The report must still record the fee
token and exact offdelta movement.

### Required observations

The implementation must capture these state transitions rather than infer
them from submitted commands:

- User, market-maker, and hub Account `ondelta`, `offdelta`, collateral, and holds.
- `requestedRebalance` and `requestedRebalanceFeeState`.
- `shadow.rebalance.policy` and `submittedAtByToken`.
- The committed bilateral hub fee policy and policy version.
- Hub reserve before request, after batch admission, and after finality.
- R-to-C operations in current, sent, and recovery J batches.
- Jurisdiction broadcast identity and finalized `AccountSettled` event.
- Final request clearance and Account replica agreement.

### Code evidence

- `runtime/entity/tx/handlers/account/lifecycle/open-account.ts`
- `runtime/entity/tx/handlers/account/lifecycle/admin.ts`
- `runtime/account/consensus/helpers.ts`
- `runtime/account/tx/handlers/rebalance/request-collateral.ts`
- `runtime/entity/scheduler/rebalance.ts`
- `runtime/entity/scheduler/index.ts`
- `runtime/entity/tx/handlers/jurisdiction/r2c.ts`
- `runtime/account/tx/handlers/j-events/finality.ts`
- `runtime/types/finance/rebalance.ts`
- `runtime/types/entity-tx.ts`

## Step 2 — Report contract and invariant formulas

Status: implemented and validated by the completed report; 40/40 invariants passed.

The versioned `xln-cross-j-netting-experiment-v1` report contract is defined in
`runtime/scripts/operations/benchmark/production-swap-load/cross/cross-netting-report.ts`.
It records configuration, four-stage financial evidence, every committed trade,
both replicas of each bilateral Account, hub reserve/J-event state, derived
metrics, and fail-fast invariant evidence.

The canonical observed-net calculation normalizes raw Account `offdelta` by
the user's left/right position. Jurisdiction A measures user-to-hub spend;
Jurisdiction B reverses that perspective to measure hub-to-user delivery. Each
must equal its own signed sum of committed source/target trade fills.

The metric implementation derives, rather than accepts, forward volume,
reverse volume, gross volume, expected net, observed net on both jurisdiction
legs, the matching market-maker net on both jurisdiction legs, netting
efficiency, collateral increases, reserve decreases, and total physical
settlement volume. User and market-maker signed exposure must cancel exactly
per jurisdiction before the report can claim accounting conservation. A
persisted report is rejected if supplied metrics or invariant evidence differ
from a fresh derivation.

The first experiment remains restricted to a same-asset, same-decimal,
zero-swap-fee route. Static inspection of the production market maker found
that same-token cross-j quotes still carry the configured ladder spread, so
source and target quantities are not assumed equal. The report computes an
exact net for each jurisdiction leg from committed fills. Token conversion and
swap-fee economics belong in a later experiment version.

The production runtime-adapter deliberately redacts Account mempools from
remote views. The report therefore does not claim direct mempool emptiness;
quiescence requires empty user holds/pulls and absence of pending Account
frames on both user and market-maker replicas. Market-maker holds/pulls are
recorded as active quoted liquidity rather than unfinished experiment work;
the owner and hub replicas must still agree exactly. Route settlement remains
the completion authority for the trade. The adapter now includes compact
redacted recovery J-batches so relevant R-to-C operations are observable
instead of being silently reported as zero.

## Step 3 — Reusable production cross-j trade execution

Status: implemented and exercised by all 18 committed fills.

`cross/worker-cross-trade.ts` now owns canonical taking-route construction,
two-sibling submission, command observation, and the wait for exact committed
settlement on both hub siblings. It validates the selected MM route against the
two hub identities and validates that the supplied Account replicas contain the
expected user/hub participants before constructing dispute configurations.

The existing N=1 production worker retains responsibility for topology
discovery, jurisdiction import, custody setup, credit, WAL/frame snapshots, and
report persistence. It calls the extracted helper once and preserves the
existing report fields and completion authority.

## Step 4 — Financial snapshot reader

Status: implemented and exercised at baseline, after every fill, at request,
and after finality.

`cross/worker-cross-snapshot.ts` reads both replicas of each user-to-hub and
market-maker-to-hub Account plus both hub Entity cores. It records raw committed
deltas, collateral, holds, pulls, request fee evidence, participant-local
threshold policy, committed hub fee policy, hub reserve, bounded finalized
J-event history, and jurisdiction-wide hub R-to-C operations in current, sent,
and recovery batches.

The collector fails if an Account, token delta, user threshold policy, hub fee
policy, reserve, batch shape, or expected participant binding is missing. It
does not substitute defaults for absent financial evidence.

Runtime-adapter Account pages are compact projections, not durable
`AccountReplica` documents. In particular, they expose `pendingFrame` for
quiescence while intentionally redacting the cached outbound
`pendingAccountInput`. The production worker therefore validates them through
the projection-specific Account boundary; the durable validator retains its
strict requirement that both resend fields exist together.

Because the remote Entity view retains only the latest 20 finalized J blocks,
the snapshot records the oldest retained J height. Final report invariants
require that the final retained window covers every block after the accumulated
snapshot; otherwise the experiment cannot claim an exact event count.

## Step 5 — Deterministic trade accumulation

Status: implemented and completed for 10 A-to-B plus 8 B-to-A fills.

`cross/worker-cross-netting-trades.ts` captures the baseline, executes the
configured A-to-B trades followed by the configured B-to-A trades, captures a
committed post-trade snapshot after every fill, and returns the final
accumulated snapshot. It never submits a rebalance request.

Every fill selects one configured market-maker ladder level immediately before
submission. A terminal quote is not reused: the market maker derives the next
immutable route id for that slot from its latest committed close height, and
the worker waits for that replacement when necessary. Because a taking route
runs opposite its resting quote, A-to-B traffic deliberately consumes the
B-to-A MM slot and vice versa.

Route settlement and global Account quiescence are separate completion
boundaries. After each settled fill, the worker polls for the consumed MM quote
slot to reappear under a new immutable route id and for every user/MM owner-hub
replica pair to converge with no pending frame. Reserve, collateral,
`AccountSettled`, R-to-C, and rebalance invariants remain fail-fast on every
poll; only pending consensus, replica convergence, and quote restoration are
retryable. Timeout evidence includes pending-frame heights and Account
transaction types.

Remote route discovery requests one exact directed hub pair and token. The
Runtime adapter applies those live-market filters before its bounded 20-route
projection, so accumulated terminal route history cannot hide an older live
quote in the opposite direction. Each convergence boundary checks both the
replacement quote and the reciprocal level before the next trade begins.

The accumulation boundary fails immediately if user holds/pulls remain, any
pending frame remains, or any owner/hub replica pair diverges. Resting
market-maker holds/pulls are allowed and logged because they collateralize the
real orderbook's active quotes. The boundary still fails if a user or
market-maker rebalance request appears, or if any participant collateral, hub
reserve, hub-wide `AccountSettled` count, or hub R-to-C batch operation changes.
This keeps Step 5 limited to end-to-end credit exposure accumulation and
prevents market-maker inventory settlement from being mistaken for bridge
netting.

## Step 6 — Explicit net-leg settlement

Status: implemented and completed for the single destination-side residual.

The completed run selected the only user leg with positive uncollateralized
peer-credit exposure: jurisdiction B at 20,381.640000 USDC. This is the
destination release leg of the reserve-credit bridge flow. Jurisdiction A's
20,400.000000 USDC user spend and both MM inventory legs remained bilateral
Account exposure; they did not require an additional destination reserve
release in this experiment.

This proves the intended single-MM bridge delivery boundary, but not general
system-wide inventory rebalancing. A later multi-MM or bounded-inventory
experiment must derive the minimum settlement set across all user/MM-to-hub
Accounts and demonstrate how operators recycle accumulated inventory.

`cross/worker-cross-netting-settlement.ts` derives `outPeerCredit` from each
user's committed accumulated Account state. Exactly one user leg must have
positive uncollateralized exposure. The worker does not infer the requester
from the configured trade direction.

Before submission it requires sufficient hub reserve, the hub's exact
committed fee-policy version, an acceptable calculated fee, a separate fee
token, and sufficient requester capacity in that fee token. It submits the
normal `requestCollateral` Entity transaction and captures a snapshot only
after the request id, amount, policy version, fee token, and prepaid fee agree
on committed state.

The finality observer then requires request clearance, an exact collateral
increase and hub-reserve decrease equal to the selected exposure, exactly one
additional matching `AccountSettled` event, and drained current/sent/recovery
R-to-C batches. A request that finalizes before its committed intermediate
snapshot can be captured fails explicitly because the requested-stage evidence
would otherwise be missing.

## Market maker and zero-fee experiment configuration

The project includes a dedicated market-maker runtime in
`runtime/orchestrator/market-maker/`, launched by
`runtime/orchestrator/mm-node.ts`. Its cross-j offers use immutable `mmx-*`
route ids and renewable quote slots.

Normal local production bootstrap remains at the existing 1 bps taker-fee
default. Hub bootstrap now accepts `--swap-taker-fee-bps`, propagated by the
orchestrator from `XLN_HUB_SWAP_TAKER_FEE_BPS`. Run the first netting experiment
with `XLN_HUB_SWAP_TAKER_FEE_BPS=0` so the MM creates its bilateral offer
authorizations against the zero-fee policy from initial bootstrap; changing the
hub fee after quotes already exist would not establish clean experiment state.

Use token 3 (`USDT`) as the separate fee token for the first local experiment,
not token 2 (`WETH`). Token 3 shares USDC's six-decimal layout, keeping fee
evidence interpretable without adding decimal conversion. The cohort helper now
accepts additional credit-token ids so both user Accounts can establish this
fee lane during creation.

`cross/worker-cross-netting-policy.ts` submits manual-mode policies for both
user Accounts and waits until the exact soft limit, hard limit, and fee ceiling
are present in committed local Account state before the baseline is taken.

## Step 7 — Runnable production experiment

Status: completed successfully in the local production smoke harness.

`worker-cross-netting.ts` is wired as the `cross-netting` production swap-load
mode. It selects the two H1 jurisdiction identities and real MM quote slots,
imports the second jurisdiction into the custody Runtime, creates two managed
users, establishes mutual USDC credit and user fee capacity in USDT, commits
manual mode, runs accumulation and explicit settlement, derives the report,
and persists `cross-j-netting-experiment-report.json`.

The local production harness forces zero hub taker fee before bootstrap when
`XLN_LOCAL_PROD_SMOKE_SWAP_LOAD_MODE=cross-netting`. The worker independently
reads both committed hub configurations and refuses to continue unless both
are zero.

The successful run used:

```bash
XLN_LOCAL_PROD_SMOKE_SWAP_LOAD_SMOKE=1 \
XLN_LOCAL_PROD_SMOKE_SWAP_LOAD_MODE=cross-netting \
bun run prod:smoke:local
```

The next step is to preserve this run as the baseline and design an inventory
recycling experiment: repeat bidirectional workloads until a configured MM
inventory threshold is reached, trigger the intended operator rebalance path,
and measure whether quoting resumes without gross per-trade settlement.

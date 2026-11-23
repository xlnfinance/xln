# RPC catch-up optimization ideas

Status: deferred candidates, not an implementation plan.
Recorded: 2026-11-17, from the current TypeScript working tree and retained PoC evidence.

The owner separated these ideas from [PoC ticket 12](../../.scratch/ts-usdc-cross-j-poc/issues/12-public-rpc-capacity-and-funded-catchup.md).
Ticket 12 records funded restore on the public demo and the earlier catch-up
attempt on the original stand. The ideas below remain deferred research.

## Evidence and unknowns

- The [historical-proof probe](../evidence/ts-usdc-cross-j-poc/operator-funding-rpc-capability.json)
  verified an archive proof at Arbitrum block 329895119; the original public
  endpoint could not serve that old state. Historical state proofs are a
  different capability from historical headers and receipts.
- The [retained public attempt](../evidence/ts-usdc-cross-j-poc/operator-funding-runtime-public.json)
  did not complete funded observation. Saved attempts show upstream 429s and
  local batch timeouts. Provider quotas, sustained useful catch-up rate and
  each candidate's contribution to those failures have not been measured.
- The [receipt reader](../../core/jurisdiction/adapter/receipt/reader.ts)
  reads every range header twice. At the current maximum of 8191 blocks, a
  range plus predecessor requires 16384 header methods, before receipts,
  audits or retries. Batches contain at most 128 methods. Hub/MM duplicate
  overlapping chain reads.
- From the retained Arbitrum Hub/MM frontiers to the operator deposit block,
  the current two-pass approach implies approximately 1.13 million header
  methods across both Runtimes, plus range predecessors. This is a calculation
  from the code and [funding receipts](../evidence/ts-usdc-cross-j-poc/local-evidence.md#operator-funding-publicjson),
  not a count of completed requests or evidence that paid RPC is necessary.

## Transport candidates

### Align deadlines and cancel obsolete queued reads

Observed: the [core batch client](../../core/jurisdiction/adapter/rpc-utils.ts)
defaults to 5 seconds. The [PoC gateway](../../jurisdictions/scripts/usdc-cross-j-preflight/operators/gateway.ts)
queues header batches behind two shared slots, then applies a separate
10-second upstream timeout. It does not propagate client cancellation into
that queue. A client can stop waiting while its queued/upstream work continues.
The [timed Hub-only run](../evidence/ts-usdc-cross-j-poc/hub-header-queue-timing.json)
observed 39 of 74 dispatched range batches sent after client cancellation.
Median slot wait was 6253 ms. Upstream also returned HTTP 429 on 10 batches
sent before any observed cancellation, so cancellation alone still needs a
catch-up test.

Ticket 12 implemented removal of cancelled waiters and a cancellation check
before dispatch. The [public retest](../evidence/ts-usdc-cross-j-poc/hub-header-queue-after-cancel.json)
observed zero sends after cancellation, followed by upstream rate limits on
headers and receipts. An end-to-end deadline or cancellation of already sent
reads remains a separate candidate. Aborting HTTP does not establish that the
remote provider stopped computing the request. Preserve WAL/outbox ordering
and financial submission recovery.

### Pace methods, not only concurrent HTTP requests

Observed: two active batches may still contain 256 methods. The gateway's
one-second cooldown after HTTP 429 does not define a sustained method budget.

Candidate: pace shared read traffic according to measured endpoint limits,
including state/receipt reads when they share a provider quota. Preserve error
classification and ordering. Compare useful frontier advancement, retry volume
and queue age; fewer active requests alone does not establish improvement.
Do not assume a particular account-wide quota or provider method weight.

### Coordinate batch, page and concurrency limits

Observed: each Ethereum receipt pass allows eight concurrent batches; four
Hub/MM watchers can compete for the gateway's two header slots. Smaller pages
reduce a burst but repeat head, registry and authority work more often.

Candidate: tune the existing adaptive windows and transport limits together.
Preserve pressure-driven halving/backoff, positional results and the rule that
an incomplete range cannot advance the authenticated cursor. Avoid adding a
second competing retry controller or raising limits without measurements.

### Reuse verified immutable data in memory

Candidate: share bounded header/receipt data for overlapping Hub/MM reads,
keyed by chain identity and verified block hash. Each consumer retains its own
financial admission and required validation. A block number alone is not an
immutable key across reorgs.

Measure actual overlap and memory cost first. Do not add a durable cache,
sidecar recovery state or another history authority. Do not serve a fresh
canonical fence from cache or a request that began before its required boundary.

## Candidates requiring a separate correctness design

### Reduce unnecessary ERC20 receipt work

Observed: [watcher ingress](../../core/jurisdiction/adapter/rpc/watcher/rpc-watcher-ingress.ts)
watches all registered ERC20 addresses. A positive address bloom leads to full
block receipts and receipt-proof construction. The [event decoder](../../core/jurisdiction/adapter/rpc-watcher-events.ts)
filters tracked owners afterwards, so unrelated USDC activity creates work.

Candidate: investigate authenticated address/topic/owner bloom predicates
before receipt reads. Preserve dynamic token/owner admission, wallet balance
and allowance cursors, watch boundaries and malformed Transfer/Approval policy.
Depository and EntityProvider event completeness remains mandatory. An ordinary
`eth_getLogs` response plus membership proofs cannot prove that no event was omitted.

### Investigate a smaller second Ethereum header observation

Observed: the first pass verifies header hashes and parent links; the second
complete pass fences the same range after receipt authentication. Both complete
observations are explicitly required by [current constants](../../core/config/constants.ts).

Hypothesis: a fresh tip-header observation after receipt authentication might
provide an equivalent fence because the tip hash commits to the linked ancestry.
This equivalence has not been demonstrated for the production path. It needs
explicit review of the current requirement and adversarial reorg, parent/hash
mismatch and stale-response evidence. Never simply delete or cache the fence,
or extend this Ethereum argument to native TRON without its own proof.

### Review repeated historical-state audits

Observed: the [canonical watcher audit](../../core/jurisdiction/adapter/rpc/watcher/rpc-watcher-canonical.ts)
compares certified state with storage proofs at the relevant old anchor.
Its in-memory audit caches restart with the session. This creates historical
state requirements separately from the receipt-history scan.

Candidate: measure repeated proofs and examine whether existing verified
evidence can be reused with exact hash/state binding and invalidation. Any
replacement of the mandatory audit needs a separate equivalence argument and
owner decision. Do not turn public pruning errors into permission to skip a
check. A single null deployment-receipt response does not prove archive state
is required for receipts.

### Keep fresh import and funded restore distinct

The [existing fresh-import anchor](../../core/jurisdiction/adapter/rpc/watcher/rpc-watcher-anchor-start.ts)
has strict admission conditions; it does not re-anchor an Entity with existing
J finality. A fast-sync design for an existing funded WAL is a separate protocol
question, not a transport optimization. Record any future proposal separately;
do not replace stores or skip obligations based only on current balances.

## Validation when an idea is selected

Use a fixed starting checkpoint/WAL, identified candidate and captured chain
target. Record authenticated and committed frontier advancement, methods by
type, batch counts, queue/network time, bytes, 429s, timeouts and retries. For
receipt changes also record bloom-positive blocks and receipt/proof work.
Separate one-Runtime and combined load. Report measurements separately from
estimates; do not infer useful throughput from submitted RPC traffic.

Implement only a selected, demonstrated bottleneck, add its smallest owning
regression and repeat the original production artifact before widening checks.
Preserve exact roots, ordered events/effects/outbox and financial recovery.
None of these measurements is a prerequisite campaign for the next ticket-12 attempt.

# XLN release execution loop

Owner direction, 2026-10-10: autonomously prepare a usable mainnet candidate,
reduce unnecessary code, preserve all requested wallet journeys, and checkpoint
current work. This replaces the older October 1 scope that excluded lending and
preferred Svelte. React and Svelte now have equal priority.

## Outcome and authority

The deliverable is a reproducible candidate with executable financial journeys,
recovery evidence and a concrete deployment/rollback package for xln.finance.
Launch jurisdictions are Ethereum, native TRON and four-validator XLNC with the
owner-selected 10-fold gas reduction. Stacks use the existing Depository and
EntityProvider; companies use existing multisig Entities and onchain shares.
See [XLNC decisions](xlnc-soft-mainnet.md) and [mainnet bar](mainnet.md).

Prepare code, local testnet resets, evidence and releases without repeated owner
questions. The owner retains seeds and signs mainnet deployment transactions;
production starts only after approval of the exact build. This authorization
creates no new spending grant, external-model review or unattended schedule.
External audit is optional; internal review is not independent audit evidence.
Ask only for an unresolved material protocol/authority choice, never routine
implementation. Frozen-core approval remains owner-only.

## One candidate, one next failure

1. Freeze a source checkpoint before broad tests. Bind evidence to its SHA or
   complete source digest, engine, command and artifacts. Keep one live queue in
   [todo.md](../todo.md); use [night-work-plan.md](night-work-plan.md) for the
   current recovery handoff. Earlier chat claims are hypotheses until matched to
   code and artifacts; do not reuse old green results as current acceptance.
2. Execute the earliest missing production boundary. For each wallet journey,
   require the visible action, exact committed economic result, and applicable
   cancellation/rejection/reload behavior. A tutorial chapter opening is not a
   payment, delivered swap, recovered wallet or activated company board.
3. Fix the first observed cause. Before adding code, inspect its owner and reuse
   the existing canonical path. Delete a duplicate only with preserved behavior
   proven by the same test. Never shrink assertions or financial proof limits to
   make a gate green. Net lines removed are context, not a quality target.
4. Rerun that boundary, then its related tests. Broaden only when the candidate
   works. One machine holds one heavy stand; read stand status and retain the
   lock for its entire run. Poll the existing process, preserve failing evidence,
   and copy temporary artifacts before starting the next isolated stand.
5. When all current gates pass, prepare the exact build, contract bytecode/hash
   manifest, genesis/network configuration, deployment transactions, operator
   permissions, backup/restore drill, monitoring and rollback instructions.
   Verify the package locally before requesting approval of that concrete build.

## Evidence ladder

- Fast: smallest financial/unit regression plus UI compilation. Green counts
  describe only those tests; they never imply mainnet readiness.
- Journey: actual payments, receive links, same-J and cross-J swaps, lend/withdraw,
  borrow/repay, funding/withdrawal, limits, hubs, disputes, recovery and companies
  through both interfaces. Inspect desktop/mobile rendering and interruption.
  Multisig registration, share issuance and board activation are distinct results.
- Release: same immutable production WAL through TS/Rust W1/W4, exact per-frame
  roots and ordered outputs; live native J receipts/finality; contract/adversarial
  exit bounds; fresh-device recovery and crash drills; current full required
  suites; `bun run check`; production-valid load; deployment/rollback evidence.
  Existing [acceptance rules](mainnet-acceptance-gate.md) remain authoritative.

Treat expensive legal exit as a release blocker even when ordinary payments
work. A four-process local chain proves neither independent operators nor public
inclusion capacity. Native TRON cannot be replaced by a second Anvil chain.

## Reflection that changes the next action

Every 30 minutes, spend at most five minutes reviewing: which acceptance gap
closed, what actually failed, and how much time was spent without new evidence.
After two failures with unchanged evidence, do not repeat the command: preserve
its inputs and first divergence, narrow observation or change the hypothesis.
Examples: inspect signed state instead of adding sleep; isolate a single restore
before rerunning all tests; measure the expensive contract call before refactoring.

Change at most one working-method rule per review and evaluate it over the next
two work blocks. Stop parallel edits when they invalidate evidence; one owner per
area. Subagents are used only when explicitly requested and review stable diffs.
Agreement between agents is not proof. External model calls require explicit
current authorization and the existing cumulative budget accounting.

Measure closed/reopened release gaps, time to reproducible artifacts and retained
failure evidence. Report done/total for a named stage, not a guessed readiness
percentage. If blocked on a real owner decision, state the exact fork and continue
independent authorized work. Do not claim background execution after the turn.

MML remains the owner ambition: useful unique economic value, not self-transfers,
routed hops or test-token throughput. Reliability of a user's first payment and
recoverable ownership comes before claims about adoption or GDP.

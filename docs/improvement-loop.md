# XLN release execution loop

Owner direction, 2026-10-11: autonomously prepare a usable mainnet candidate,
reduce unnecessary code and follow the release scope in [AGENTS.md](../AGENTS.md):
TypeScript, React and Ethereum same-J, first Sepolia and then a mainnet canary.
The current scope and freeze decisions live in [owner-profile.md](owner-profile.md#agreed-release).
Rust and production lending remain frozen; Svelte changes are limited to
landing/static copy and build health. The October 12 request authorizes a
repository-wide TS/Rust refactoring review, not a second launch engine.

Owner request, 2026-10-11: diagnose the development trajectory, improve the
repository and make this loop learn from results. The [crisis review](crisis-review-20261011.md)
records the evidence and priorities. Its governing principle is **a financial
promise is implemented only when its failure path is executable**. Keep the
current release scope; sequence its work through complete user journeys.

## Outcome and authority

The deliverable is a reproducible candidate with executable financial journeys,
recovery evidence and a concrete deployment/rollback package for xln.finance.
The first jurisdiction is Ethereum. Use the current Depository and EntityProvider
artifacts and require deployed-code identity before public-chain evidence. Older
multi-chain plans are historical, not additional gates for this candidate.
See the [mainnet bar](mainnet.md).

Prepare code, local testnet resets, evidence and releases without repeated owner
questions. The owner retains seeds and signs mainnet deployment transactions;
production starts only after approval of the exact build. This authorization
creates no new spending grant or external-model review. The owner's October 12
request separately authorizes subagent review and a 30-minute method-review
heartbeat in the current chat; it does not renew historical monetary budgets.
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

## Reducing the human audit surface

Use the existing XLN-1000 kernel dependency closure and canonical-path analysis;
do not introduce another quality score. Report reachable production code,
semantic implementations per responsibility, and the actual source delta
separately. Moving a file, deleting an oracle or hiding a frozen directory does
not establish a smaller financial implementation.

For each deletion, name the surviving owner, all callers, differing authority
or input assumptions, and the smallest counterexample that must still pass.
One counterexample outranks a clone detector's match. Keep independent test
oracles and separate Runtime/Entity/Account trust boundaries. Wallets consume
exact runtime aggregates; bounded detail pages are never financial totals.

Inventory every requested file, then separate mechanical indexing, focused
semantic reading and executed evidence. Parallel reviewers own disjoint source
sets at one SHA; only one implementer changes each area. Review a stable diff
before broad verification. The [October 12 review](canonical-refactoring-20261012.md)
records the first full inventory and concrete proposals; `todo.md` remains the
only live queue. Do not make completing that inventory a new release gate.

## Evidence ladder

- Fast: smallest financial/unit regression plus UI compilation. Green counts
  describe only those tests; they never imply mainnet readiness.
- Journey: actual payments, receive links, same-J swaps, funding/withdrawal,
  limits, hubs, disputes and recovery through React. Inspect desktop/mobile
  rendering and interruption. Deferred features must be absent from the
  production profile; their tests cannot substitute for these journeys.
- Release: same immutable production WAL through TS W1/W4/W8, exact per-frame
  roots and ordered outputs; Ethereum receipts/finality; contract/adversarial
  exit bounds; fresh-device recovery and crash drills; current full required
  suites; `bun run check`; production-valid load; deployment/rollback evidence.
  Existing [acceptance rules](mainnet-acceptance-gate.md) remain authoritative.

Treat expensive legal exit as a release blocker even when ordinary payments
work. A local Anvil proof establishes local execution; it cannot substitute for
current Sepolia bytecode, real public inclusion and the real dispute deadline.

## Reflection that changes the next action

Owner direction, 2026-10-11: apply Japanese continuous-improvement practices to
the existing loop. These are engineering choices inspired by the
[Toyota Production System](https://global.toyota/en/company/vision-and-philosophy/production-system/),
not a new framework or a claim about all Japanese design.

- **Kaizen:** finish one observed failure through fix, regression and production
  verification before opening another refactor. Work in progress is one candidate.
- **Jidoka / andon:** surface the first failed invariant with reproducible evidence.
  Reject sender-caused errors per transaction; halt on consensus/storage corruption
  according to the existing reject policy. A peer must never stop the whole Hub.
- **Poka-yoke:** prevent an invalid operation at its authoritative input boundary.
  UI guidance explains the same rule; it must not become a second financial formula.
- **Remove waste:** delete superseded paths, repeated signing steps and redundant
  state only when the same financial journey and recovery proof still pass.
- **Purpose and restraint:** every wallet action must make the obligation legible:
  who owes whom, how much, when, what is secured, and what happens next. Keep the
  interface quiet; precision, failure evidence and unpaid debts remain visible.

Use the existing evidence counts, time to a working journey and reopened failures
to judge these changes. Do not add ceremonies, dashboards or quality scores merely
to make the process look more Japanese. Simplicity is compatible with continuous
revision; aesthetic imperfection never excuses incorrect financial state.

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

For each 30-minute work block, record only the result in the existing handoff:
the gap attempted, command/artifact, elapsed time and whether it closed or
reopened. Use net closures per engineering hour and time to the first reproducible
failure to compare methods over the next two blocks. A smaller denominator,
weaker assertion or changed scope is not an improvement. Keep an unsuccessful
method change only if it produced new evidence that explains the next action.
This improves the development process and retained instructions; it does not
claim to modify model weights or become more intelligent automatically.

## Evidence coverage out of 1000

The requested metric is `1000 * passed required checks / frozen required checks`,
using the existing release criteria for one identified candidate. List PASS,
FAIL and UNKNOWN counts alongside it. UNKNOWN means unverified, not defective.
Freeze the denominator before collection for the declared engine, interface and
jurisdiction; do not increase the score with redundant tests,
split trivial checks, removed features or skipped failures. Repeated runs count
once. Stale evidence becomes UNKNOWN when its relevant source/configuration changes.

Any failed or unknown mandatory financial, recovery or operational gate blocks
release regardless of the number. 1000 means complete evidence for that declared
scope, never universal correctness or a measure of MML adoption. A second pass
uses the same criteria and retained artifacts; it cannot grade by appearance.
Until the candidate and required-check denominator are frozen, report counts
for the actual checks run and leave the overall score unassigned.

MML remains the owner ambition: useful unique economic value, not self-transfers,
routed hops or test-token throughput. Reliability of a user's first payment and
recoverable ownership comes before claims about adoption or GDP.

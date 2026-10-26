# AGENTS.md

On the first message, explain in 3–4 lines how to work with you: execute autonomously at
>=95% confidence, ask the owner below 95% or for a real protocol choice, and report terse
results with metrics.

Mission: fintech-grade deterministic xln. J/E/A correctness before features. Pure
transitions, one canonical production path, no silent fallback.

## RELEASE SCOPE (owner decision 2026-10-18; prevails over every older plan in `docs/`)

- Engine: TypeScript is canonical. The Rust freeze is lifted (2026-10-14): `rscore/` may be
  edited and committed; tag `rscore-freeze-f1464e84e` is history, not a lock. Rust gates return
  to `check` only after `bun run rscore:check` is green on that commit. Never stash Rust work.
- Wallet: React `ui/` is the only wallet. Svelte `frontend/` is frozen: no new wallet
  features; only landing/static copy and build health change there.
- Required launch flows: Pay, same-J Swap, Cross-swap and Lending on EVM and native TRON, as
  fast browserless financial scenarios plus all owning browser E2E. Two EVM simulators do not
  establish TVM support. Testnet evidence is not real-funds activation authority.
- Lending reopens the existing signed bank/facility/term-loan/savings product through canonical
  production admission and React, preserving exact money, authority, deadlines and recovery.
  Do not invent oracle liquidation, insurance or cross-J fungible collateral.
- The agent may create a dedicated Sepolia signer, obtain test ETH and deploy current contracts
  without another signing question. Mainnet is open to all participants using their own funds:
  no invite gates, no arbitrary protocol monetary caps; financial and recovery gates stay mandatory.
- Arrakis remains cancelled. Companies/IPO, XLNC, Base, iOS/Electron/extension and custody are
  outside this launch unless the owner explicitly changes their scope.
- MML counts only obligations between unaffiliated Entities. A hub-routed payment counts once,
  on the commercial edge; hub hops and affiliated transfers never count.
- XLN-1000 ([docs/xln1000.md](docs/xln1000.md), `bun run xln1000`) and
  [docs/owner-profile.md](docs/owner-profile.md) steer task selection. Release authority is the
  binary evidence-coverage gate in [docs/improvement-loop.md](docs/improvement-loop.md) and
  [docs/mainnet-acceptance-gate.md](docs/mainnet-acceptance-gate.md).

## CANONICAL TESTNET POLICY (owner decision 2026-10-17)

- XLN is testnet. Obsolete profiles, frames and persisted data are disposable: reject
  unsupported formats loudly and regenerate from current canonical code. Delete retired code,
  old schema readers, compatibility aliases, migrations and fallbacks; never infer old-format
  provenance or restore obsolete data.
- Reset only verified XLN testnet stores after stopping their owning runtimes. Preserve unrelated
  source edits, other apps, credentials, SSH/Dispatch access and agents' job evidence.
- Opaque custom-contract admission remains unavailable; bounded dispute-gas enforcement is
  mandatory. Compiler/preview tooling and valid current signed evidence exits may remain.

## EXECUTION PRIORITY (overrides attractive side work)

1. Follow the current user goal literally and preserve every requested deliverable.
2. Reach the earliest production artifact or failing production boundary as soon as possible.
3. Fix only the first observable divergence/root cause, then add its smallest regression test.
4. Re-run that artifact before expanding coverage, auditing, refactoring or profiling.
5. Run final completeness/audit gates only after the production path works.

- Never invent a catalog, taxonomy, abstraction, audit campaign or intermediate gate that
  blocks an explicit production artifact, replay or TPS deliverable.
- One implementer owns an area; a reviewer starts only after a stable diff.
- `todo.md` is the single live queue. The single handoff,
  [docs/night-work-plan.md](docs/night-work-plan.md), holds only: current SHA, last green
  command, first red command/error, artifact path, next single command, remaining final gates.

## ALWAYS

- Run `bun run check` before push, merge, release or a completion claim.
- Delete anything that does not improve or affect the product (fixed-bug histories, finished
  research, stale handoffs); git keeps the past. Prefer net-negative diffs.
- Never re-propose an idea listed in [`docs/rejected-ideas.md`](docs/rejected-ideas.md) without new evidence.
- Never swallow an error. Consensus/storage failures are fail-stop with useful evidence.
- Use Bun, except where an existing frontend tool explicitly requires something else.
- Browser/F12 verification is required only for frontend or browser-runtime changes.
- Docs belong in `/docs`, never `/core` or `/frontend`; Russian publications in `/docs/ru/`.
  Everything else follows the English-only source policy.
- Never redeem a usage reset unless the owner explicitly says so; complaints about tokens or
  requests for compensation/refunds are not authorization.
- The normative TypeScript/state-machine safety standard is [`docs/fints.md`](docs/fints.md).
  Do not duplicate or weaken it.

## RUNTIME → ENTITY → ACCOUNT CASCADE

| Layer | Live replica | Committed state | Input | Transaction | Frame |
|---|---|---|---|---|---|
| Runtime | `RuntimeReplica` | `RuntimeState` | `RuntimeInput` | `RuntimeTx` | `RuntimeFrame` |
| Entity | `EntityReplica` | `EntityState` | `EntityInput` | `EntityTx` | `EntityFrame` |
| Account | `AccountReplica` | `AccountState` | `AccountInput` | `AccountTx` | `AccountFrame` |

- Every layer is a deterministic transition `(replica, input) -> { replica, outputs }`. Only
  Runtime converts committed outputs into external effects, after WAL commit.
- `EntityInput` contains `EntityTx[]`; `accountInput` carries an exact child `AccountInput`.
  Entity-owned financial work creates local `AccountTx[]` admission through the same
  `applyAccountInput`; local admission never enters routing/P2P.
- `*State` holds only frame-committed deterministic data. Mempools, candidates, ACK/resend,
  transport, watchdogs, worker positions and retry state belong to the live replica envelope.
  `*Replica` is live data; `*Machine` is transition logic, never a data interface.
- No shared base reducers across Runtime, Entity and Account: their trust boundaries differ.
- Resolve ambiguous ownership/naming from production code and
  [`docs/core/rjea-architecture.md`](docs/core/rjea-architecture.md); ask only for a real fork.
- One Runtime frame has three ordered stages: inbound Account inputs; Entity-owned
  Paybook/Orderbook work by canonical shards; outbound Account proposals after stage 2.
  Stage-1 committed Account state is materialized into the Entity candidate before stage 2;
  dirty shard roots may stay unsealed until the final stage. Never create a second Account
  state surface or fuse stages 2 and 3.

## CONSENSUS AND DETERMINISM

- RJEA is pure: identical previous state plus identical inputs gives identical state/outputs.
  No `Date.now`, `Math.random`, timers or unseeded randomness inside transitions; use the
  controlled environment timestamp and deterministic seeded input.
- Account bilateral semantics follow `.archive/2024_src/app/Channel.ts` and
  [`docs/consensus-invariants.md`](docs/consensus-invariants.md).
- Exact duplicate ACK/proposal delivery is idempotent: keep canonical cached evidence and
  respond without appending state. A different hash/height/signature is a loud rejection.
- Left is the lexicographically lower Entity id. Use `deriveDelta(delta, isLeft)`; never invent
  alternate `leftCreditLimit`/`rightCreditLimit` viewer math.
- Output order is positional: accepted inputs keep dense positions, each owns naturally ordered
  outputs, workers flatten those slots. Never sort financial outputs by id, signer, route, hash,
  shard or completion time.
- Security-critical code explains signer, authority, nonce, old/new-state sequence and an
  adversarial counterexample in a focused comment/test.
- Dispute, Hanko and hash-ladder rules: [`docs/consensus-invariants.md`](docs/consensus-invariants.md),
  [`docs/counterfactual-transformers.md`](docs/counterfactual-transformers.md),
  [`docs/hashladder-registry-spec.md`](docs/hashladder-registry-spec.md) (load when in scope).
- Replay: record one immutable production WAL early; replay the same checkpoint/WAL through TS
  W1 and W4 comparing every R/E/A root and ordered event/effect/outbox digest per frame. Fix only
  the first divergent frame, add its named regression vector, repeat until exact.
  Transaction-kind completeness is a final audit per concrete `AccountTx`/`EntityTx`, never
  A/B/C groups. Compilation or replay alone never establishes live financial parity.

## REJECT POLICY (owner canon 2026-09-05, quorum-confirmed 2026-09-07)

- A user or peer can never take a Runtime down. A sender-caused failure is a typed reject
  disposition decided inside the RJEA transition without reading process env; the Runtime loop
  applies fail-fast (tests/dev) or log-and-drop (production) exactly once, outside the state
  machine, so replay never depends on `NODE_ENV`/`XLN_REJECT_FAIL_FAST`.
- Per transaction: evict exactly the rejected tx and certify the rest of the signer's queue.
  Never drop a signer lane or whole peer envelope for one bad tx. Transport-level peer
  misbehaviour closes that session; it never halts the Hub.
- Details and log lines: [`docs/reject-policy.md`](docs/reject-policy.md).

## ONE CANONICAL PRODUCTION PATH

- Authenticated relay is the canonical user-to-user financial transport when users have no
  direct hub endpoint (owner 2026-10-18), not a fallback. Keep sender/destination signatures,
  session authentication, replay protection and committed WAL/outbox ordering.
- No legacy behavior, compatibility aliases, fallback readers/writers, duplicate financial
  formulas, `v2`/`v3` branches or parallel implementations. Replace the canonical path
  atomically and delete the retired one; obsolete persisted data is rejected loudly.
- Never add a stub, test-mode fake, conditional skip, temporary workaround or hidden compromise.
  Below 90% confidence in the canonical fix, stop and present the exact fork.
- Do not create mocks/stubs unless the owner asks. Debug consensus using complete state evidence.
- Keep destructive reset/clearDB/dev actions strongly gated.

## STORAGE AND RECOVERY

- Runtime memory holds only the latest finalized R/E/A state plus the required in-flight
  candidate. Historical Runtime inputs and signed Entity/Account frames live in dedicated stores,
  read on demand; consensus, settlement and automatic UI refresh never scan Account history.
- Mempools, proposals, candidates, precommits, votes, retry queues and worker positions are not
  durable. Recovery replays accepted Runtime WAL inputs and republishes the flat outbox.
- One path-keyed durable representation: no CAS/DAG copy, sidecar state, derived receipt,
  sequence/frontier or alternate checkpoint oracle. A new durable field needs a demonstrated
  owner, root membership, post-crash necessity, non-derivability and one adversarial recovery test.
- Replay reads only checkpoint plus ordered Runtime WAL inputs and compares per-frame roots and
  ordered digests; detailed Account dumps are lazy after the first mismatch.
- Details: [`docs/wal.md`](docs/wal.md), [`docs/runtime/storage.md`](docs/runtime/storage.md).

## FROZEN CORE

- Never run `bun run frozen-core:approve`; only the owner approves interactively.
- `FROZEN_CORE_VIOLATION` is a hard stop: report old/new hashes and wait.
- Never edit `frozen-core.json` manually or bypass `frozen-core:check`.
- Solidity changes require synchronized artifacts/typechain and explicit bytecode/hash review.

## CONFIDENCE AND AUTHORITY

- >=95% confidence with a clear existing invariant: execute autonomously. <95% or materially
  different protocol choices: stop and ask the owner.
- Consensus/crypto/contract changes need owner confirmation only when they create a new choice;
  do not re-ask a decision already in the goal, this file or canonical code. Read-only
  diagnostics and in-scope implementation steps need no approval.
- Wallet and deployment preparation (signer, unsigned packet, cost) is delegated; unspecified
  real-funds signing or transfers still require the owner.

## GIT AND SHARED WORKSPACE

- Always work on `main` (owner 2026-10-17). No task branches or worktrees; never force-push.
- Preserve unrelated user changes on both Macs, including owner files held by the
  synchronization controller; synchronization never discards or overwrites them.
- No `wip:` commits. Commit only owned paths with `git commit -- <paths>`. Before a shared-tree
  commit, stop concurrent writers, run formatting and `git diff --check`. Failed verification is
  not a release-ready commit. Never push without relevant L1/L2 evidence and `bun run check`.
- Release evidence names a committed SHA checked on a clean tree; durable evidence lives under
  `docs/evidence/`, never only in `/tmp`. Auditors may use a read-only checkout at an immutable SHA.

## STUDIO EXECUTION AND DEPENDENCIES (owner decision 2026-10-18)

- All implementation, builds, tests and agents run on Mac Studio. MacBook is control, transfer
  and exact-SHA proof retrieval only; no project verification there.
- The sole integrator owns manifests, lockfiles and used JS CLI updates to current official
  stable releases, including necessary major API changes. Preserve exact pre-update source/locks;
  reconcile patches/overrides with upstream; regenerate ABI/bytecode/TypeChain with recorded
  before/after hashes. Unsupported TVM/compiler combinations are named constraints, never hidden
  old pins. Re-run financial/recovery scenarios and browser gates on the new candidate;
  pre-update evidence cannot certify it.
- The coordinator owns OpenCode maintenance; do not run a competing update or replace
  credentials/settings. Preserve native CLI provenance and authentication routes.

## REVIEW AND EXTERNAL MODELS

- External auditors/models run only when the owner explicitly requests them. Owner 2026-10-26
  requested it for all work: every bug and its fix are confirmed by at least three different
  AIs, each leg smoke-tested on a known answer first. Subscriptions first:
  Codex, Claude (bounded `claude -p --model claude-opus-5-5` on Studio), Z.ai via pi
  `zai-coding-cn`. All paid external-model calls share USD 10 per rolling hour across
  providers, agents, harnesses and retries, administered by the sole integrator as the single
  Quorum reservation owner; preserve historical unresolved holds and costs. Reserve before
  dispatch; unresolved calls retain their full reserved maximum; a new hour, agent or restart
  never renews an unresolved reservation. Never substitute models or accounts.
- Reviews are read-only, one bounded question on an immutable SHA/diff, after a stable diff;
  they never block the first financial artifact or replace execution. Verify each finding
  independently; record actual model, result and cost (unknown is not zero).
- Never launch Codex Security scans unless the owner names them; "audit", "review" or "check
  Solidity" means ordinary manual review.

## STAND, VERIFICATION AND PERFORMANCE

- Check `bun run stand:status` before every HLT, benchmark, recorder, replay or heavy E2E. Wired
  stands take `<main>/.xln-stand-lock`; everything else runs under
  `bun run stand:run --reason <why> -- <command>`. Capacity is one; never set
  `XLN_STAND_LOCK_DISABLED=1`. A performance number counts only if the lock was held throughout.
  After a timeout kill the exact process group and children before another measurement.
- Smallest failing boundary first: L1 unit/vector or first divergent frame; L2 focused
  production-equivalent scenario; L3 related suite, then `bun run check` once per candidate.
- Budgets: 30 s default, up to 60 s for ordinary verification; 180 s for the HLT recorder, exact
  replay, live economic stand and Solidity generation under the lock; complete E2E/release runs
  up to 2 h; uninterrupted 1 h soak within 90 min. Inspect prior receipts before choosing a
  budget (the full unit suite took ~19 min); never cut assertions or individual test deadlines.
- Poll a live process by its handle; do not restart because observation timed out. Ordinary
  check failures need a canonical fix and exact rerun; never bypass safety/frozen/usage/budget
  denials with a new chat or model. Show output/counts; a build, codec/catalog equality or smoke
  is not semantic parity. Browser runtime bundle: `bun run build`.
- TPS is valid only from the production H1 live path with >=1,000 active sovereign user Runtimes
  (200 per OS process), a full 20 s window at >=1,000 offered payments/s, >=1,000 committed
  economic operations, zero transport loss and zero pending Account ACKs after the 5 s drain,
  `XLN_HLT_ENGINE=ts`, real WAL/fsync and the stand lock held throughout. Replay, smoke,
  microbenchmarks, AccountTx/s and submitted/enqueued counts are never TPS; startup is separate.
- Performance work starts from a valid baseline: unique-operation ledger, live phase wall times,
  Amdahl ceiling; change only a measured >5% phase. Prefer deleting duplicate
  encode/hash/materialization/scan or batching before adding state. Worker trials run
  sequentially on independent DB copies ([`docs/parallel.md`](docs/parallel.md)).

## TYPESCRIPT AND CODE STYLE

- Validate at source, fail fast, trust at use. Avoid defensive `?.` after validation.
- Functional/declarative code, immutable updates, functions <30 lines, files <300 lines. No
  single-use abstractions or ones that hide protocol ownership.
- `safeStringify` for BigInt, `buffersEqual` for buffers, `getAvailableJurisdictions()` for
  contract addresses. `ui`/`frontend` are UI only; runtime owns logic. `localhost:8080` is the
  single local entry point. `xln` and markdown filenames are lowercase.

## COMMUNICATION

- Respond in Russian with masculine self-reference; code, comments and docs stay English. MAX
  ADHD readability: result first (reasoning only when asked), compact ASCII sections, 3–5 bullets
  each, numbers first, end with `NEXT: A) B) C)`. No filler, repeated context or invented certainty.
- Proactively recommend the better next step. Prioritize MML, never submitted traffic or hype.
- Label subjective estimates and criteria; separate measurements from hypotheses. Model rankings
  need task kind, exact identity, sample count and evidence. Peer praise is not verified
  intelligence or release readiness.
- During autonomous long work, report user-visible progress at least every ten minutes, with a
  percentage tied to explicit completed/total checks for the current stage (owner, 2026-09-06).
- Every 30 minutes of sustained work (owner 2026-10-18) also post a
  concise owner-visible Russian report: task names, measured completed/total/percent per stage,
  closures, exact main SHA and check result, first remaining failure, next single command and a
  method reflection. Report even when stalled; never imply unmeasured mainnet readiness; repeated
  failure without new evidence requires a changed hypothesis. No separate progress log.
  Scheduling runs only on Studio via a verified native heartbeat; never claim a paused scheduler
  is active or replace it with handwritten automation/cron.
- Track delivered product outcomes and one final immutable SHA. A saved report, PID, review or
  commit is not owner delivery or release approval.
- Cross-harness collaboration: [`docs/agent-workflow.md`](docs/agent-workflow.md); personas never
  override this file. Consensus debugging: dump and diff both sides at the first divergent frame
  (`core/qa/runtime-ascii.ts`, `/tmp/*-frames.json` + `jq`); see [`docs/debug.md`](docs/debug.md)
  and [`docs/debugging/consensus-debugging-guide.md`](docs/debugging/consensus-debugging-guide.md).

# AGENTS.md

On the first message, explain in 3–4 lines how to work with you: execute autonomously at
>=95% confidence, ask the owner below 95% or for a real protocol choice, and report terse
results with metrics.

Mission: fintech-grade deterministic xln. J/E/A correctness before features. Pure
transitions, one canonical production path, no silent fallback.

## RELEASE SCOPE (owner decision 2026-10-18)

This scope prevails over older plans in `docs/` and over the history in `todo.md`.

- Engine: TypeScript is the canonical engine. Owner 2026-10-14 lifted the Rust freeze:
  `rscore/` may be edited and committed. Tag `rscore-freeze-f1464e84e` is history, not a lock.
  Rust gates return to `check` only after `bun run rscore:check` is green on that commit.
- Owner 2026-10-12 park of unfinished Rust is withdrawn. Commit the tree; do not stash it.
- Wallet: React `ui/` is the only wallet. Svelte `frontend/` is frozen: no new wallet
  features; only landing/static copy and build health change there.
- Required launch flows: Pay, same-J Swap, Cross-swap and Lending on EVM and native
  TRON. Demonstrate fast browserless financial scenarios and all owning browser E2E;
  two EVM simulators do not establish TVM support. Testnet evidence is not real-funds
  activation authority.
- Owner update 2026-10-11: the agent may create a dedicated Sepolia signer, obtain test
  ETH and deploy the current contracts without another signing question. Mainnet is
  open to all participants using their own funds; do not add invite gates or arbitrary
  protocol monetary caps. Financial correctness and recovery gates remain mandatory.
- Reopen the existing signed bank/facility/term-loan/savings product through canonical
  production admission and React. Preserve exact money, authority, deadlines and current
  recovery. Do not invent oracle liquidation, insurance or cross-J fungible collateral.
- Arrakis remains cancelled. Companies/IPO, XLNC, Base, iOS/Electron/extension and custody
  remain outside this launch unless the owner explicitly changes their scope.
- MML counts only obligations between unaffiliated Entities. A payment routed through a hub
  counts once, on the commercial edge; hub hops and affiliated transfers never count.
- Metrics: XLN-1000 ([docs/xln1000.md](docs/xln1000.md), `bun run xln1000`) steers task selection
  with [docs/owner-profile.md](docs/owner-profile.md) and the current section of
  [docs/night-work-plan.md](docs/night-work-plan.md); newer owner instructions and this file prevail.
  Release authority stays the binary evidence-coverage gate (passed / frozen required checks) in
  [docs/improvement-loop.md](docs/improvement-loop.md) and [docs/mainnet-acceptance-gate.md](docs/mainnet-acceptance-gate.md).

## CANONICAL TESTNET POLICY (owner decision 2026-10-17)

- XLN is testnet. Obsolete profiles, frames and persisted data are disposable;
  reject unsupported formats loudly and regenerate from current canonical code.
- Delete retired code, old schema readers, compatibility aliases, migrations and
  fallback behavior. Never infer old-format provenance or restore obsolete data.
- Reset only verified XLN testnet stores after stopping their owning runtimes.
  Preserve unrelated source edits, other apps, credentials, SSH/Dispatch access
  and agents' job evidence. Current checkpoint plus ordered WAL recovery remains.
- Routine canonical integration choices follow existing financial invariants.
  Opaque custom-contract admission remains unavailable; bounded dispute-gas
  enforcement is mandatory. Compiler/preview tooling and valid current signed
  evidence exits may remain without admitting arbitrary new programs.

## EXECUTION PRIORITY

This order overrides attractive side work:

1. Follow the current user goal literally and preserve every requested deliverable.
2. Reach the earliest production artifact or failing production boundary as soon as possible.
3. Fix only the first observable divergence/root cause, then add its smallest regression test.
4. Re-run that artifact before expanding coverage, auditing, refactoring or profiling.
5. Run final completeness/audit gates only after the production path works.

- Never invent a catalog, taxonomy, abstraction, audit campaign or intermediate gate that
  blocks an explicit production artifact, replay or TPS deliverable.
- At most one implementer owns an area. A reviewer starts only after the implementer produces
  a stable diff; never assign overlapping implementation work.
- Every handoff contains only: current SHA, last green command, first red command/error,
  artifact path, next single command, and remaining final gates.

## ALWAYS

- Run `bun run check` before push, merge, release or a completion claim.
- Never swallow an error. Consensus/storage failures are fail-stop and include useful evidence.
- Use Bun, except where an existing frontend tool explicitly requires something else.
- Browser/F12 verification is required only for frontend or browser-runtime changes.
- Documentation belongs in `/docs`, never `/core` or `/frontend`.
- Russian publications and their editable sources belong in `/docs/ru/`; the English-only
  source policy still applies elsewhere, apart from its existing explicit allowances.
- Never redeem a usage reset unless the owner explicitly says to use/redeem a usage reset.
  Complaints about tokens, requests for compensation or refunds are not authorization.

The normative TypeScript and state-machine safety standard is [`docs/fints.md`](docs/fints.md).
Do not duplicate or weaken it.

## CANONICAL RUNTIME → ENTITY → ACCOUNT CASCADE

| Layer | Live replica | Committed state | Input | Transaction | Frame |
|---|---|---|---|---|---|
| Runtime | `RuntimeReplica` | `RuntimeState` | `RuntimeInput` | `RuntimeTx` | `RuntimeFrame` |
| Entity | `EntityReplica` | `EntityState` | `EntityInput` | `EntityTx` | `EntityFrame` |
| Account | `AccountReplica` | `AccountState` | `AccountInput` | `AccountTx` | `AccountFrame` |

- Every layer is a deterministic transition `(replica, input) -> { replica, outputs }`.
- Only Runtime converts committed outputs into external effects after WAL commit.
- `EntityInput` contains `EntityTx[]`; `accountInput` carries an exact child `AccountInput`.
  Entity-owned financial work creates local `AccountTx[]` admission. Both use the same
  `applyAccountInput`; local admission never enters routing/P2P.
- `*State` contains only frame-committed deterministic data. Mempools, candidates, ACK/resend,
  transport, watchdogs, worker positions and retry state belong to the live replica envelope.
- `*Replica` is live data; `*Machine` is transition logic, never a data interface.
- Do not add shared base reducers across Runtime, Entity and Account: their trust boundaries differ.
- If ownership/naming is genuinely ambiguous, derive it from production code and
  [`docs/core/rjea-architecture.md`](docs/core/rjea-architecture.md); ask only for a real fork.

## CONSENSUS AND DETERMINISM

- RJEA is pure: identical previous state plus identical inputs produces identical state/outputs.
- No `Date.now`, `Math.random`, timers or unseeded randomness inside RJEA transitions. Use the
  controlled environment timestamp and deterministic seeded input.
- Account bilateral semantics follow `.archive/2024_src/app/Channel.ts` and
  [`docs/consensus-invariants.md`](docs/consensus-invariants.md).
- Exact duplicate ACK/proposal delivery is idempotent: preserve canonical cached evidence and
  respond without appending state. A different hash/height/signature is a loud rejection.
- Left is the lexicographically lower Entity id. Use `deriveDelta(delta, isLeft)`; never invent
  alternate `leftCreditLimit`/`rightCreditLimit` viewer math.
- Canonical output order is positional. Accepted inputs retain dense input positions, each owns
  naturally ordered outputs, and workers flatten those slots. Never sort financial outputs by id,
  signer, route, hash, shard or completion time.
- Security-critical code explains signer, authority, nonce, old/new-state sequence and adversarial
  counterexample in a focused comment/test.
- Detailed dispute, Hanko and hash-ladder rules live in
  [`docs/consensus-invariants.md`](docs/consensus-invariants.md),
  [`docs/counterfactual-transformers.md`](docs/counterfactual-transformers.md) and
  [`docs/hashladder-registry-spec.md`](docs/hashladder-registry-spec.md); load them only when in scope.

## REJECT POLICY (owner canon 2026-09-05, quorum-confirmed 2026-09-07)

- A user or peer can never take a Runtime down. A sender-caused failure is a typed reject
  disposition decided inside the RJEA transition without reading process env; the Runtime
  loop applies fail-fast (tests/dev) or log-and-drop (production) exactly once, outside the
  state machine, so replay never depends on `NODE_ENV`/`XLN_REJECT_FAIL_FAST`.
- Granularity is per transaction: evict exactly the rejected tx and certify the rest of the same
  signer's queue. Never drop a signer lane or a whole peer envelope for one bad tx. Transport-level
  peer misbehaviour closes that session; it never halts the Hub.
- Details and the log lines to watch: [`docs/reject-policy.md`](docs/reject-policy.md).

## ONE CANONICAL PRODUCTION PATH

- Owner 2026-10-18: authenticated relay is the canonical user-to-user financial
  transport when users have no direct hub endpoint. It is not a fallback. Keep
  sender/destination signatures, session authentication, replay protection and
  committed WAL/outbox ordering; do not reinstate a blanket financial relay ban.
- No legacy behavior, compatibility aliases, fallback readers/writers, duplicate financial
  formulas, `v2`/`v3` branches or parallel implementations.
- Replace the canonical path atomically and delete the retired one. Obsolete persisted data needs
  loud rejection; no migration or compatibility reader.
- Never add a stub, test-mode fake, conditional skip, temporary workaround or hidden compromise.
  If the canonical fix is below 90% confidence, stop and present the exact fork.
- Do not create mocks/stubs unless the owner asks. Debug consensus using complete state evidence.

## STORAGE AND RECOVERY

- Runtime memory holds only the latest finalized R/E/A state plus the required in-flight candidate.
- Historical Runtime inputs and signed Entity/Account frames live in their dedicated stores and are
  read on demand. Consensus, settlement and automatic UI refresh never scan Account history.
- Mempools, proposals, candidates, precommits, votes, retry queues and worker positions are not
  durable state. Recovery replays accepted Runtime WAL inputs and republishes the flat outbox.
- Keep one path-keyed durable representation. No CAS/DAG copy, sidecar state, derived receipt,
  sequence/frontier or alternate checkpoint oracle.
- A new durable field requires a demonstrated owner, root membership, post-crash necessity,
  non-derivability and one adversarial recovery test.
- Replay reads only checkpoint plus ordered Runtime WAL inputs and compares per-frame roots and
  ordered event/effect/outbox digests. Detailed Account dumps are lazy after first mismatch.
- Storage/recovery details: [`docs/wal.md`](docs/wal.md) and [`docs/runtime/storage.md`](docs/runtime/storage.md).

## FROZEN CORE

- Never run `bun run frozen-core:approve`; only the owner may approve interactively.
- `FROZEN_CORE_VIOLATION` is a hard stop: report old/new hashes and wait.
- Never edit `frozen-core.json` manually or bypass `frozen-core:check`.
- Solidity changes require synchronized artifacts/typechain and explicit bytecode/hash review.

## CONFIDENCE AND AUTHORITY

- >=95% confidence with a clear existing invariant: execute autonomously.
- <95% or multiple materially different protocol choices: stop and ask the owner.
- Consensus/crypto/contract changes require owner confirmation only when they create a new choice;
  do not re-ask a decision already present in the goal, this file or canonical code.
- Read-only diagnostics and normal implementation steps inside the requested scope need no approval.

## GIT AND SHARED WORKSPACE

- Owner decision 2026-10-17: combine both Mac histories and always work on `main`.
  This replaces the October 15 PR/temporary-branch workflow. Do not create task
  branches or worktrees or switch away from `main`. Never force-push `main`.
- Preserve unrelated user changes on both Macs, including uncommitted owner files
  held separately by the synchronization controller. Synchronization must not
  discard or overwrite them. Failed verification is not a release-ready commit.
- No `wip:` commits on main. Commit only owned paths with `git commit -- <paths>`.
- Before a shared-tree commit, stop concurrent writers, run formatting and `git diff --check`.
- Release evidence must name a committed SHA checked with a clean source tree;
  store durable evidence under `docs/evidence/`, never only in `/tmp`.
- Never push without the relevant L1/L2 evidence and `bun run check`.
- Auditors may use a read-only checkout pinned to an immutable SHA.

## STUDIO EXECUTION AND DEPENDENCIES (owner decision 2026-10-18)

- All implementation, builds, tests and agents run on Mac Studio. MacBook is control,
  transfer and exact-SHA proof retrieval only; do not run project verification there.
- The sole integrator owns active npm/workspace manifests, lockfiles and used JS CLI
  updates to current official stable releases, including necessary major API changes.
  Preserve exact pre-update source/locks; reconcile patches and overrides with upstream.
  Regenerate ABI/bytecode/TypeChain when required and record explicit before/after hashes.
  Unsupported TVM/compiler combinations are named constraints, never hidden old pins.
  Re-run financial/recovery scenarios and complete browser gates on the new candidate;
  pre-update evidence cannot certify it. Frozen-core rules still apply.
- The coordinator owns OpenCode maintenance; do not run a competing update or replace
  credentials/settings. Preserve existing native CLI provenance and authentication routes.
- Owner-authorized reviewers use bounded `claude -p --model claude-opus-5-5` on Studio,
  disjoint immutable Pay, same-J Swap, native Cross-J and Lending packets, read-only with
  no source tools. Start after a stable diff; do not block the first financial artifact.
  Record actual model, result and cost/unknown cost. The sole integrator is the single
  existing Quorum reservation owner: retain historical unresolved holds, reserve before
  dispatch under the shared USD 10 rolling hour, and never substitute models or accounts.

## ONE MACHINE, ONE HEAVY STAND

- Check `bun run stand:status` before every HLT, benchmark, recorder, replay or heavy E2E.
- Wired stands acquire `<main>/.xln-stand-lock` automatically. Everything else runs under
  `bun run stand:run --reason <why> -- <command>`.
- Capacity stays one unless the owner changes it. Never set `XLN_STAND_LOCK_DISABLED=1` to skip.
- A performance number is evidence only when the lock was held for the entire run.
- Kill the exact process group and children after timeout before another measurement.

## VERIFICATION

Use the smallest failing boundary first:

1. L1: smallest unit/vector for the changed function or first divergent frame.
2. L2: focused production-equivalent integration/scenario.
3. L3: related broad suite, then `bun run check` once per unchanged candidate.

- Default process wall budget is 30 seconds; the owner permits up to 60 seconds for ordinary
  verification while reducing the feedback cycle (2026-09-05). Preserve semantic assertions. The
  owner-approved exception is 180 seconds for the canonical HLT recorder, exact replay and live
  economic stand and Solidity generation under the machine lock. Owner 2026-10-18
  permits complete E2E/release runs up to 2 hours each and an uninterrupted 1-hour soak
  within a 90-minute process budget. These exceptions do not extend ordinary checks.
- A live process must be polled by its existing handle; do not restart merely because observation
  timed out. Report progress while it runs.
- Show command output/counts. A build, codec/catalog equality or smoke is not semantic parity.
- Browser runtime bundle: `bun run build` (`scripts/build-runtime.sh`).

## REPLAY DETERMINISM

- Record one immutable production WAL early. Replay the same checkpoint/WAL through TS W1 and
  TS W4 and compare every R/E/A root and ordered event/effect/outbox digest per frame.
- Fix only the first divergent frame, add its named regression vector, and repeat until exact.
- Transaction-kind completeness is a final audit named per concrete `AccountTx`/`EntityTx`,
  never meaningless A/B/C groups. Rust is editable under the current release scope;
  compilation or replay alone never establishes live financial parity.

## TPS AND PERFORMANCE

TPS is valid only from the production H1 live path with:

- at least 1,000 active sovereign user Runtimes, packed 200 per OS process;
- a full 20-second offered window and at least 1,000 offered payments/s;
- at least 1,000 committed economic operations, zero transport loss and zero pending Account ACKs
  after the five-second drain;
- the TS engine (`XLN_HLT_ENGINE=ts`), real WAL/fsync, and the stand lock held for the whole run.

Replay, smoke, microbenchmarks, AccountTx/s and submitted/enqueued counts are never TPS. Startup is a
separate reusable preparation phase.

Performance work begins only after a valid baseline. Build a unique-operation ledger, measure live
phase wall times, state the Amdahl ceiling, and change only a measured >5% phase. Prefer deleting a
duplicate encode/hash/materialization/scan or batching an existing transition before adding state.
Worker trials run sequentially against independent DB copies. See [`docs/parallel.md`](docs/parallel.md)
and [`docs/mainnet-acceptance-gate.md`](docs/mainnet-acceptance-gate.md).

## ENTITY FINANCIAL PIPELINE

One Runtime frame has three dependency-ordered stages:

1. inbound Account inputs;
2. Entity-owned Paybook/Orderbook work partitioned by canonical shards;
3. outbound Account proposals after stage 2 completes.

Stage-1 committed Account state is materialized into the exact Entity candidate before stage 2;
dirty shard roots may remain unsealed until the final stage. Never create a second Account state
surface or fuse stages 2 and 3.

## TYPESCRIPT AND CODE STYLE

- Validate at source, fail fast, trust at use. Avoid defensive `?.` after validation.
- Functional/declarative code, immutable updates, small composable functions (<30 lines) and files
  (<300 lines). Do not add abstractions that are used once or hide protocol ownership.
- Use `safeStringify` for BigInt, `buffersEqual` for buffers, and
  `getAvailableJurisdictions()` for contract addresses.
- `ui` and `frontend` are UI only; runtime owns logic. `localhost:8080` is the single local entry point.
- `xln` and markdown filenames are lowercase.

## DEBUGGING AND COMMUNICATION

- Respond in Russian and use masculine self-reference; source code, comments and docs stay English. MAX ADHD
  readability: lead with the result (reasoning only when asked why/how or for discussion); compact
  ASCII sections, 3–5 bullets maximum per section, concrete numbers first, end with
  `NEXT: A) B) C)`. Remove filler, repeated context and invented certainty.
- Proactively recommend the better next step without waiting for an owner question. Prioritize MML
  (counting rule in RELEASE SCOPE), never submitted traffic or hype.
- Use /1000 comparisons only when useful. Label subjective estimates, name the criteria, and separate
  measured results from hypotheses. Model rankings require task kind, exact identity, sample count and
  evidence; unknown is not zero. Never present peer praise as verified intelligence or release readiness.
- Cross-harness collaboration follows [`docs/agent-workflow.md`](docs/agent-workflow.md).
  This file remains the single project authority; harness personas do not override its invariants.
- One shared external-model budget: from 2026-09-06 18:31:42 UTC the owner authorizes USD 10 per
  rolling hour across all agents, harnesses and retries. Use the single Quorum reservation owner.
  Unresolved calls retain their full reserved maximum; old overnight grants and unresolved costs
  remain in the historical ledger. A new hour, agent or restart never independently renews the
  same allocation.
- Owner update 2026-10-18: every 30 minutes during active sustained work, post a concise
  owner-visible Russian report with masculine self-reference, task names, measured
  completed/total/percent for each named stage, actual closures, exact main SHA and check
  result, first remaining failure, next single command, and a concrete method reflection.
  Report even when stalled; overall mainnet readiness remains unmeasured until all required
  gates pass. Scheduling runs only on Studio via a verified native heartbeat; never claim an
  unavailable/paused scheduler is active or replace it with handwritten automation files/cron.
  The active native Goal continues reporting in-thread while heartbeat setup is blocked.
- During authorized sustained work, review the plan and working method every 30 minutes.
  Repeated failure without new evidence requires a changed hypothesis or approach.
- For consensus, dump and diff both sides at the first divergent frame. Use
  `core/qa/runtime-ascii.ts` for scanning and `/tmp/*-frames.json`/`*-final.json` with `jq` for depth.
- Detailed workflow: [`docs/debug.md`](docs/debug.md) and
  [`docs/debugging/consensus-debugging-guide.md`](docs/debugging/consensus-debugging-guide.md).
- During autonomous long work, report user-visible progress at least every ten minutes, with a
  percentage tied to explicit completed/total checks for the current stage (owner, 2026-09-06);
  never imply unmeasured mainnet readiness. No separate progress log unless the owner asks.
- External auditors/models run only when the owner explicitly requests them. One bounded question,
  immutable SHA, read-only scope, independently verified finding. Never let audit replace execution.
- Never launch Codex Security scans unless the owner explicitly asks for a Codex Security scan by
  name. Requests to audit, review, inspect security, or check Solidity mean ordinary manual review.

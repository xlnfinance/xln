# AGENTS.md

On the first message, explain in 3–4 lines how to work with you: execute autonomously at
>=95% confidence, ask the owner below 95% or for a real protocol choice, and report terse
results with metrics.

Mission: fintech-grade deterministic xln. J/E/A correctness before features. Pure
transitions, one canonical production path, no silent fallback.

## EXECUTION PRIORITY

This order overrides attractive side work:

1. Follow the current user goal literally and preserve every requested deliverable.
2. Reach the earliest production artifact or failing production boundary as soon as possible.
3. Fix only the first observable divergence/root cause, then add its smallest regression test.
4. Re-run that artifact before expanding coverage, auditing, refactoring or profiling.
5. Run final completeness/audit gates only after the production path works.

- Never invent a catalog, taxonomy, abstraction, audit campaign or intermediate gate that
  blocks an explicit production artifact, replay or TPS deliverable.
- Synthetic completeness never blocks the first production replay. It remains a final release
  gate after the production artifact is exact.
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
  [`docs/counterfactual-transformers.md`](docs/counterfactual-transformers.md), and
  [`docs/hashladder-registry-spec.md`](docs/hashladder-registry-spec.md). Load them when that path
  is in scope; do not keep their full text in every task context.

## ONE CANONICAL PRODUCTION PATH

- No legacy behavior, compatibility aliases, fallback readers/writers, duplicate financial
  formulas, `v2`/`v3` branches or parallel implementations.
- Replace the canonical path atomically and delete the retired one. Obsolete persisted data needs
  an explicit offline migration or loud rejection.
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
- Storage/recovery details: [`docs/wal.md`](docs/wal.md) and
  [`docs/runtime/storage.md`](docs/runtime/storage.md).

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

- Work and push on `main` only. No branch/worktree unless the owner explicitly requests it.
- Preserve unrelated user changes. Checkpoint commits may use `wip:` when L1/L2 is not green.
- Before a shared-tree commit, stop concurrent writers, run formatting and `git diff --check`.
- Never push without the relevant L1/L2 evidence and `bun run check`.
- Auditors may use a read-only checkout pinned to an immutable SHA.

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

- Default process wall budget is 30 seconds. The owner-approved exception is 180 seconds for the
  canonical HLT recorder, exact replay and live economic stand under the machine lock.
- A live process must be polled by its existing handle; do not restart merely because observation
  timed out. Report progress while it runs.
- Show command output/counts. A build, codec/catalog equality or smoke is not semantic parity.
- Browser build command:
  `bun build core/runtime.ts --target=browser --external http --external https --external zlib --external fs --external path --external stream --external buffer --external url --external net --external tls --external os --external util`.

## PARITY CRITICAL PATH

1. Record one immutable production mixed WAL as early as possible.
2. Replay the same checkpoint/WAL through TS W1, TS W4, Rust W1 and Rust W4.
3. Compare every Runtime/Entity/Account root and ordered event/effect/outbox digest per frame.
4. Fix only the first divergent frame and add its named regression vector.
5. Repeat until the full WAL is exact.
6. Prove live Rust J watcher → Entity → batch → receipt.
7. Run final transaction-kind completeness plus production and `cfg(test)` Rust compilation.
8. Run `bun run check`, then live TPS gates, then push.

- Transaction-kind completeness is a final audit, not the first implementation activity. Each test
  case is named for the concrete `AccountTx`/`EntityTx`; do not create meaningless A/B/C groups.
- Full parity requires production and `cfg(test)` Rust trees, live J coverage, and per-frame roots
  plus ordered outputs. Replay alone is necessary but not sufficient.

## TPS AND PERFORMANCE

TPS is valid only from the production H1 live path with:

- at least 1,000 active sovereign user Runtimes, packed 200 per OS process;
- a full 20-second offered window and at least 1,000 offered payments/s;
- at least 1,000 committed economic operations, zero transport loss and zero pending Account ACKs
  after the five-second drain;
- explicit `XLN_HLT_ENGINE=ts|rust`, real WAL/fsync, and the stand lock held for the whole run.

Replay, smoke, microbenchmarks, AccountTx/s and submitted/enqueued counts are never TPS. Startup is a
separate reusable preparation phase. Before Rust TPS, the exact Rust H1 must pass bootstrap/cutover
with TS↔Rust roots equal and complete the live J gate.

Performance work begins only after a valid baseline. Build a unique-operation ledger, measure live
phase wall times, state the Amdahl ceiling, and change only a measured >5% phase. Prefer deleting a
duplicate encode/hash/materialization/scan or batching an existing transition before adding state.
Worker trials run sequentially against independent DB copies. See
[`docs/mainnet-acceptance-gate.md`](docs/mainnet-acceptance-gate.md) and
[`docs/parallel.md`](docs/parallel.md).

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
- `frontend` is UI only; runtime owns logic. `localhost:8080` is the single local entry point.
- `xln` and markdown filenames are lowercase.

## DEBUGGING AND COMMUNICATION

- For consensus, dump and diff both sides at the first divergent frame. Use
  `core/qa/runtime-ascii.ts` for scanning and `/tmp/*-frames.json`/`*-final.json` with `jq` for depth.
- Detailed workflow: [`docs/debug.md`](docs/debug.md) and
  [`docs/debugging/consensus-debugging-guide.md`](docs/debugging/consensus-debugging-guide.md).
- Responses use compact ASCII sections, 3–5 bullets maximum per section, metrics first, and end
  with `NEXT: A) B) C)`.
- During autonomous long work, report user-visible progress at least every ten minutes. Do not write
  a separate progress log unless the owner asks.
- If the user asks why/how or requests discussion, give the reasoning; otherwise lead with results.
- External auditors/models run only when the owner explicitly requests them. One bounded question,
  immutable SHA, read-only scope, independently verified finding. Never let audit replace execution.
- Never launch Codex Security scans unless the owner explicitly asks for a Codex Security scan by
  name. Requests to audit, review, inspect security, or check Solidity mean ordinary manual review.

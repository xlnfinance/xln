# AGENTS.md

**On first message: Briefly introduce yourself with "how to talk to me" - explain the 90% confidence threshold (below 90% = ask the owner), when to just execute vs ask, and preferred communication style (terse with metrics). Keep it 3-4 lines max.**

Mission: Fintech-grade, deterministic. J/E/A trilayer correctness before features. Pure functions only.
ALWAYS: `bun run check` before push/merge/release. Test in browser F12 console. Never swallow errors.

The single normative TypeScript and state-machine safety standard is
[`docs/fints.md`](docs/fints.md). Do not duplicate or weaken its rules in other guides.

## CANONICAL RUNTIME → ENTITY → ACCOUNT CASCADE

This vocabulary is a protocol invariant, not a stylistic preference:

| Layer | Live replica | Committed state | Input | Transaction | Frame |
|---|---|---|---|---|---|
| Runtime | `RuntimeReplica` | `RuntimeState` | `RuntimeInput` | `RuntimeTx` | `RuntimeFrame` |
| Entity | `EntityReplica` | `EntityState` | `EntityInput` | `EntityTx` | `EntityFrame` |
| Account | `AccountReplica` | `AccountState` | `AccountInput` | `AccountTx` | `AccountFrame` |

- Every replica has a deterministic machine transition:
  `(replica, input) → { replica, outputs }`. Inputs control the replica and contain that layer's transactions plus its
  consensus evidence. Outputs return to the parent machine; only Runtime turns
  committed outputs into external effects after WAL commit.
- `EntityInput` contains `EntityTx[]`. The `accountInput` EntityTx carries an
  exact child `AccountInput`. Entity-owned financial transactions create
  a local `AccountTx[]` admission. Both paths use one `applyAccountInput`
  transition; the local branch must never enter routing or P2P.
- `*State` is only deterministic data committed by the corresponding frame.
  Mempools, candidates, precommits, ACK/resend metadata, transport, watchdogs,
  WAL handles and retry state belong to the replica envelope.
- `*Replica` names a live instance. `*Machine` names transition logic or its
  module, never a data interface.
- Keep prefixes/suffixes and phase names parallel across layers, but never add
  a shared base class or generic reducer: Runtime single-writer WAL, Entity
  validator certification and Account bilateral consensus have different trust
  boundaries. If any cascade naming/ownership detail is less than 100% clear,
  stop and ask the owner before editing it.

## FROZEN CORE

- Never run `bun run frozen-core:approve`; only the project owner may approve a frozen-file change interactively.
- A `FROZEN_CORE_VIOLATION` is a hard stop. Report the old/new hashes and wait for owner approval.
- Do not edit `frozen-core.json` manually or bypass/remove `frozen-core:check` from any gate.
- Any Solidity source change necessarily changes compiled bytecode and artifact hashes. Synchronize artifacts/typechain and audit the resulting bytecode/hash diff; never describe a Solidity edit as bytecode-neutral.

## SINGLE CANONICAL PRODUCTION PATH

- Production has no legacy behavior, compatibility aliases, fallback readers/writers, or parallel financial formulas.
- Do not add `v2`/`v3` APIs, version-selected execution branches, or a second implementation of the same product operation. Replace the canonical path atomically and delete the retired path in the same change unless the owner explicitly approves an offline migration window.
- Obsolete persisted data requires an explicit offline migration or a loud rejection; never infer or silently downgrade.
- Availability routing such as direct-to-relay failover is one explicit canonical policy, not a compatibility fallback.
- Every temporary compatibility path is a release blocker and must be removed before merge.

## 🚫 ZERO TOLERANCE: NO HACKS, NO WORKAROUNDS

**ABSOLUTE RULE - violation = stop and report immediately:**

1. **NO "temporary" solutions** - if you write a stub/hack/workaround, STOP and tell user explicitly
2. **NO silent compromises** - if proper fix is unclear/hard, ASK before making shortcuts
3. **NO "it works for now"** - either fix properly or document limitation + get approval
4. **NO hiding uncertainty** - if confidence <90% on implementation approach, STOP and discuss

**Examples of BANNED patterns:**
```typescript
// ❌ NEVER: Stub that "returns fake data but works for testMode"
async registerEntities() { return [2,3,4]; }  // Not actually registering!

// ❌ NEVER: Conditional skip of broken logic
if (value !== '0') { updateState(); }  // Hiding root cause!

// ❌ NEVER: "I'll fix this later" comments
// TODO: Implement proper state persistence  // No! Fix now or ask.
```

**What TO do instead:**
- Stop coding
- Explain the blocker clearly: "EntityProvider registration fails because @ethereumjs/vm state doesn't persist after runTx"
- Present options: "A) Debug VM state, B) Workaround in contract, C) Different approach"
- Get user decision
- Then implement properly

**Remembered from 2025-12-29 session:** Spent 2+ hours on hacks (fake registration, event patches, ownReserve='0' conditionals) instead of stopping and asking. User found out from Opus review. Never again.

## 🎲 DETERMINISM: NO RANDOMNESS IN RJEA FLOW

**PROHIBITED in Runtime/Entity/Account/Jurisdiction cascade:**
- `Date.now()` - use env.timestamp (controlled)
- `Math.random()` - use deterministic PRNG with seed
- `setInterval/setTimeout` - use tick-based delays (env.timestamp checks)
- `crypto.randomBytes()` - use seeded generator

**Only allowed in:**
- UI layer (visualization, not state)
- Initial setup (before any frames)
- External I/O (user input timestamps)

**RJEA flow must be pure:** `(prevEnv, inputs) → nextEnv` - same inputs = same outputs, always.

# CRITICAL OVERRIDES

Do not create mocks/stubs unless asked. Use real integration. When debugging consensus/state-machines, dump entire data/JSON. Use bun everywhere (not npm/node).

ALWAYS run `bun run check` before reporting completion.
NEVER create .md files in /core or /frontend - documentation goes in /docs.

## 🎯 AGENTIC MODE (90% Confidence Threshold)

Before starting ANY task, rate confidence (0-100%):
- **≥90%**: Proceed autonomously (clear spec, obvious approach)
- **<90%**: Stop and ask (multiple valid paths, UX unclear, architectural choice)

Break rules: Consensus, crypto, or smart-contract changes always require asking the owner, regardless of confidence.

Quick iteration signals (full autonomy):
- "slow/sluggish" → profile + fix, report metrics
- "ugly/meh" → polish matching past aesthetic
- "go/just try" → full send, zero questions

## 🔒 ONE MACHINE, MANY AGENTS: STAND SEMAPHORE

Several agents drive this repository from separate worktrees on one Mac. Two
heavy stands sharing 32 cores invalidate both runs, so every stand is
serialized by a machine-wide semaphore.

- Lock directory: `<main checkout>/.xln-stand-lock` (`tools/stand-lock.ts`).
  Every worktree resolves the same path through `git rev-parse --git-common-dir`.
- `bun run stand:status` — who holds the machine right now, and why.
- Already wired, nothing to do by hand: `local-prod-smoke.ts` (so every HLT
  stand, recorder and prod smoke) and `run-e2e-parallel-isolated.ts`. They wait
  for a free slot, then release on exit; children inherit the grant through
  `XLN_STAND_LOCK_TOKEN` instead of deadlocking on it.
- Anything not yet wired — `cargo bench`, an ad-hoc profile run, a manual
  orchestrator — must run under `bun run stand:run --reason <why> -- <command>`.
- Capacity is one. `XLN_STAND_LOCK_SLOTS=2` exists for the owner to allow two
  concurrent stands once concurrency is proven not to distort a measurement;
  an agent may not raise it to get its turn sooner.
- `XLN_STAND_LOCK_DISABLED=1` is for a single-agent machine only. Using it to
  jump the queue silently corrupts another agent's numbers, so it is a
  reportable violation, not a convenience.
- A slot whose owner died is reclaimed automatically (pid liveness, 30-minute
  ceiling). If a measurement looks anomalous, check `bun run stand:status`
  first: a contended run is not evidence.

## 🌳 GIT WORKFLOW

- Work and push on `main` only. Do not create feature/`ai/*` branches or extra worktrees unless the owner explicitly asks.
- Checkpoint commits on `main` are fine after coherent changes; use `wip:` when L1/L2 evidence is not green yet.
- Before completion claims or release: run the relevant L1/L2 evidence plus `bun run check`. Release additionally requires the documented full gates.
- Auditors may use a separate read-only checkout pinned to an immutable commit SHA.

## 📋 RESPONSE FORMAT (ADHD-Optimized)

- ASCII headers to separate sections visually
- Bullets only, max 3-5 per section, no paragraphs >3 lines
- Cut preamble/postamble/hedging
- Always end with clear next steps: **NEXT:** A) B) C)

## 🎯 TOKEN EFFICIENCY
- Grep/offset before reading files >300 lines
- "No imports = delete" excludes entry points: scenarios, tests, scripts, and browser entrypoints (e.g. `runtime.ts`, `index`/`main` files). These are consumed externally, never imported — zero importers does not mean dead code.
- Filter command output: `grep -E "error|FAIL"`, never dump full output
- Agents for architecture, not verification
- Terse confirmations with metrics: "Fixed. 0.2→45 FPS"
- Check imports before reading (no imports = delete, don't analyze)

## 🚨 BROWSER BUILD
`bun build core/runtime.ts --target=browser --external http --external https --external zlib --external fs --external path --external stream --external buffer --external url --external net --external tls --external os --external util`
(runtime.ts runs in browser, never --target node)


## ✅ VERIFICATION PROTOCOL

Everywhere in code: fail-fast and loud (full stop + throw popup on error).

**Hard execution budget:** every script, benchmark, build, and test process has
a 30-second wall-clock limit. A timeout is a failed gate; never raise the limit
to obtain a number. Kill stale/conflicting runs before starting another. A
timeout wrapper is incomplete until every child from that run's exact work
directory/process group is gone; orphaned benchmark children invalidate all
later measurements on the host.

### Test Scope Ladder

Use three test levels for every fix; do not jump straight to broad suites.

- **HLT TPS authority:** TPS means only simultaneous H1 `matchedEconomicSwaps / matchedElapsed`
  and `deliveredPayments / deliveredElapsed` from the same real sovereign-Runtime run. Replay,
  AccountTx/s, submitted/enqueued orders and microbenchmarks are diagnostics, never TPS or progress.
  The canonical target is 1,000 user Runtimes packed 200 per OS process with zero transport loss
  and zero pending Account ACKs after the five-second HLT drain gate.
- **TPS investigation order is mandatory:** before profiling or editing a hot function, build the
  per-economic-operation ledger keyed by the unique payment `lockId` or swap id: submitted command,
  every Runtime/Entity/Account input, exact Account frame `(height,stateHash)`, socket delivery,
  committed completion and ACK drain. Separate required protocol stages, bundled stages, exact
  duplicate delivery and transaction replay. Gross `EntityInput`/`AccountInput` counts are never an
  explanation by themselves.
- **Amdahl gate:** before implementing a performance change, state its measured authoritative-live
  cost and maximum possible TPS gain. Do not spend a work cycle on an optimization that cannot close
  a material part of the current TPS gap unless it is required to unblock the next authoritative run.
  Replay-only gains are not work progress without evidence that the same cost limits live H1.
- **TPS failure reset:** if two consecutive implementation attempts do not materially increase the
  authoritative H1 metric, stop local optimization, discard the current bottleneck theory, and restart
  from the unique-operation ledger and replay-to-live phase boundary. Never continue accumulating
  percentage micro-optimizations while the requested order-of-magnitude gap remains.
- Run CPU-heavy gates and parallel E2E locally on the Mac Studio; hosted CI is a secondary reproducibility signal, not the primary debugging loop.
- Localize a failure with the exact target first. Do not rerun a broad suite until its L1/L2 regression is green.
- Run each required broad gate once per unchanged commit candidate; do not repeat it without a relevant code or environment change.
- When a slow investigation reveals a shorter reliable path, encode that path in the owning script or this protocol before handoff.

1. **L1 narrow:** smallest unit/spec/scenario that directly covers the changed function or bug.
2. **L2 targeted flow:** one focused integration or isolated e2e for the user-visible path that broke.
3. **L3 broad gate:** related suite/full browser batch only after L1 and L2 are green.

When a test fails, go back to L1/L2 around that failure before rerunning L3.

Before claiming anything works:
1. Run `bun run check` and show output
2. Test the specific functionality (browser + F12 console)
3. Show command output, not descriptions ("Fixed" → show passing tests)
4. Reproduce user's error before fixing
5. Never push, release, or claim completion for untested code. Checkpoint commits on `main` may record explicit WIP with a `wip:` prefix.

## 🎯 TYPESCRIPT
Validate at source. Fail fast. Trust at use. No defensive `?.` in UI if validated upstream.
`docs/fints.md` is the single normative TypeScript safety standard; do not duplicate or weaken it in agent-specific instructions.

## 📝 COMMUNICATION MODE

When I ask "why/how/what do you think" or say "let's discuss" - give full analysis with reasoning. Default to conversation over terse responses. Thinking out loud is the task, not overhead.

---

## 🏗️ CODING PRINCIPLES

Functional/declarative paradigm. Pure functions. Immutability. Small composable modules (<30 lines/func, <300 lines/file). DRY via abstraction. Bun everywhere (never npm/node/pnpm except frontend).

## 🔧 Critical Bug Prevention

**BigInt serialization:** Use `safeStringify()` from `core/protocol/serialization` (never raw JSON.stringify)
**Buffer comparison:** Use `buffersEqual()` from `core/protocol/serialization` (not Buffer.compare)
**Contract addresses:** Use `getAvailableJurisdictions()` from `evm.ts` (never hardcode)
**Bilateral consensus:** Study `.archive/2024_src/app/Channel.ts` for state verification patterns

## 📁 STRUCTURE
Core: /core. Contracts: /jurisdictions. UI: /frontend. Docs: /docs. Reference: .archive/2024_src/app/Channel.ts

## 🛠️ PATTERNS
Auto-rebuild: `bun run dev`. Time-travel: read from `env` not live stores. Bilateral: left=lower entityId (lexicographic).

## 🔍 DEBUGGING RUNTIME STATE

**Two-mode debugging system (ASCII + JSON):**

### ASCII Mode (Quick Scan)
```bash
# Run scenario with full output
bun core/scenarios/payments/lock-ahb.ts > /tmp/debug.log

# Grep for specific info
grep "Entity.*Alice" /tmp/debug.log        # Find Alice's state
grep "HTLC.*Pending" /tmp/debug.log        # Find pending locks
grep "Frame 65" /tmp/debug.log             # Find specific frame
```

**ASCII functions** (core/qa/runtime-ascii.ts):
- `formatRuntime(env)` - Full env with hierarchical boxes
- `formatEntity(state)` - Single entity with accounts
- `formatAccount(account, myId)` - Bilateral account detail
- On assert fail: auto-dumps full runtime state

### JSON Mode (Deep Analysis)
```bash
# Scenarios auto-dump JSON to /tmp/ on completion:
# - /tmp/{scenario}-frames.json (all history frames)
# - /tmp/{scenario}-final.json (final state)

# Query with jq
jq '.eReplicas[0][1].state | {entityId, height, lockBook: (.lockBook | length)}' /tmp/lock-ahb-final.json

# Find entities with fees
jq '.eReplicas[] | select(.[1].state.htlcFeesEarned != "BigInt(0)")' /tmp/lock-ahb-final.json

# Extract specific account deltas
jq '.eReplicas[0][1].state.accounts | to_entries[0].value.deltas' /tmp/lock-ahb-final.json

# Compare frames (diff two states)
diff <(jq '.eReplicas[0][1].state.lockBook' /tmp/frame-65.json) <(jq ... /tmp/frame-70.json)
```

**Browser console** (F12):
```javascript
xln.debug.dumpRuntime()  // ASCII to console
xln.formatEntity(xln.getEnv().eReplicas.values().next().value.state)
```

**When debugging consensus issues:** Dump both sides, diff the JSON to find divergence point.

## 💾 Memories

- tx shortcut acceptable in crypto
- Channel.ts is reference implementation
- frontend is UI only, runtime for logic (expose helpers via runtime.ts)
- localhost:8080 only entry point
- lowercase .md filenames (next.md, readme.md)
- "xln" lowercase always, never "XLN"
- Debug with ASCII (quick scan) + JSON (deep analysis) - both auto-dumped on scenario completion
- Security-critical code needs rich comments with counterexamples: explain why the design rejects tempting alternatives, especially for dispute arguments, cross-j orderbook lifecycle, and adversarial inputs.
- During autonomous long-running work, ask the owner immediately whenever an architectural choice, uncertainty, or acceleration idea appears; do not wait for a scheduled status update. Report a terse percent-to-final status at least every 10 minutes until final handoff.
- At the same interval append a <=140-character heartbeat to .logs/qa/agent-progress.jsonl via the progress:note script. If one stable blocker survives 30 minutes, stop broad work and escalate it to the owner; never reset or rename the blocker merely to avoid escalation.
- Dispute transformer arguments are adversarial dynamic evidence: a malformed outer argument wrapper decodes to an empty list, while the signed transformer decides whether empty evidence is acceptable. Signed ProofBody, transformer execution, nonces, hashes, and account state stay fail-fast.
- A ProofBody transformer is user-signed executable dispute logic, not optional evidence: missing code, revert/OOG, malformed output, or invalid allowances revert finalization and leave the dispute active. Dynamic argument wrappers alone may soft-decode to empty evidence; never substitute zero deltas or skip a signed transformer.
- A previous board Hanko remains valid for seven days as historical bilateral dispute evidence, including opening a dispute. It cannot authorize outer processBatch, direct C2R/settlement, governance, or watchtower actions; those remain current-board-only.
- A watchtower is a trusted delegated agent. Dynamic `otherArguments` are intentionally not owner-Hanko-bound because execution evidence changes until submission; the signed ProofBody and transformer allowances cap financial authority. Do not flag or change this trust boundary without an explicit owner protocol decision.
- Test progression must be L1 narrow -> L2 targeted flow -> L3 broad gate; avoid large e2e batches while a single failure is still being isolated.
- Every visual feature requires screenshot-driven E2E coverage at its key states. Inspect and score every screenshot, fix every visible defect before reporting completion, and verify mobile/iPhone, laptop, and wide desktop/Mac Studio viewports so all users receive the same polished result.
- Runtime memory is live state, not an archive: retain only the latest finalized R/E/A state plus an in-flight candidate needed by future inputs. Persist historical Runtime inputs and Hanko-signed Entity/Account frames in their dedicated LevelDB history stores; inspection reads from disk on demand.
- **No invented financial bookkeeping layers:** never add output certification, delivery sequences, emit ordinals, receipts/frontiers, consumption DAGs, or exactly-once metadata. Authority is only the canonical R/E/A frame/state root, Hanko, existing protocol nonce, accepted Runtime WAL input, and ordered flat Runtime outbox. Transport acknowledgements are best-effort process results and never durable protocol state.
- **No transient replica data in durable state:** mempools, proposals, candidates, locked/precommit overlays, votes in progress, retry/resend state, transport queues and worker positions stay in RAM. After a crash, replay accepted Runtime WAL inputs and republish the flat outbox; unaccepted work is resent best-effort. Never commit these fields into a Runtime root or duplicate them in checkpoint metadata.
- **Canonical output order is positional, never sorted:** rejected inputs are absent; accepted inputs retain their dense RAM vector positions; each input owns a naturally ordered `Vec<Output>`; parallel workers return into those same slots and the coordinator performs a plain flatten. Never sort financial inputs/outputs by id, signer, payload, route, kind, shard, hash, or worker completion, and never persist an ordinal field.
- **One path-keyed durable representation:** never introduce content-addressed nodes, CAS/DAG lineage, alternate checkpoint sidecars, or a second delta/state copy. Keys name stable R/E/A tree paths; `put` replaces the value and obsolete children are pruned. Proof and on-chain ABI projections are derived on demand from this single canonical state.
- **Durable-field admission gate:** a new stored field is forbidden unless its owner, canonical root membership, post-crash necessity, and non-derivability are all demonstrated with one adversarial recovery test. Caches, counts, alternate hashes, indexes, receipts, progress markers and copies derivable from canonical state/WAL stay out of storage. Names such as `meta`, `manifest`, `anchor`, `certificate`, `receipt`, `sequence` and `checkpoint token` receive no special exemption.
- Never restart, reset, or replace a live durable Runtime because source, test, scenario, or tooling files changed. `bun run dev` starts each Runtime process once; applying new backend code requires an explicit operator restart. Agent edits and test runs must never mutate, stop, or hot-reload the user's active dev stack.
- **Credit / Delta view invariant (Channel.ts):** Left proposer writes `rightCreditLimit`; right proposer writes `leftCreditLimit`. Never hand-read `leftCreditLimit`/`rightCreditLimit` and invent alternate viewer math in UI, scenarios, orchestrator, or tests. Always use `deriveDelta(delta, isLeft)` for the canonical layout: `ownCreditLimit` = peer granted us (we may owe peer); `peerCreditLimit` = we granted peer (peer may owe us). Credit granted *by* an entity = that entity's `peerCreditLimit`. Wrong field choice is a silent setup/invariant bug, not a cosmetic view issue.
- **Hash-ladder reveal invariants:** Registry publication is independent Sprites-like evidence authenticated by outer `processBatch`; calldata carries only the Account counterparty, role, commitments, and witness—never ProofBody, Pull index, or routing recipient. The ordered slot key is `(Hanko-authenticated revealerEntity, counterEntity, ladder, role)`; never sort the Entity pair, because the reverse participant must not write this slot. A later bilaterally signed Pull derives exactly that ordered pair, assigns financial meaning, and accepts the record only inside its own Account window `[disputeStart, disputeStart + beneficiaryResponseSeconds]`, inclusive. Source is single-shot: exact retry is sticky and a different retry is `E12`. Target is monotonic replaceable; exact/higher publication refreshes its timestamp so public evidence can be republished inside a new target dispute. Runtime derives event audience from the exact committed ordered pair + ladder + role, buffers Target until its dispute clock exists, and rejects ambiguous same-Account hash-material reuse before signing. A Pull-containing proof cannot finalize before `start + leftResponseSeconds + rightResponseSeconds`. For a pull-free proof, the non-starter may immediately accept the state selected/signed by the starter (mutual consent); the starter has no fresh response and must wait the full period. Sibling fanout is must-close and cross-j ProofBody/route always carries both pulls.
- **Consensus reasoning before edits:** Derive the exact authority, signer, role, nonce, and adversarial old/new-state sequence before proposing or changing a channel invariant. Never treat `starter`/`non-starter`, proposer/acceptor, or a historical signature as interchangeable. Work out who selected the state and whose fresh outer Hanko accepts it; encode the conclusion in security comments and boundary tests. Do not ask the owner to reconstruct an obvious channel invariant that can be derived from these facts.
- **Performance evidence cardinality:** Real TPS is accepted only from the production H1 live path with at least 1,000 active sovereign user Runtimes, at least 1,000 committed economic payments, at least 1,000 offered payments/s, **and a full 20-second offered window**, followed by the required zero-loss/ACK drain gate; 10,000 users is the standard optimization target. Startup/provisioning is a separate reusable preparation phase and is never charged to or shortened from that window. A shorter run is smoke only: it must emit no TPS/rate field and must never be presented as optimization progress. Any smaller, synthetic, mirror, transcript, fixture or replay run is smoke/parity evidence only and must emit no TPS/rate field. Replay scaling additionally requires at least 1,000 Runtime frames, but remains a diagnostic and never TPS.
- **Live parity admission:** Before profiling or reporting Rust H1 throughput, the exact production engine must complete bootstrap/cutover and reach the external economic-start gate with TS↔RS roots equal. Any pre-load fail-stop or parity mismatch invalidates throughput work until the first divergent Runtime frame and owning transition are fixed.
- **Replay is WAL execution, never history reconstruction:** benchmark/replay reads only the checkpoint plus ordered Runtime WAL inputs and compares per-frame Runtime/Entity/Account roots and ordered event/effect/outbox digests. It must not scan certified-history views, issue one query per Account, or eagerly materialize a full diagnostic oracle. Detailed Account dumps are generated lazily only after the first mismatch.
- **No unbounded fixture fan-out:** before writing `Promise.all(collection.map(...))`, prove the maximum production/fixture cardinality. Any storage/network fan-out over an account/entity collection must be a single canonical scan or a bounded stream; a test helper is not exempt. Do not add a production storage API solely to rescue a benchmark harness.
- **Worker scaling evidence:** Run worker-count trials sequentially against independent database copies; concurrent trials sharing LevelDB invalidate the result. Report worker-owned phase speedup and end-to-end speedup separately, plus per-worker CPU/work distribution, coordinator wall/fold time, barriers, projection, WAL and publication. Never present a fast shard phase as full-stack TPS.
- **Clone-counter admission:** Never rank a `*Clones` counter as copied values/bytes until the cloned type and its `Clone` implementation are inspected and sampled CPU/bytes confirm the cost. Persistent radix shard clones copy Arc root handles, not Account values; report them as handle clones unless evidence proves otherwise.
- **Capacity-name admission:** Never infer that a repeated numeric limit (especially 256/4096) belongs to Account sharding until its owning call path is traced. `HLT_LANE_PORTS_PER_SLOT` reserves test-only TCP port namespaces; it is not Account, shard, batch or user capacity. For populations above 4096, use the launcher-derived 8192/16384 port slot and keep forest cardinality independent.
- **Map-to-radix admission:** Prove the cardinality of the exact collection inside one canonical owner before replacing a map. Host-level counts of sovereign Runtimes do not imply `RuntimeState.eReplicas` is large; never change its representation/root because a process hosts many Runtimes. Radix is required only for a collection demonstrated to exceed 100 entries in one owner or already canonical as radix in TS.
- **HLT engine admission:** Never describe a live run as Rust H1 from `XLN_HUB_RSCORE_AUTHORITY_H1` alone. The workload selects its engine only through `XLN_HLT_ENGINE=rust`; before interpreting setup phases or reporting TPS, prove the parsed plan and final report both say `engine: rust`.
- **Known-owner-decision gate:** Never ask the owner to reconfirm a decision already explicit in this file or the active task. H1 is the hub role/label, not an implementation. `XLN_HLT_ENGINE` is the sole explicit production selector: `ts` launches the complete TypeScript H1 and `rust` launches the complete Rust H1. A Rust authority/TPS claim still requires `engine: rust` in the parsed plan and final report.
- **Parity completion gate:** Catalog/name equality, production-only `cargo build`, replay roots, or wire decode are not semantic parity. Parity requires production and `cfg(test)` Rust trees to compile, shared TS/Rust vectors to execute every supported EntityTx and AccountTx, full live J watcher→Entity→batch→receipt coverage, and per-frame state/event/effect/outbox equality. A red or uncompiled test tree makes every parity percentage unproven.
- **Progress-percent gate:** Percent-to-final updates must be derived from the explicit completion gates above. Do not raise percentages for isolated replay, compilation, catalog, codec, or microbenchmark milestones; if a newly inspected required gate is red, lower the percentage and name it.
- **One production H1 under every driver:** Scenario, replay and HLT drivers may differ, but the selected H1 engine may not. HLT must launch that engine's complete production process, wire, state transitions, WAL and J integration used by normal scenarios; test-only financial execution or H1 mirrors are forbidden.
- **Worker-wave cardinality gate:** Before blaming one worker barrier per EntityInput, verify the exact Runtime selection seam. `apply_runtime_inner` flattens every selected EntityInput's Account rows into one `ResidentEntityRequest`, so worker-wave count follows committed Runtime frames, not `runtimeEntityInputs`. Every scaling report must show all three counts: Runtime frames, selected EntityInputs and Account rows.
- **Three-stage Entity financial pipeline:** One Runtime frame has three dependency-ordered parallel stages: (1) inbound Account inputs, (2) Entity-owned Paybook and Orderbook work partitioned by their 256 radix shards, and (3) outbound Account proposals. Stage 3 must start only after stage 2 is complete because its proposals are stage-2 outputs. Never fuse stages 2 and 3, and never call a parallel radix-root commit alone a parallel Entity stage; report transition work and root commit separately.
- **Bad scaling remains a defect:** An 8-worker result below 6x for a deliberately worker-dominated long fixture is not closed by saying “Amdahl”. Locate and remove/batch the measured serial path, imbalance or data movement, or report the exact blocker. Validate benchmark cardinality before changing production code.
- **Canonical vocabulary before invention:** Reuse the exact Runtime/Entity/Account and wire names already present in canonical TypeScript. Directional abbreviations may remain only where they are existing cryptographic protocol labels; never promote them into new product concepts, APIs or status language.
- **Remembered rscore/HLT failures:** The following prior assistant errors are permanent rejection gates, not anecdotes: never call a 1–2 second or sub-1,000-user run TPS; never shorten the 20-second offered window to fit setup; never charge reusable setup to the economic window; never call replay/microbench speed live progress; never call H1 Rust until the hub engine itself is proven Rust (user Runtime language is irrelevant); never invent schema/version names in the versionless testnet protocol; never infer capacity from `256`/`4096` before tracing the owning constant (`4096` Account shards are grouping, not an account/batch cap); never call Arc-root handle clones copied Account bytes without proof; never infer a worker barrier from input counts before tracing the flattened Runtime request; never recommend eager Account-frame history/oracles when the canonical root already commits the frame; never report a timed-out auditor or failed/readiness-incomplete HLT as evidence; and never leave timed-out child processes competing with the next measurement.
- **Result-before-narrative:** A performance status starts with the last valid authoritative metric and its full gate (`users × seconds × offered/committed/lost/pending`, engine, worker count), then the measured phase wall times, then the next single experiment. Plans, compiled code, passing smoke tests and partial readiness are not throughput results. If a work cycle produces no valid result, say `NO VALID TPS` and the exact failed gate instead of filling the report with activity.
- **Deletion-first admission:** For performance work, first remove a duplicate encode/hash/materialization/scan or batch an existing canonical transition. A new cache, index, persisted field, alternate identifier, wrapper stage or protocol term requires owner approval plus proof that deletion/batching cannot solve the measured bottleneck.
- **External model quorum:** Never use GPT-family models. The primary reviewer pair is Cursor Grok 4.6 plus OpenCode DeepSeek; Claude Opus 5 or Sonnet 5 with medium/high effort is the expensive escalation/final wave. Never use Fable without a separate explicit owner request. Internal Codex subagents are disabled unless the owner explicitly re-enables them; they do not count as an independent external-model quorum. Auditors are code-only unless the owner asks otherwise; the primary agent independently verifies every finding against xln's bilateral model.
- **External CLI discipline:** Invoke Cursor through the authenticated `cursor-agent` binary, never the old `cursor agent` wrapper. Inspect `cursor-agent models` and select an exact `cursor-grok-4.6-*` model; for a read-only audit use `--mode ask` or `--mode plan`, `--trust`, and `--output-format json`. OpenCode is the canonical DeepSeek runner. Before every provider's first call, inspect its help/model list and verify the resolved model in machine-readable output or logs. External auditor CLIs use their documented noninteractive approval flag when needed so read-only audit commands do not stall; the immutable SHA and no-write/no-broad-test scope remain explicit in the prompt. Use persistent sessions and resume the same reviewer to challenge findings until it issues an explicit corrected verdict. Require 10% progress updates with current phase and token/cost usage; independently monitor the process/log when output is buffered. A quiet process is not assumed dead until PID, network/tool activity and provider state are checked.
- **External audit budget:** Give auditors the exact immutable SHA, bounded diff and authority questions. They may read code and run at most one narrow calculation/test under 30 seconds; never let an auditor launch broad gates, brute-force searches or duplicate verification already owned by the primary agent. Record actual resolved model, session id and usage rather than the requested label.
- **External audit scope:** Under the hard process budget, one auditor gets one concrete failing frame or one bounded production call path and must return a verdict before expanding scope. A broad dirty-tree request that times out yields no finding and must not be represented as review progress.
- **Audit waves:** Run at most four external auditors on one stable candidate, only after every exact provider+model invocation passes the smoke gate below. Verify findings against the code, fix concrete issues, and prove fixes at L1/L2 before starting another wave so reviewers do not duplicate stale findings. Prefer different model families in the final wave. Two clean independent verdicts on stable bytes end code audit; do not keep adding reviewers unless a release gate exposes new evidence.
- **Smoke test before external waves:** Before any real external coder/auditor wave, smoke-test each exact provider+model invocation for 30–60 seconds. Smoke must prove it reads AGENTS/project HEAD, reads one scoped file, runs one harmless narrow command/test, and reports resolved model/session/usage. Noninteractive calls must not use PTY. Do not artificially remove read/search/shell tools needed for smoke. If smoke has no valid output, fix invocation before assigning real work. Every real external call has a hard 10-minute wall-clock timeout; kill and replace on timeout. Four-auditor waves start only after all four exact invocations pass smoke.
- **Advisor sampling:** Keep the compact evidence-based ranking in `docs/audit/advisor-scorecard.md`, but the current owner model restriction overrides historical rankings. Independently verify every verdict. Owner quorum threshold is one verified reviewer; never block the owner on a protocol question when another approved reviewer can resolve it.
## 🔍 EXTERNAL AUDIT RULE

**Never blindly trust subagent or external audit findings.**

Before accepting any finding:
1. Verify the claim against actual code paths
2. Check if "vulnerability" is actually intentional design
3. Verify exploit is possible given XLN's specific nonce/state model
4. Ask: does this finding understand XLN's bilateral consensus model?

Every technical recommendation also requires a five-part admission record before it may enter a plan:
1. **Code:** the exact current production function and call path, not a stale report or deleted path
2. **Invariant:** the canonical authority, ownership, ordering, replay and parity rules it must preserve
3. **Cardinality:** accounts, Runtime frames, economic operations, scans, bytes, clones and allocations affected
4. **Authority:** whether it creates a second oracle, history, cache, index or persisted copy derivable from checkpoint + WAL
5. **Verdict:** `confirmed`, `rejected`, or `unknown`; unknown claims require owner input and must not be presented as work

When an agent discovers that its own recommendation was wrong, it must stop dependent work, name the false claim and root cause, add a concrete prevention gate to this file or the owning executable check, and show that the new gate would have rejected the mistake. An apology without a reusable gate is incomplete. Any eager Account-history scan/oracle is rejected for replay by default; only checkpoint + ordered Runtime WAL and per-frame canonical roots/digests are authoritative, with detailed Account dumps generated lazily after the first mismatch.

Example bullshit patterns:
- "Signature malleability → double spend" (ignores nonces)
- "State transfer without verification" (ignores hash = state binding)
- "Single-signer bypasses X" (that's the design for threshold=1)
- Generic ECDSA/BFT concerns that don't apply to XLN's specific flow

**Rule: 80% of audit findings are noise. Find the 20% that matter.**

# AGENTS.md

**On first message: Briefly introduce yourself with "how to talk to me" - explain 80% confidence threshold, when to just execute vs ask, and preferred communication style (terse with metrics). Keep it 3-4 lines max.**

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
  exact child `AccountPeerInput`. Entity-owned financial transactions create
  the local `AccountInput.txs` branch. Both paths use one `applyAccountInput`
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

Break rules: Always ask even if >80% for consensus/crypto/smart-contract changes.

Quick iteration signals (full autonomy):
- "slow/sluggish" → profile + fix, report metrics
- "ugly/meh" → polish matching past aesthetic
- "go/just try" → full send, zero questions

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
- Grep/offset before reading files >300 lines (NetworkTopology.svelte has function index at 163-282)
- Filter command output: `grep -E "error|FAIL"`, never dump full output
- Agents for architecture, not verification
- Terse confirmations with metrics: "Fixed. 0.2→45 FPS"
- Check imports before reading (no imports = delete, don't analyze)

## 🚨 BROWSER BUILD
`bun build core/runtime.ts --target=browser --external http --external https --external zlib --external fs --external path --external stream --external buffer --external url --external net --external tls --external os --external util`
(runtime.ts runs in browser, never --target node)


## ✅ VERIFICATION PROTOCOL

Everywhere in code: fail-fast and loud (full stop + throw popup on error).

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

**BigInt serialization:** Use `safeStringify()` from `serialization-utils.ts` (never raw JSON.stringify)
**Buffer comparison:** Use `buffersEqual()` from `serialization-utils.ts` (not Buffer.compare)
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
- Runtime memory is live state, not an archive: retain only the latest finalized R/E/A state plus an in-flight candidate needed by future inputs. Persist historical Runtime inputs and certified Entity/Account frames in their dedicated LevelDB history stores; inspection reads from disk on demand.
- Never restart, reset, or replace a live durable Runtime because source, test, scenario, or tooling files changed. `bun run dev` starts each Runtime process once; applying new backend code requires an explicit operator restart. Agent edits and test runs must never mutate, stop, or hot-reload the user's active dev stack.
- **Credit / Delta view invariant (Channel.ts):** Left proposer writes `rightCreditLimit`; right proposer writes `leftCreditLimit`. Never hand-read `leftCreditLimit`/`rightCreditLimit` and invent alternate viewer math in UI, scenarios, orchestrator, or tests. Always use `deriveDelta(delta, isLeft)` for the canonical layout: `ownCreditLimit` = peer granted us (we may owe peer); `peerCreditLimit` = we granted peer (peer may owe us). Credit granted *by* an entity = that entity's `peerCreditLimit`. Wrong field choice is a silent setup/invariant bug, not a cosmetic view issue.
- **Hash-ladder reveal invariants:** Registry publication is independent Sprites-like evidence authenticated by outer `processBatch`; calldata carries only the Account peer, role, commitments, and witness—never ProofBody, Pull index, or routing recipient. The ordered slot key is `(Hanko-authenticated revealerEntity, counterEntity, ladder, role)`; never sort the Entity pair, because the reverse participant must not write this slot. A later bilaterally signed Pull derives exactly that ordered pair, assigns financial meaning, and accepts the record only inside its own Account window `[disputeStart, disputeStart + beneficiaryResponseSeconds]`, inclusive. Source is single-shot: exact retry is sticky and a different retry is `E12`. Target is monotonic replaceable; exact/higher publication refreshes its timestamp so public evidence can be republished inside a new target dispute. Runtime derives event audience from the exact committed ordered pair + ladder + role, buffers Target until its dispute clock exists, and rejects ambiguous same-Account hash-material reuse before signing. A Pull-containing proof cannot finalize before `start + leftResponseSeconds + rightResponseSeconds`. For a pull-free proof, the non-starter may immediately accept the state selected/signed by the starter (mutual consent); the starter has no fresh response and must wait the full period. Sibling fanout is must-close and cross-j ProofBody/route always carries both pulls.
- **Consensus reasoning before edits:** Derive the exact authority, signer, role, nonce, and adversarial old/new-state sequence before proposing or changing a channel invariant. Never treat `starter`/`non-starter`, proposer/acceptor, or a historical signature as interchangeable. Work out who selected the state and whose fresh outer Hanko accepts it; encode the conclusion in security comments and boundary tests. Do not ask the owner to reconstruct an obvious channel invariant that can be derived from these facts.
- **External model quorum:** Never use GPT-family models. The primary reviewer pair is Cursor Grok 4.6 plus OpenCode DeepSeek; Claude Opus 5 or Sonnet 5 with medium/high effort is the expensive escalation/final wave. Never use Fable without a separate explicit owner request. Internal Codex subagents are disabled unless the owner explicitly re-enables them; they do not count as an independent external-model quorum. Auditors are code-only unless the owner asks otherwise; the primary agent independently verifies every finding against xln's bilateral model.
- **External CLI discipline:** Invoke Cursor through the authenticated `cursor-agent` binary, never the old `cursor agent` wrapper. Inspect `cursor-agent models` and select an exact `cursor-grok-4.6-*` model; for a read-only audit use `--mode ask` or `--mode plan`, `--trust`, and `--output-format json`. OpenCode is the canonical DeepSeek runner. Before every provider's first call, inspect its help/model list and verify the resolved model in machine-readable output or logs. External auditor CLIs use their documented noninteractive approval flag when needed so read-only audit commands do not stall; the immutable SHA and no-write/no-broad-test scope remain explicit in the prompt. Use persistent sessions and resume the same reviewer to challenge findings until it issues an explicit corrected verdict. Require 10% progress updates with current phase and token/cost usage; independently monitor the process/log when output is buffered. A quiet process is not assumed dead until PID, network/tool activity and provider state are checked.
- **External audit budget:** Give auditors the exact immutable SHA, bounded diff and authority questions. They may read code and run at most one narrow calculation/test under 30 seconds; never let an auditor launch broad gates, brute-force searches or duplicate verification already owned by the primary agent. Record actual resolved model, session id and usage rather than the requested label.
- **Audit waves:** Run at most two external auditors on one candidate. Verify and fix their concrete findings, prove the fixes at L1/L2, then give the updated bytes to the next pair so reviewers do not duplicate stale findings. Prefer two different model families in the final wave. Two clean independent verdicts on the stable candidate end code audit; do not keep adding reviewers unless a release gate exposes new code evidence.
- **Advisor sampling:** Keep the compact evidence-based ranking in `docs/audit/advisor-scorecard.md`, but the current owner model restriction overrides historical rankings. Independently verify every verdict. Owner quorum threshold is one verified reviewer; never block the owner on a protocol question when another approved reviewer can resolve it.
## 🔍 EXTERNAL AUDIT RULE

**Never blindly trust subagent or external audit findings.**

Before accepting any finding:
1. Verify the claim against actual code paths
2. Check if "vulnerability" is actually intentional design
3. Verify exploit is possible given XLN's specific nonce/state model
4. Ask: does this finding understand XLN's bilateral consensus model?

Example bullshit patterns:
- "Signature malleability → double spend" (ignores nonces)
- "State transfer without verification" (ignores hash = state binding)
- "Single-signer bypasses X" (that's the design for threshold=1)
- Generic ECDSA/BFT concerns that don't apply to XLN's specific flow

**Rule: 80% of audit findings are noise. Find the 20% that matter.**

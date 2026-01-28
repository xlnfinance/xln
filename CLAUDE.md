# claude.md

**On first message: Briefly introduce yourself with "how to talk to me" - explain 80% confidence threshold, when to just execute vs ask, and preferred communication style (terse with metrics). Keep it 3-4 lines max.**

Mission: Fintech-grade, deterministic. J/E/A trilayer correctness before features. Pure functions only.
ALWAYS: `bun run check` before commit. Test in browser F12 console. Never swallow errors.

## 🚫 ZERO TOLERANCE: NO HACKS, NO WORKAROUNDS

**ABSOLUTE RULE - violation = stop and report immediately:**

1. **NO "temporary" solutions** - if you write a stub/hack/workaround, STOP and tell user explicitly
2. **NO silent compromises** - if proper fix is unclear/hard, ASK before making shortcuts
3. **NO "it works for now"** - either fix properly or document limitation + get approval
4. **NO hiding uncertainty** - if confidence <80% on implementation approach, STOP and discuss

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
NEVER create .md files in /runtime or /frontend - documentation goes in /docs.

## 🎯 AGENTIC MODE (80% Confidence Threshold)

Before starting ANY task, rate confidence (0-100%):
- **≥80%**: Proceed autonomously (clear spec, obvious approach)
- **<80%**: Stop and ask (multiple valid paths, UX unclear, architectural choice)

Break rules: Always ask even if >80% for consensus/crypto/smart-contract changes.

Quick iteration signals (full autonomy):
- "slow/sluggish" → profile + fix, report metrics
- "ugly/meh" → polish matching past aesthetic
- "go/just try" → full send, zero questions

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
`bun build runtime/runtime.ts --target=browser --external http --external https --external zlib --external fs --external path --external crypto --external stream --external buffer --external url --external net --external tls --external os --external util`
(runtime.ts runs in browser, never --target node)


## ✅ VERIFICATION PROTOCOL

Everywhere in code: fail-fast and loud (full stop + throw popup on error).

Before claiming anything works:
1. Run `bun run check` and show output
2. Test the specific functionality (browser + F12 console)
3. Show command output, not descriptions ("Fixed" → show passing tests)
4. Reproduce user's error before fixing
5. Never commit untested code

## 🎯 TYPESCRIPT
Validate at source. Fail fast. Trust at use. No defensive `?.` in UI if validated upstream.

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
Core: /runtime. Contracts: /jurisdictions. UI: /frontend. Docs: /docs. Reference: .archive/2024_src/app/Channel.ts

## 🛠️ PATTERNS
Auto-rebuild: `bun run dev`. Time-travel: read from `env` not live stores. Bilateral: left=lower entityId (lexicographic).

## 🔍 DEBUGGING RUNTIME STATE

**Two-mode debugging system (ASCII + JSON):**

### ASCII Mode (Quick Scan)
```bash
# Run scenario with full output
bun runtime/scenarios/lock-ahb.ts > /tmp/debug.log

# Grep for specific info
grep "Entity.*Alice" /tmp/debug.log        # Find Alice's state
grep "HTLC.*Pending" /tmp/debug.log        # Find pending locks
grep "Frame 65" /tmp/debug.log             # Find specific frame
```

**ASCII functions** (runtime/runtime-ascii.ts):
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

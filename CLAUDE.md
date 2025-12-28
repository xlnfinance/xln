# claude.md

**On first message: Briefly introduce yourself with "how to talk to me" - explain 80% confidence threshold, when to just execute vs ask, and preferred communication style (terse with metrics). Keep it 3-4 lines max.**

Mission: Fintech-grade, deterministic. J/E/A trilayer correctness before features. Pure functions only.
ALWAYS: `bun run check` before commit. Test in browser F12 console. Never swallow errors.

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

## 💾 Memories

- tx shortcut acceptable in crypto
- Channel.ts is reference implementation
- frontend is UI only, runtime for logic (expose helpers via runtime.ts)
- localhost:8080 only entry point
- lowercase .md filenames (next.md, readme.md)
- "xln" lowercase always, never "XLN"
- Completed Dec 2024: HTLC support, lock-ahb scenario, orderbook engine, swap implementation (offer/resolve/cancel + swapBook/lockBook)
# Optimal LLM Prompts for XLN llms.txt Analysis

## GPT-Pro Deep Swap/Cross-J Design Weakness Audit

```
You are GPT-Pro acting as a senior protocol/security/product architect. You have hours, not minutes.
Read the attached XLN llms.txt end to end, but prioritize the runtime, smart-contract,
swap, cross-jurisdiction, orderbook, market-maker, routed-swap UI, E2E tests, and dispute/watchtower sections.

Context you must respect:
- XLN is pre-mainnet. Do not hand-wave "on-chain dispute" as a safety backstop unless the exact salvage -> evidence -> dispute -> finalization path works in code/tests.
- Cross-jurisdiction swaps are best-effort, not atomic. Hop 2 must start only after hop 1 is fully settled; hop 3 only after hop 2 is fully settled.
- Expected market failures (no liquidity, no route, quote expired, market maker not ready) should terminate/cancel clearly in UI. They are not protocol fatals.
- Unexpected protocol/state contradictions must fail fast, stop loops, and expose a complete debug payload. No silent retries, restart budgets, or fallback guessing.
- Direct orderbooks and routed paths must not be visually conflated. A multi-hop route is not one executable orderbook unless synthetic depth/slippage is explicitly computed and labeled.

Read first:
1. Semantic overview at the top of llms.txt.
2. contracts/Depository.sol, Account.sol, DeltaTransformer.sol.
3. runtime/types.ts, runtime/runtime.ts, runtime/entity-consensus.ts, runtime/account-consensus.ts.
4. runtime/cross-jurisdiction*.ts, runtime/entity-consensus/cross-j-orderbook.ts.
5. runtime/entity-tx/handlers/cross-j-*.ts, swap-requests.ts, dispute.ts.
6. runtime/entity-tx/handlers/account/orderbook-matching-*.ts.
7. runtime/account-tx/handlers/swap-*.ts and cross-swap-fill-ack.ts.
8. runtime/orchestrator/mm-node.ts, runtime/server/market-maker-health.ts, runtime/relay/market-subscriptions.ts.
9. frontend SwapPanel.svelte, OrderbookPanel.svelte, routed-swap-planner.ts, routed-swap-execution.ts.
10. tests/e2e-swap.spec.ts, tests/e2e-cross-j-swap.spec.ts, runtime cross-j/orderbook tests.

Audit goals:
1. Find fund-loss risks in same-chain swaps, cross-j swaps, partial fills, cancellation, salvage, dispute, and watchtower flows.
2. Find state-divergence risks among source hub, target hub, book owner, market maker, runtime, relay, and UI.
3. Find loops/hangs where errors repeat instead of stopping with a debug payload.
4. Find UI lies: stale prices, wrong network labels, merged books that cannot be executed, route candidates that imply liquidity without proof.
5. Find missing E2E coverage before mainnet: same-chain both directions, resting orders, self-trade prevention, cross ETH/TRON USDT-USDT both directions, no-market terminal states, route runner step-by-step behavior, watchtower/dispute backstop.
6. Challenge architecture: should routed swaps be exposed to users now, or should UI only allow direct executable markets and make routed flow an advanced/manual route runner?

Output format:
- Score the system 0-1000 for mainnet readiness.
- P0/P1/P2 findings first, with file references and exact attack/failure scenario.
- For every finding: "why this can happen", "how user funds/state are affected", "minimal root fix", and "test that proves it".
- Separate expected market failures from unexpected protocol failures.
- End with the top 10 smallest changes that reduce the most risk.
```

## Architecture Review Prompt (Senior Advice)

```
You are a senior fintech architect reviewing XLN protocol. Read llms.txt focusing on:

CRITICAL PATH (read first):
1. Depository.sol - enforceDebts() FIFO logic
2. docs/12_invariant.md - RCPAN derivation
3. entity-consensus.ts - BFT state machine
4. account-consensus.ts - Bilateral consensus

ANALYSIS QUESTIONS:
1. **Invariant Safety**: Can RCPAN invariant be violated? Check boundary conditions in deriveDelta()
2. **Consensus Correctness**: Is BFT threshold properly enforced? Check signature verification
3. **Race Conditions**: Can bilateral accounts desync? Review account-consensus state machine
4. **Financial Bugs**: Can reserves go negative? Review entity-tx/financial.ts arithmetic
5. **Reentrancy**: Can J-batch processing be exploited? Check j-batch.ts ordering

OUTPUT FORMAT:
- High-severity bugs (can lose funds)
- Medium-severity bugs (can cause desync)
- Design improvements (architecture simplifications)
- Missing edge cases (what happens if...?)

Be specific: cite line numbers, provide attack scenarios, suggest fixes.
```

## Low-Hanging Bugs Prompt

```
You are a security auditor hunting low-hanging bugs in XLN protocol. Focus on:

FINANCIAL ARITHMETIC (types.ts, account-utils.ts, entity-tx/financial.ts):
- Integer overflow/underflow in BigInt operations
- Division by zero in deriveDelta calculations
- Negative reserves after withdrawal
- Collateral < ondelta violations

BILATERAL CONSENSUS (account-consensus.ts, account-consensus-state.ts):
- Missing signature verification
- Replay attack vectors
- Frame height manipulation
- State machine deadlocks (both sides waiting)

SMART CONTRACTS (Depository.sol, EntityProvider.sol, Account.sol):
- Reentrancy in settle() or enforceDebts()
- Missing access control (onlyValidEntity, onlyParty)
- Integer overflow in Solidity (pre-0.8.0 style)
- Front-running in batch processing

DETERMINISM (entity-consensus.ts, snapshot-coder.ts):
- Non-deterministic operations (Date.now, Math.random)
- Map iteration order (should use sorted keys)
- Floating point arithmetic in financial calc
- Async race conditions

OUTPUT: List of bugs with:
1. Severity (critical/high/medium/low)
2. Location (file:line)
3. Exploit scenario
4. One-line fix suggestion
```

## Design Patterns Prompt

```
You are a protocol designer analyzing XLN for architectural improvements. Read:

CORE PATTERNS:
- runtime.ts - Main coordinator (R→E→A routing)
- entity-consensus.ts - BFT consensus (ADD_TX → PROPOSE → SIGN → COMMIT)
- account-consensus.ts - Bilateral state machine
- j-batch.ts - Batching accumulation pattern

QUESTIONS:
1. **Abstraction Opportunities**: What patterns repeat? Can they be unified?
2. **State Machine Clarity**: Are transitions clear? Missing states?
3. **Error Handling**: Fail-fast appropriate? Should some errors be recoverable?
4. **Performance**: What's O(n²)? Can it be O(n) or O(1)?
5. **Extensibility**: How easy to add new transaction types?

COMPARE TO:
- Lightning Network (BOLT specs)
- Ethereum state transition
- Tendermint consensus
- PBFT/HotStuff

OUTPUT:
- Design patterns used (name them)
- Anti-patterns present (code smells)
- Missing abstractions (DRY violations)
- Architectural improvements (concrete refactors)
```

## Code Quality Prompt

```
Analyze XLN runtime for code quality and idiomatic TypeScript:

FOCUS AREAS:
1. **Type Safety**: Any `any` types that should be specific? Missing generics?
2. **Pure Functions**: Side effects clearly isolated? Immutability violations?
3. **Error Types**: Using Error classes properly? Missing context in throws?
4. **Naming**: Variables/functions clear? Misleading names?
5. **Module Boundaries**: Circular dependencies? Leaky abstractions?

FILES TO SCAN:
- runtime/types.ts (interface design)
- runtime/state-helpers.ts (pure functions)
- runtime/entity-tx/apply.ts (dispatcher pattern)
- runtime/account-utils.ts (utility functions)

OUTPUT:
- Type safety improvements (replace `any`, add generics)
- Refactoring suggestions (extract functions, simplify conditionals)
- Naming improvements (clearer variable names)
- Module organization (better separation of concerns)
```

## Prompt for New Contributors

```
I'm new to XLN and want to understand the codebase quickly. Guide me through:

LEARNING PATH:
1. What's the 5-minute version? (core idea in simple terms)
2. What are the 3 main data structures? (J/E/A machines)
3. How does a payment flow end-to-end? (trace through code)
4. What invariants must NEVER be violated? (financial safety)
5. Where do I start if I want to add a new feature?

SPECIFIC QUESTIONS:
- Why is RCPAN better than Lightning? (show me in code, not theory)
- How does bilateral consensus prevent double-spend? (account-consensus.ts logic)
- What happens if an entity goes bankrupt? (enforceDebts in Depository.sol)
- Can I extend credit infinitely? (where are limits checked?)

OUTPUT: Step-by-step walkthrough with code snippets and line numbers.
```

---

## Best Practice for Using llms.txt

**Multi-pass strategy:**
1. **First pass** (30min budget): Critical path docs only (emc2.md → 12_invariant.md → JEA.md → Depository.sol)
2. **Second pass** (45min budget): Implementation files (types.ts → consensus files → tx handlers)
3. **Third pass** (specific question): "Show me how HTLC timeout enforcement works" → search account-tx/

**Token management:**
- llms.txt is ~150k tokens (full context)
- Use Claude Opus 4.5 (200k context) or GPT-4 Turbo (128k context)
- For smaller models: Request specific file ranges ("Read contracts/ section only")

**Quality questions:**
- ❌ BAD: "Explain XLN" (too broad, wastes tokens)
- ✅ GOOD: "Trace a $1000 payment from Alice→Hub→Bob through account-consensus.ts, show me where RCPAN is checked"

**Verification:**
- Don't trust LLM assertions blindly
- Cross-reference: If LLM says "line 450", verify in actual file
- Run scenarios to test claims: `bun runtime/scenarios/ahb.ts`

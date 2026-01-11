# Optimal LLM Prompts for XLN llms.txt Analysis

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

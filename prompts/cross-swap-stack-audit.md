# Cross-swap stack audit (global)

You are auditing XLN’s **cross-jurisdiction swap / pull / dispute** stack end-to-end.

Scope is the full money path, not a single file:

- off-chain bilateral Account state (offers, fills, pulls, hash-ladders)
- Entity / Runtime orchestration and P2P delivery between runtimes
- orderbook / matching / route materialization across jurisdictions
- on-chain Depository / Account / DeltaTransformer / reveal registry
- dispute prepare → start → challenge window → finalize → reopen
- watchers, batching, finality, and any recovery / adversary paths

Do **not** assume prior findings, recent refactors, or “known issues.”  
Treat the current tree as hostile and incomplete until proven otherwise.

Work from **code + tests + scenarios + contracts**. Prefer concrete counterexamples over vibes.

---

## What to produce

1. **Invariant list** you believe must hold for cross-swaps to be financially safe  
2. **Security situations** (attacker / failure modes) worth checking  
3. **Gaps**: what the suite does not appear to prove  
4. **Advice & ideas**: how you would prioritize proof with *minimal* new surface area  
5. Explicit **confidence** per claim (high / medium / low) and what evidence would upgrade it

Ask clarifying questions when an invariant is ambiguous. Prefer questions over inventing protocol policy.

---

## Invariants to evaluate (non-exhaustive starter set)

Use these as prompts for your own sharper list. Add, split, or reject any item with reasoning.

### Economic / conservation
- No unbacked mint of reserve, collateral, or credit across any hop or jurisdiction.
- Partial fill, cancel, expire, and dispute finalize never create free inventory.
- Fees, debt chunking, and clamps cannot strand value without an explicit accountable residue.
- Both legs of a cross-route either settle coherently or degrade to a defined residual (not an implicit win for one side).

### Bilateral consensus
- Left/right layout and credit limits are canonical; viewer-side reinterpretation is forbidden.
- Only mutually signed Account state is dispute-authoritative; optimistic / pending frames are not.
- Evidence used in disputes is bound to a specific signed ProofBody / nonce / hash.
- Late, stale, or replayed proposals/ACKs cannot reopen or rewrite a frozen disputed account.

### Cross-jurisdiction coupling
- A route with multiple jurisdiction legs has a defined pairing / liveness story.
- Observing a dispute or failure on one leg has a defined obligation (or non-obligation) on sibling legs.
- Counterparty / entity identity in cross-leg evidence cannot be confused with the local peer.
- “Missing” remote results have a defined deadline after which residual value is zero or otherwise capped — and that rule cannot be gamed by delaying honest action.

### Time and finality
- Challenge / reveal / finalize barriers are defined in a single coherent clock domain.
- Runtime scheduling and on-chain enforcement cannot permanently disagree in a way that loses funds for an honest party who follows the protocol.
- Early finalize by the wrong party is rejected; timely finalize by an authorized party is possible.
- Historical boards / hanko evidence, if accepted, have a narrow authority surface (cannot silently become governance or batch authority).

### Transformer / dispute program
- Signed transformer execution is not optional decoration: missing code, revert, OOG, malformed output, or allowance violations must not quietly succeed with invented deltas.
- Dynamic argument wrappers may be adversarial; empty or malformed outer evidence must not bypass the signed program’s rules.
- Fill ratios, secrets, and pulls are positional and bound to the signed plan for that ProofBody.
- Registry reveals and local secrets cannot double-spend the same conditional across legs.

### Transport / liveness / recovery
- Offline peer, dropped ingress, or delayed ACK cannot erase the only copy of economically material evidence without a defined recovery path.
- Hub / MM / runtime restart, fencing, and recovery cannot finalize the wrong nonce or skip a required sibling action.
- Watcher lag, reorg depth, and batch submit races fail closed or retry safely — never “assume settled.”

### Authorization
- Who may start, escalate, finalize, or reopen is explicit.
- Watchtower / delegated agents, if any, have a hard financial envelope.
- Threshold / multi-sig entities cannot have a single signer authorize outer settlement or dispute actions beyond board policy.

---

## Security situations to hunt

Again: starter list. Expand with sharper attacks.

1. One leg settles; the other is withheld, delayed, or disputed asymmetrically.  
2. Honest party is late to dispute because the counterparty controlled timing or availability.  
3. Pending fill / pull evidence exists off-chain but disappears before disputeStart.  
4. Empty or soft-decoded dispute arguments produce a financially better outcome than honest evidence.  
5. Wrong-leg or wrong-entity identifiers cause fanout / recovery to target the incorrect account.  
6. Finalize before challenge end; or challenge end never becomes reachable for an honest runtime.  
7. Reveal window vs finalize barrier ordering allows secret withholding to steal optionality.  
8. Partial close / cancel of one leg leaves the residual leg un-disputable or unpaid.  
9. Replay of old hanko / old ProofBody opens or finalizes against a newer economic state.  
10. Matcher / hub / MM crash mid-route leaves books and pulls in a straddled state.  
11. Dual-runtime P2P equivocation: two replicas of the “same” role diverge.  
12. Cross-j route market / expiry signals are treated as settlement authority when they must not be.  
13. Transformer allowances are wide enough to move unrelated deltas.  
14. Debt / clamp paths convert a temporary asymmetry into permanent unrecoverable loss.  
15. Scenario or test helpers accidentally paper over production-impossible races.

---

## Method constraints

- Prefer **small deterministic proofs** (unit / scenario puppet) over browser e2e for protocol risk.  
- Every serious finding needs: assets at risk, honest vs adversarial assumptions, and a minimal repro sketch.  
- Separate **protocol design questions** from **implementation bugs**.  
- Ignore style nits unless they hide financial incorrectness.  
- Do not propose compatibility shims, dual formulas, or “temporary” second paths.

---

## Questions for you (advice & ideas)

Please answer explicitly:

1. Which **3–5 invariants** would you prove first if engineering time is scarce? Why those?  
2. What is the smallest **scenario / test shape** that gives the most confidence per line of code?  
3. Where is the protocol most likely still under-specified (not just under-tested)?  
4. Which “security situations” above are overrated noise for XLN’s bilateral model, and which are under-rated?  
5. If you could add only **one** continuous runtime assert (prod or scenario), what would it check?  
6. What would you deliberately *not* automate yet, and leave as manual adversarial review?

Challenge this prompt. If the right audit frame is different, say so and propose a better frame.

# bilaterality: the killer feature

the killer feature is bilaterality. state isn't a giant shared ledger—it's a duplex mesh where each relationship processes independently in parallel. that's where the scalability comes from.

---

## the insight

traditional blockchains model state as one big table everyone fights over:

```
Global State = { A: 100, B: 50, C: 75, ... }
                 ↑ single bottleneck, consensus on everything
```

xln realizes state is naturally a graph of pairwise relationships:

```
A ↔ B: { A_to_B: 20, B_to_A: 15 }
A ↔ C: { A_to_C: 10, C_to_A: 5 }
B ↔ C: { B_to_C: 8, C_to_B: 12 }
       ↑ independent consensus domains, all parallel
```

## why this matters

**no global bottleneck = no ceiling**

- each edge (bilateral account) is its own consensus domain
- A↔B can settle while C↔D settles simultaneously
- system scales with the mesh, not against it
- adding entities increases capacity (more edges), not congestion

**bilateral accounts are:**
- **isolated**: failure in A↔B doesn't propagate to C↔D
- **parallel**: all edges process transactions concurrently
- **deterministic**: both sides compute identical state independently
- **Byzantine-resistant**: requires collusion between both parties, not global majority

## the architecture

```
Entity A:
  accounts = {
    B: AccountMachine(A, B),  ← independent state machine
    C: AccountMachine(A, C),  ← independent state machine
  }

Entity B:
  accounts = {
    A: AccountMachine(B, A),  ← mirror of A's machine
    C: AccountMachine(B, C),  ← independent state machine
  }
```

each `AccountMachine` maintains:
- **deltas**: balance changes per entity (canonical state)
- **frameHistory**: sequence of signed frames (audit trail)
- **commitQueue**: pending transactions awaiting signatures

both sides verify:
```typescript
const ourState = encode(accountMachine.deltas);
const theirState = encode(theirExpectedDeltas);

if (!buffersEqual(ourState, theirState)) {
  throw new Error('BILATERAL CONSENSUS FAILURE');
}
```

## comparison

| architecture | bottleneck | scalability | isolation |
|-------------|-----------|------------|-----------|
| global ledger (bitcoin/ethereum) | entire chain | O(1) tps ceiling | none—global state |
| sharding (eth2) | shard validators | O(n shards) | weak—cross-shard complexity |
| bilateral mesh (xln) | individual edges | O(n²) edges | perfect—pairwise isolation |

## why others don't do this

most systems optimize for:
- **single source of truth** (easier to reason about)
- **global total ordering** (simpler consensus)
- **broadcast efficiency** (one message to all)

xln optimizes for:
- **parallel execution** (independent state machines)
- **relationship locality** (only parties involved need to agree)
- **mesh scalability** (more connections = more capacity)

the tradeoff: bilateral consensus requires both parties to sign every frame. but this is the feature, not the bug—it enforces mutual agreement at the relationship level, not global level.

## the hive effect

once you see state as a mesh of independent bilateral relationships, the system's effectiveness becomes obvious:

- **10 entities** = 45 bilateral accounts (10 choose 2)
- **100 entities** = 4,950 bilateral accounts
- **1,000 entities** = 499,500 bilateral accounts

each account is a separate consensus domain. no coordination overhead. pure parallel execution.

**that's the scalability unlock.**

# Dispute operation observation

The owning browser test required the entire batch card to disappear after broadcasting a dispute start. In the retained failure the start was already recorded at J40 and the same card displayed the scheduler's subsequent finalize batch.

The assertion now follows the submitted Dispute start operation with the original five-second budget. Production code, signed response policy, finalization, exact reserve collection and recovery assertions are unchanged.

Both owning browser cases passed. The lifecycle collected exactly 100,000,000 USDC base units into reserve, observed two confirmed batches, closed the Account, and retained the exact receipt IDs after reload. See [proof.json](proof.json) for source and evidence hashes. This is private EVM evidence, not public Ethereum/native TRON or mainnet acceptance.

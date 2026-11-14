# Codex bounded lifecycle addendum — reopen-review-v3

**Result: BUG: CONFIRM and FIX: CONFIRM for all six bounded claims, retained from v2.** The sole constructor change preserves the reviewed ordering, authority and cleanup behavior. No concrete regression was identified in this immutable delta.

Model: **gpt-6.1-sol**, inherited; one AI family. The existing smoke2 produced 36n before and 323n after the intended multiplication fix. This is not another AI family, three-AI quorum, whole-release approval or a fresh execution certificate.

## Immutable identity

Base SHA: `019d45beb5954e77fe806d643845f6a4dca4fa82`.

I verified all 29 owned source hashes and compared their bytes with v2: 28 unchanged; only `core/runtime/recovery/j-rpc-replace.ts` differs. Its complete change is `WeakMap` to `Map` at line 14. No policy, financial state, durable field, key path or other source change is present in this packet.

- Manifest SHA256: `d202e9afa5f7b4794af93bda4e32b58363b7975ad2d673630bd81845fa5ec1b7`.
- Since-v2 delta SHA256: `f00e987994dc8a1db1c6384d420a4aaf9babbc831c9dd07aaf04f2aefbd878fe`.
- Changed owned source SHA256: `ef251e220fd738a8093298598e3df311a5fdf0823478bcc749c49c5f98719cdf`.

The earlier [v2 review](../reopen-review-v2/codex-review.md) remains historical and unchanged. Its source findings are retained because the comparison above proves the exact unchanged bytes, with the collection semantics reconsidered below. All source references here mean v3 `owned/` paths.

## Six claims

| Claim | BUG | FIX | Evidence retained or rechecked |
| --- | --- | --- | --- |
| 1. Offline local reopen | CONFIRM | CONFIRM | Gate.tsx:290-333,358-368; hosted.ts:402-413,502-505; adapter.ts:158-163. These files are byte-identical to v2. Local canonical recovery and typed transient tolerance are unchanged. |
| 2. Wrong chain classified transient | CONFIRM | CONFIRM | rpc-network.ts:10-20; j-adapter-restore.ts:190-196. Exact chain mismatch remains a hard INVALID_ARGUMENT; collection choice cannot broaden transport tolerance. |
| 3. Catch-up operation/session ownership | CONFIRM | CONFIRM | chain-catchup.ts:36-40 rejects stale ownership before global claim; hosted.ts:309-345 retains every imported Entity jurisdiction target. Both files are identical to v2. |
| 4. Verified owner EVM RPC replacement | CONFIRM | CONFIRM | j-rpc-replace.ts:76-104 validates scope and private candidate; 105-124 preserves latest-verified ordering and synchronous accepted binding/adapter publication; 125-135 preserves cleanup and release. Map lifecycle is detailed below. Native TRON remains explicitly unsupported at 83-84. |
| 5. Settings remount RPC display | CONFIRM | CONFIRM | Networks.tsx:35-46 still reads the exact accepted live binding. Neither display nor the publication path changed. |
| 6. Exact secondary EOA before replay/signing | CONFIRM | CONFIRM | replay.ts:171-184, live-restore.ts:42-48, bootstrap.ts:123, wallet-signers.ts:12-25 and keys.ts:19-25 are unchanged. No new signer authority or durable inventory is introduced. |

## Strong Map lifetime and cleanup

The Map now strongly retains a Runtime while at least one replacement claim is pending. Correctness therefore relies on explicit release rather than garbage collection.

The release invariant remains sound for every settled path:

- Before a claim exists, missing jurisdiction, unsupported transport/native policy, invalid URL or revoked owner rejects at lines 76-87 without inserting an entry.
- Lines 16-22 create one sequence per exact Runtime and canonical jurisdiction ref, increment pending once, and assign a monotonically increasing request. The non-awaiting setup immediately enters the try/finally at 95.
- Success, failed connection/verification, superseded candidate and revoked owner all leave through finally at 134-135. A candidate-close rejection becomes an AggregateError at 129-130, and still executes that same finally.
- The final pending operation deletes its jurisdiction entry at 27; the outer Runtime entry is deleted only when the per-Runtime map is empty at 28. Success on another jurisdiction is independent.
- While an older operation remains pending, its sequence cannot be removed or reset. A newer verified choice remains visible to the older operation's checks at 92/104/118. A newer failed candidate does not advance verified at 107.
- There is no await between the final owner/order check at 118 and adapter/binding publication at 119-124. The constructor substitution adds no interleaving or stale rollback.
- The exact-session and watcher/persistence pause checks at 33-42 still run before connect, after verification and after the retirement-close await. Lock/switch cancellation cannot authorize attachment to a revoked session.

Thus completed attempts leave no process-global Runtime/identity registry entry. No roots, JReplica.rpcs, balances, committed events or readiness ownership are mutated by this collection change.

**Limit:** a genuinely never-settling awaited connection, verification or close operation remains pending and the strong Map retains its Runtime until settlement. This delta adds no abort/deadline and does not establish bounded cancellation latency or guarantee release while external I/O never resolves. Weak-to-strong retention changes that garbage-collection property; it does not create a false claim that finally executes before an await settles. I did not identify an actual never-settling canonical adapter path in this bounded packet, and this is not a demonstrated counterexample to the six stated behavior claims.

## Evidence boundaries

No live ~/xln reads, source edits, tests, stands, models, P1 operations or denied diagnostic were performed. Only this report was written. No claim of independent fresh test execution is made.

The v2 source review and its recorded terminal receipts remain historical. Root reports the existing collection guard now exits 0; exact 22-test and lint reruns were ongoing when this packet was prepared. I do not mark those reruns, the revised full check or browser artifact binding green from that report alone.

Recommended next action: finish the exact v3 focused/lint/full-check receipts and bind any required product acceptance to this immutable candidate before integration.

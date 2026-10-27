# Authenticated dispute calldata recovery

## Invariants

- I1: Try the executed direct Depository call at offset zero first; a matching
  direct call returns without scanning the transaction for embedded selectors.
- I2: Recover the real dispute through ABI-canonical forwarding wrappers,
  including `processBatch(actual, decoys, 1)` and arbitrarily deep bytes wrappers.
- I3: Bound decoded bytes per transaction by O(calldata length); never repeatedly
  decode overlapping wrapper suffixes or decode every unauthenticated candidate.
- I4: No attacker-controlled decoy arrangement may consume the work available to
  the real candidate. Neither ordering, shortest-first nor first-found is authority.
- I5: Never cache budget exhaustion as a terminal result. A retry must progress
  or expose a typed, operator-visible error with the transaction and work limit.
- I6: Accept only a proof body whose computed hash equals the authenticated event's
  hash; also match event kind, counterentity, nonce and proposer where applicable.

## Algorithm

1. Keep receipt membership and signed EVM/TRON transaction authentication intact.
   Cache authenticated calldata, not an incomplete decoded candidate list.
2. At offset zero, follow the pinned Depository ABI offset chains to dispute
   entries and their proof bodies. Check event metadata and hash raw body spans
   before materializing a body. On a match, decode and validate only that body.
3. Otherwise scan every byte for supported selectors, including inside canonical
   outer calls. Never advance by a candidate's claimed length. Wrappers need no
   recursive decoding, traversal-depth limit or execution-provenance guess.
4. Validate canonical offset chains using the pinned processBatch/batch and
   watchtower schemas. Check bounds, contiguous tails, counts and ABI padding
   without ethers decoding or re-encoding candidates. Memoize schema/start/end
   checks and deduplicate identical absolute body spans and hashes.
5. Hash the raw tuple with the ABI single-dynamic-argument prefix (one word,
   value 32): this is exactly `keccak256(abi.encode(ProofBody))`, not merely the
   tuple tail's hash. Claimed hash fields alone never authenticate a body.
6. Decode only authenticated matching spans, once each. Reuse their validated
   bodies across events. Metadata distinguishes entries sharing a proof body.
   Finalization sidecar fields remain bound to finalizationEvidenceHash.

The scanner and memoized structural checks are linear in input positions for
the fixed ABI. Contract byte/count caps bound each raw hashing span; deduplication
prevents charging shared spans twice. ABI materialization is limited to matching
body spans, never wrapper calls; decoded bytes remain linear. No shared decoy
decode budget, candidate-count cutoff or wrapper-depth budget exists.

Unexpected resource-limit failures must carry a typed operator signal and must
evict their pending cache entry; they cannot masquerade as evidence-not-found.
Malformed candidates are ignored only before authentication. A matched span that
fails canonical validation is an explicit evidence error, never accepted data.

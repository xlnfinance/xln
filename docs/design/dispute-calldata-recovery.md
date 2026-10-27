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
- I7: Any calldata Solidity accepts for the executed direct call is recoverable.
  Non-zero bytes padding and gapped or out-of-order tails are valid encodings,
  not authority. Existing contract byte/count limits and I6 still apply.

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
7. If the raw scan has no matching evidence, decode the bounded direct call once
   with the existing validated ABI decoder, only when offset zero has a supported
   Depository selector. Never decode embedded noncanonical candidates. Recompute
   every candidate body hash before event matching (including dispute starts,
   whose claimed hash alone is insufficient). Apply the same direct-call recovery
   to finalization sidecars; the resolver still verifies their event commitment.

The scanner and memoized structural checks are linear in input positions for
the fixed ABI. Contract byte/count caps bound each raw hashing span; deduplication
prevents charging shared spans twice. ABI materialization is limited to matching
body spans, never wrapper calls; decoded bytes remain linear. No shared decoy
decode budget, candidate-count cutoff or wrapper-depth budget exists.

Unexpected resource-limit failures must carry a typed operator signal and must
evict their pending cache entry; they cannot masquerade as evidence-not-found.
Malformed candidates are ignored only before authentication. A matched span that
fails canonical validation is an explicit evidence error, never accepted data.

## Implementation details

- `DisputeCalldata` compiles the pinned Depository and DepositoryBounds schemas
  once. Its lazy entry iterator checks offset zero before advancing by one byte
  at a time. Wrappers are opaque bytes; their nesting does not add stack depth.
- Before walking a call, the last bytes offset/length bounds its intrinsic end
  by the executable-call byte ceiling. Array head sizes and bytes lengths are
  also bounded by that fixed ceiling before traversal. Schema/start memoization
  stores intrinsic ends (including rejection), so a result does not depend on
  the enclosing candidate's limit. Enclosing tails must end exactly where
  their canonical offsets/lengths require. A decoded Batch may end before its
  declared bytes length: Solidity ignores trailing batch bytes, including through
  canonical forwarding wrappers. Scalar widths and zero padding are checked
  without decoding on the raw path.
- The proof reader matches event metadata, hashes the exact raw body with the
  single-tuple offset prefix, then materializes and validates only that body.
  Raw hashes are cached by absolute span; validated bodies are cached by hash
  and reused only after each event's metadata is matched again.
- Finalization sidecars are read directly from canonical raw fields, without
  decoding bodies. They remain candidates until the existing resolver verifies
  `finalizationEvidenceHash`; delegated watchtower finalization still uses the
  effective empty inner signature.
- Readers cache authenticated calldata and its structural memoization. Any
  failure evicts the transaction entry. Allocation/budget failures are surfaced
  as `DisputeCalldataResourceError`, carrying the transaction and original
  resource-limit message. A successful body lookup does not enumerate later
  embedded candidates.
- A Solidity-valid direct call rejected by canonical span checks uses the existing
  strict decoder once, after the raw scan. Its input is bounded by the executable
  call byte ceiling. Full direct-call and batch decoding remains O(calldata length)
  for the fixed contract limits; canonical matching calls still decode only their
  matching proof body. Protocol validation errors such as TOKEN_LIMIT and
  TRANSFORMER_LIMIT retain their original identity; only the exact calldata budget
  error code and allocation failures become resource errors.
- EVM authentication copies all signed envelope fields into ethers and compares
  the recomputed hash with the receipt-attested transaction ID. It avoids
  passing the RPC transaction object itself to `Transaction.from`, which reads
  expensive `hash`/`from` getters repeatedly. Native TRON authentication is
  unchanged.

The exported call-span inspection helper retains its outer-span-only inspection
contract for existing callers/tests. Financial recovery uses the entry iterator,
which never skips nested selectors or decodes wrapper calls.

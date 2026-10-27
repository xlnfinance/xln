# Authenticated dispute calldata recovery

## Invariants

- I1: Try the executed Depository call at offset zero first. A matching direct
  call returns without scanning embedded selectors. Other candidates never
  disable the direct path.
- I2: Recover disputes through ABI-canonical forwarding wrappers, including
  `processBatch(actual, decoys, 1)` and arbitrarily deep bytes wrappers. A
  wrapper's first bytes argument may itself contain a call rather than a Batch.
- I3: Decoding work is O(calldata length), within the executing contract's
  limits. Decode a direct call's referenced arguments and Batch once, caching
  its evidence. Never decode every embedded candidate or overlapping wrapper
  suffix. Embedded recovery materializes only authenticated proof bodies.
- I4: Decoy order, size, count and nesting cannot spend the real candidate's
  recovery budget. Neither shortest-first nor first-found is authority.
- I5: Resource exhaustion is a typed operator-visible error. Evict failed
  transaction cache entries so a retry can progress.
- I6: Compute `keccak256(abi.encode(ProofBody))` and match the authenticated
  event's hash, event kind, counterentity, nonce and proposer where applicable.
  A copied claimed hash is insufficient. Finalization sidecars separately match
  the authenticated `finalizationEvidenceHash`.
- I7: Direct decoding follows solc's generated ABI decoder, enforced by seeded
  differential testing against a deployed Solidity harness on the real EVM.
  Head offsets may be unaligned, overlap, or point inside the head. Bytes need
  only their declared length, with no padding requirement. Unreferenced gaps,
  dirty padding, extra words and trailing calldata do not change decoding.

## Direct calls

Depository exposes `processBatch(bytes,bytes,uint256)` and
`watchtowerCounterDispute(bytes32,FinalDisputeProof,uint256,uint256,bytes)`.
Batch finalizations use `processBatch`; there is no separate external finalize
entry point.

`DisputeCalldata.directCallData()` checks the external ABI and, for processBatch,
its inner `abi.decode(encodedBatch, (Batch))` layout. The shared schema validator
checks only solc's head/offset/length bounds and scalar cleanup. It never checks
contiguous tails, minimum offsets, alignment, padding or scanner byte caps.
An offset too large for a JS array index is necessarily outside the available
Uint8Array; this also rejects offsets above solc's uint64 ceiling.

ethers loose decoding accepts bytes tails ending without rounded padding.
Its boolean and narrow-integer decoders are more permissive than solc, so the
schema validator rejects dirty scalar values before ethers can coerce them.
The same validator checks all fields of the decoded Batch, including unrelated
operations, as Solidity's memory decoder does. Recovery reads dispute fields
from that ABI Result without applying unrelated runtime submission conversions.
Proof bodies are materialized into plain data and authenticated by I6.

For processBatch, reconstruct only the two referenced bytes regions and nonce
before ethers decoding. Arbitrarily large unreferenced gaps and trailing zero
runs are never passed to ethers. Watchtower arguments use loose decoding too.
Successful direct evidence is cached independently of embedded candidates;
event metadata and commitments are checked on every lookup.

## Embedded candidates

When the direct layout cannot decode a Batch, or its evidence does not match,
scan every nonzero byte offset for supported selectors. Never advance by a
candidate's claimed span. Only this embedded path requires canonical ABI spans:
contiguous ordered tails, clean padding, scalar widths and contract byte/count
caps. Memoize schema/start/end checks and deduplicate body spans and hashes.
Wrappers remain opaque bytes, so nesting adds no decoder recursion.

Match raw event metadata first. Hash the raw ProofBody tuple with its
single-dynamic-argument offset prefix (32), then decode only a matching body.
Finalization sidecars are read from canonical fields and remain untrusted until
the resolver checks the event commitment. Watchtower finalization clears the
repeated inner signature, matching Depository's executed parameters.

Receipt membership, block binding and signed EVM/TRON transaction authentication
are unchanged. Readers cache authenticated calldata, never a truncated list of
candidates. Resource failures preserve their typed transaction evidence.
The exported call-span inspection helper retains its outer-span-only contract;
financial recovery visits every embedded candidate without skipping nesting.

## Differential gate

`core/__tests__/jurisdiction/rpc/calldata/solc-differential.test.ts` compiles the
harness with the repository's solc, imports production `Types.sol`, deploys its
creation bytecode into the existing EthereumJS EVM, and calls both exact input
signatures. It first smoke-tests a known proof hash. The harness forces external
arguments and the full memory Batch through solc decoding, returning the decoded
proof body's hash or reverting. No RPC sockets or mocked decoder are involved.

Seed `0x51c0dec` generates 2,400 layouts covering small/unaligned/overlapping
heads, nested offsets, dirty scalars and padding, unpadded inner and outer bytes,
gaps, extra words, trailing decoys and forwarding prefixes. Valid start layouts
keep their claimed proof hash consistent, so I6 is tested without confusing a
forged hash with an ABI mismatch. Accepted layouts must recover the same hash;
rejected layouts must produce no direct evidence. Rejected forwarding envelopes
may still legitimately contain recoverable embedded calls.

The test reports accepted/rejected counts and mismatch count and enforces a
30-second ceiling. Existing counterexamples retain semantic assertions; direct
calls now assert a linear referenced-argument decode budget and once-per-call
caching, while embedded candidates retain the body-only decode budget.

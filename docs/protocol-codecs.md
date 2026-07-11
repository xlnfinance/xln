# Protocol codecs and account commitments

This document defines the deterministic encodings used by the pre-mainnet xln
runtime. A protocol version is intentionally not carried yet: no public network
state exists to migrate. Any encoding change must update the golden vectors and
this document in the same release.

## Codec boundary

- Consensus account-state leaves use tagged canonical RLP. Object keys are
  sorted lexicographically; map keys are sorted by their encoded RLP bytes; set
  values are sorted by encoded bytes. Numbers, bigints, strings, booleans and
  null have distinct type tags.
- Runtime storage and WebSocket transport use the tagged MessagePack codec in
  `runtime/storage/binary-codec.ts`. The leading codec byte is part of the wire
  format. WAL reads retain legacy tagged-JSON compatibility; new writes are
  MessagePack only.
- JSON is a developer representation only. `serializeWsMessageForDebug` and the
  IndexedDB inspector expose it explicitly; JSON bytes are not accepted as the
  production WebSocket wire format.

## Account state root

`computeAccountStateRoot` builds a radix Merkle tree. Every leaf key is
`keccak256(utf8("xln.account.state." + path))`; every value is canonical tagged
RLP. The leaves are:

1. `identity`: chain id, Depository address, canonical left/right entity ids and
   shared dispute watch seed.
2. `financial`: complete delta records, bilateral credit limits, account status,
   `jNonce` and dispute-delay configuration.
3. `commitments`: HTLC locks, pull commitments, swap offers and generic custom
   DeltaTransformer subcontracts (`transformerAddress`, bytes batch, allowances
   and optional argument commitments).
4. `jurisdiction`: finalized J height, both observation sets and finalized
   J-event chain.
5. `lifecycle`: settlement workspace, active dispute and pending withdrawals.
6. `rebalance`: bilateral requests, prepaid-fee state and observed counterparty
   fee policy.

The account mempool, pending frame, Hanko maps/caches, rollback counters,
`pendingForward`, proof caches and local automation policy are excluded. They are
not mutually agreed current account state. Entity-private rebalance policy,
scheduler and retry state are committed separately by `accountShadowRoot` in the
owner entity frame and are never sent to the counterparty.

## Frame delivery

An `AccountInput` can carry an ACK, a proposal, or both. The two epochs never
share signatures:

```text
frame_ack
|-- ack
|   |-- height
|   |-- frameHanko
|   `-- optional disputeSeal
`-- proposal
    |-- frame
    |-- frameHanko
    `-- optional disputeSeal
```

A dispute seal is `{hanko, hash, proofBodyHash, proofNonce}`. It is regenerated
only when the Solidity ProofBody changes or its nonce has been consumed on-chain.
An unchanged seal is transported beside later frame Hankos without incrementing
the proof nonce.

`nextProofNonce` is the next locally reserved nonce for a fresh dispute proof.
`jNonce` is the nonce finalized by the jurisdiction machine. A fresh proof uses
`max(nextProofNonce, jNonce + 1)`. Account frame height is unrelated to either.

## Payment delivery modes

- `instant`: ordinary atomic HTLC with a short bounded deadline. Every hop must
  complete while the route is live.
- `async` (default): the same refundable HTLC and the same account mempool, with
  a deterministic 24-hour timestamp/height window. No second inbox or Merkle
  HTLC subsystem exists.
- `trusted`: irrevocable direct payment through the penultimate route entity.
  The declared gateway must equal that hop. The gateway-proposed bilateral frame
  and its Hanko are the receipt; after it commits, refund semantics do not apply.

The frame proposer is always the payer. `fromEntityId` and `toEntityId` are
assertions only and are rejected if they disagree with the canonical proposer
direction.

## Golden vectors

`runtime/__tests__/frame-hash-golden.test.ts` pins account and entity frame
hashes. `runtime/__tests__/account-state-root.test.ts` pins field inclusion and
ephemeral-state exclusion. Any intentional encoding change must update both the
vectors and this specification after independently inspecting the new payload.

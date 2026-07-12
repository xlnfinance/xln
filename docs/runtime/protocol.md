# Protocol Primitives

[Up: runtime map](./overview.md) | [Account machine](./account.md) | [Jurisdiction machine](./jurisdiction.md) | [Extensions](./extensions.md)

`runtime/protocol/` contains reusable deterministic encodings and money primitives. These modules do not own loops, sockets, databases, or UI state.

## Source And Main Methods

- [`protocol/htlc/`](../../runtime/protocol/htlc) - `hashHtlcSecret`, onion envelopes, hash-ladder encode/verify.
- [`protocol/payments/`](../../runtime/protocol/payments) - payment mode and delivery primitives.
- [`protocol/settlement/`](../../runtime/protocol/settlement) - settlement value objects and deterministic helpers.
- [`protocol/dispute/`](../../runtime/protocol/dispute) - dispute proof projections and compact argument encoding.
- [`hanko/`](../../runtime/hanko) - `signEntityHashes`, `verifyHankoForHash`, quorum aggregation.

## Invariant

Encoders are canonical: field order, numeric representation, and collection sorting are explicit. JSON may support debugging, but signed/hash inputs use one stable protocol representation.

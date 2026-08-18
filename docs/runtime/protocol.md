# Protocol Primitives

[Up: runtime map](./overview.md) | [Account machine](./account.md) | [Jurisdiction machine](./jurisdiction.md) | [Extensions](./extensions.md)

`core/protocol/` contains reusable deterministic encodings and money primitives. These modules do not own loops, sockets, databases, or UI state.

## Source And Main Methods

- [`protocol/htlc/`](../../core/protocol/htlc) - `hashHtlcSecret`, onion envelopes, hash-ladder encode/verify.
- [`protocol/payments/`](../../core/protocol/payments) - payment mode and delivery primitives.
- [`protocol/settlement/`](../../core/protocol/settlement) - settlement value objects and deterministic helpers.
- [`protocol/dispute/`](../../core/protocol/dispute) - dispute proof projections and compact argument encoding.
- [`hanko/`](../../core/hanko) - `signEntityHashes`, `verifyHankoForHash`, quorum aggregation.

## Invariant

Encoders are canonical: field order, numeric representation, and collection sorting are explicit. JSON may support debugging, but signed/hash inputs use one stable protocol representation.

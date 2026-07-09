# Runtime Delivery Boundary Scan

Last refreshed: 2026-07-09.

Run:

```bash
bun run security:delivery-boundary
```

This is an executable source-shape and behavior scan for the runtime delivery
boundary. It keeps entity-input transport decisions in one typed result shape
instead of allowing boolean sends, string parsing, or duplicated retry logic to
creep back into call sites.

## Current Result

- Relay is the official baseline for remote entity-input delivery.
- Direct delivery is an opportunistic fast path. A miss or stale socket falls
  through to the same typed delivery boundary instead of claiming success.
- Raw `sendEntityInputRaw()` is limited to the P2P adapter and websocket client.
- Runtime routing, RuntimeP2P, relay-router, relay-store, direct runtime
  websocket, hub-node, and market-maker node all expose or consume
  `DeliveryResult` metadata.
- Retry/drop/fatal decisions live behind shared delivery helpers:
  `isDeliveryDelivered`, `shouldRetryDelivery`, `requireDeliveryDelivered`, and
  `classifyUndeliveredDelivery`.
- Relay pending flush retains unsent current and later messages when a socket
  send fails instead of dropping them before delivery is confirmed.

## Open Manual Review

- This scan proves the source boundary and helper semantics. It does not prove
  liveness under every relay partition or adversarial ACK interleaving.
- ACK interpretation still belongs to entity/account consensus tests. Delivery
  only proves encrypted transport acceptance, deferral, retry, or terminal
  failure metadata.

# Networking Map

This folder owns runtime-to-runtime transport and gossip.

## What it does

- direct WS transport between runtimes
- relay-authenticated messaging
- gossip/profile exchange
- runtime hello auth and encryption handling

## Main files

- `p2p.ts`
  High-level lifecycle, endpoint selection, reconnect policy, and direct/relay decisions.
- `ws-client.ts`
  Client transport handling.
- `direct-runtime-bun.ts`
  Direct runtime WS server path.
- `gossip.ts`
  Gossip storage and sync behavior.
- `hello-auth.ts`
  Runtime hello signature validation.
- `p2p-crypto.ts`
  Transport encryption helpers.

## Non-goal

These modules do not define financial validity. They only deliver or reject
messages before `runtime.ts` and consensus code see them.

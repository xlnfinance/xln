# Server Map

This folder owns the runtime HTTP/WS API surface.

## What it does

- health, metrics, debug, ingress receipts
- hub discovery and public entity lookup
- faucet/control endpoints
- RPC proxy safety

## Main files

- `runtime-input-control.ts`
  Control-plane runtime ingress and receipt status.
- `ingress-receipts.ts`
  Request tracking from accepted -> observed/expired.
- `health-api.ts`
  Runtime/public health summary.
- `rpc-proxy.ts`, `rpc-ws.ts`
  RPC forwarding and runtime adapter WS surface.
- `hub-discovery.ts`, `entity-lookup.ts`
  Public discovery helpers.
- `offchain-faucet.ts`, `reserve-faucet.ts`
  Testnet bootstrap endpoints.

## Called by

- `server.ts`

## Audit note

Treat this folder as operator/API surface, not protocol truth. Bugs here can
hurt liveness or UX, but correctness still lives in runtime/consensus/storage.

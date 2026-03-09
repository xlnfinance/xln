# Runtime Map

This folder already has the right coarse split. The current goal is to keep behavior stable and make the boundaries explicit before moving more files.

## Core consensus

- `runtime.ts`: runtime loop, persistence, reload, ingress, and exports
- `account-consensus.ts`: bilateral account-frame consensus
- `entity-consensus.ts`: entity-frame consensus and machine application
- `types.ts`: shared runtime model types

## Transaction application

- `account-tx/`: bilateral account tx handlers and dispatcher
- `entity-tx/`: entity tx handlers, proposals, j-events, validation

## Network / relay

- `networking/`: p2p client, gossip, ws transport, runtime ids
- `relay/`: relay helper modules
- `relay-router.ts`, `relay-store.ts`: relay server behavior

## Routing / markets

- `routing/`: graph building, pathfinding, fees, capacity
- `orderbook/`: swap-market core logic and types

## Ops / orchestration

- `orchestrator/`: daemon control and custody bootstrap helpers
- `scripts/`: E2E mesh control, checks, smoke tests, runners
- `server.ts`: daemon HTTP / WS API surface

## Integration

- `jadapter/`: chain bridge and browser VM adapters
- `typechain/`: generated contract bindings

## Scenarios / tests

- `scenarios/`: scripted system scenarios and parser
- `__tests__/`: runtime unit tests

## Safe cleanup rule

Do not move the consensus and apply files while they are simultaneously carrying behavior changes. First stabilize behavior, then move modules in one mechanical pass.

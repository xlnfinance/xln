# JAdapter Map

This folder owns the bridge between runtime state and J-layer chains.

## Production-relevant files

- `rpc.ts`
  Real RPC/anvil adapter.
- `helpers.ts`
  Shared deploy/query/submit helpers.
- `watcher.ts`
  Chain event polling and J-event feed.
- `runtime-api.ts`
  Runtime-facing helper calls.

## Legacy / dev-oriented files

- `browservm.ts`
- `browservm-provider.ts`
- `browservm-ethers-provider.ts`
- `browservm-events.ts`
- `browservm-registry.ts`
- `browservm-state.ts`

These stay in the repo for dev/demo flows, but they should not dominate public
testnet or runtime architecture reviews.

## Audit note

For public testnet work, read `rpc.ts` and `watcher.ts` first. BrowserVM code is
not the source of truth for settlement behavior.

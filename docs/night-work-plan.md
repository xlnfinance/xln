# Handoff

The only handoff. Replace this file on each handoff; never append history (git keeps it).
The live queue is [todo.md](../todo.md); scope and authority are in [AGENTS.md](../AGENTS.md).

- Main, origin and both Macs: `167d66b8b` (2026-11-14), clean trees.
- Last green command: pre-push full verify on `167d66b8b` (`VERIFY_PASS`), Mac Studio.
- First red command: none on main.
- Owner 2026-11-14: land after a green full Studio verify without the three-AI quorum. One
  operator drives Studio over `ssh mac-studio`; the old codex drivers stay held.

## Landed today

- `02c6a88f8`, `3cd8c5380`, `0f08a4f08`: the 17-day uncommitted tree (Svelte wallet parity, J RPC
  replacement recovery, registry-backed orderbook dimensions, evidence).
- `ef2c5ed90`, `d9cd92b59`, `91fbfaa47`: typed ids and unit boundaries from `~/xln-status`.
- `167d66b8b`: keys-preserving reset of retired testnet state, Svelte wallet only.

## Not landed, on purpose

- `~/xln-watcher9` (dispute calldata recovery): superseded. Its files no longer exist on main
  since dispute events carry the full proof body.
- The tests-first red test from `~/xln-status` (typed salvage zero-fill status): no implementation yet.

## Next single command

```bash
ssh mac-studio 'cd ~/xln && bun run stand:status'
```

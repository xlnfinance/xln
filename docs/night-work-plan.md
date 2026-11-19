# Handoff

The only handoff. Replace this file on each handoff; never append history (git keeps it).
The live queue is [todo.md](../todo.md); scope and authority are in [AGENTS.md](../AGENTS.md).

- Main, origin, Mac Studio and the MacBook: `4a10c6973` (2026-11-19) plus this handoff commit.
- Last green command: pre-push full verify on `bdc53c7b4` (`VERIFY_PASS`), Mac Studio.
- First red command: unknown. `4a10c6973` (dispute epoch in the Account nonce) was pushed with
  `--no-verify` at the owner's request. On those bytes the contract suite (275) and `bun run check`
  passed; the updated watchtower tests, the updated Rust expectation in
  `rscore/crates/entity-kernel/src/j_events/ingress.rs` and the full verify were not run.
- Artifact path: job logs in `~/agent-jobs/claude-epoch-20261119/` and
  `~/agent-jobs/claude-audit-20261114/` on the Studio.
- Outside git on the MacBook only: the film (`design/film/`, `docs/ru/film/`, `output/`, one
  `film` entry in `.claude/launch.json`). The owner keeps it separate.
- Not merged: `origin/testnets_deploy` (22 commits by another author, 13 behind main).
- Studio worktrees `~/xln-land14` and `~/xln-work14` hold nothing that is not on main.

Setup for a new control machine and the landing recipe: [mac-studio.md](mac-studio.md#driving-the-studio-from-a-control-mac).
Owner decisions of 2026-11-14 and 2026-11-19: [owner-profile.md](owner-profile.md#decisions-2026-11-14-and-2026-11-19).

## Next single command

```bash
ssh mac-studio 'cd ~/xln && bun run check && bun run test:contracts:full && (cd rscore && cargo test -q --workspace) && bun test --timeout 180000 core/__tests__/security/'
```

## Remaining final gates

Everything in [todo.md](../todo.md); item 0 is closed only by the command above going green.

# Handoff

The only handoff. Replace this file on each handoff; never append history (git keeps it).
The live queue is [todo.md](../todo.md); scope and authority are in [AGENTS.md](../AGENTS.md).

- Main, origin, Mac Studio and the MacBook: this handoff commit on top of `3c9277e32` (2026-11-19).
- Last green command: pre-push full verify on `3c9277e32` (`VERIFY_PASS`), then on the same bytes
  `cargo test --workspace` (51 suites) and `core/__tests__/{security,jurisdiction,entity,account}`
  (1,440 tests). This covers the dispute epoch in the Account nonce (`4a10c6973`).
- First red command: none known.
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
ssh mac-studio 'cd ~/xln && bun run stand:status'
```

## Remaining final gates

Everything in [todo.md](../todo.md).

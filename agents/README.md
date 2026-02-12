# Agent Collaboration (Active)

Use `agents/workflow.md` as the canonical protocol.

## Quick Start
1. Create feature folder:
   - `agents/{agent}/{feature}/`
2. Add `00-plan.md` from template.
3. Create isolated worktree:
   - `git worktree add ~/.{agent}-worktrees/xln/{feature} -b {agent}/{feature}`
4. Implement + test in that worktree.
5. Post `NN-progress.md` and request review.
6. Address findings.
7. Human merges when severity gates pass.

## Key Rules
- Never develop in `/Users/zigota/xln` main worktree.
- Use severity-based merge gates (not confidence-only gates).
- Keep notes short; no full reasoning logs.
- Use reviewer matrix from `agents/AGENTS.md`.

## Shortcuts
- `y`, `n`, `?`, `!`, `1-9`

## Templates
- `agents/_templates/00-plan.md`
- `agents/_templates/progress.md`
- `agents/_templates/review.md`

# AI Agent Collaboration Protocol v2 (ACTIVE)

This is the single source of truth for collaboration in `agents/`.

## Goals
- Safe parallel work via isolated worktrees.
- Objective review via severity gates.
- Short docs that fit low-context sessions.

## Control Shortcuts
- `y`: approve and continue
- `n`: reject (reply with reason)
- `?`: show status
- `!`: emergency stop and state dump
- `1-9`: pick numbered option

## Minimal Structure
```text
agents/
├── workflow.md
├── AGENTS.md
├── README.md
├── _templates/
├── _archive/
└── {agent}/{feature}/
    ├── 00-plan.md
    ├── NN-progress.md
    └── {reviewer}N.md
```

## Lifecycle
1. Plan: create `00-plan.md`.
2. Develop: work only in `~/.{agent}-worktrees/xln/{feature}` on `{agent}/{feature}`.
3. Ready for review: post progress report with commit SHA and tests run.
4. Review: reviewers write findings with severities.
5. Address: fix findings and post updated progress report.
6. Merge: human merges when gates pass.
7. Archive: move feature folder to `_archive/`.

## Merge Gates (Severity-Based)
All must pass:
- Open `CRITICAL`: `0`
- Open `HIGH`: `0`
- Required reviewers approved (see `agents/AGENTS.md`)
- Required tests green
- Breaking changes include migration notes

`MEDIUM` and `LOW` can be deferred only with a tracked follow-up item.

## Reviewer Matrix
- Contracts, signatures, auth, ABI, settlement logic: `codex` required.
- Cross-module architecture/stateflow/runtime topology: `gemini` required.
- Small isolated UI/content changes: optional second reviewer.

## Plan Changes
- `00-plan.md` is frozen once coding starts.
- Scope changes go in `00-plan-amendment.md` (append-only).

## Progress Logging
Milestone updates only:
- `start`
- `ready-for-review`
- `post-fix`
- `done`

Keep logs concise: decision, evidence, files touched, next action.
Do not log full internal reasoning.

## Optional Queue/Inbox Mode
If async decoupling is needed:
- `agents/queue/` for unclaimed tasks.
- `agents/inbox/{agent}/` for direct requests.
- Claim tasks atomically by moving file (`mv`) to inbox.

## Polling Guidance
Do not make CLI recursively call itself.
Use one of:
- scheduler-driven one-shot runs (`cron`/`launchd`), or
- one long-running worker loop with sleep + backoff + lock file.

## Emergency Stop
On `!`:
1. Halt immediately.
2. Write current state in latest progress report.
3. Wait for human instruction.

## Version
- Version: `2.0`
- Last updated: `2026-02-12`

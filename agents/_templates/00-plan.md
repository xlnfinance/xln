---
agent: {agent-name-version}
session_id: {YYYY-MM-DD-randomid}
feature: {kebab-case-name}
status: planned
created: {ISO-timestamp}
branch: {agent}/{feature}
worktree: ~/.{agent}-worktrees/xln/{feature}
reviewers: [codex, gemini]
---

# Feature: {Human Readable Title}

## Goal
{Problem and expected outcome}

## Scope
- Modify:
  - `path/to/file`
- Create:
  - `path/to/file`
- Delete:
  - `path/to/file`

## Risks
- {Risk}

## Tests
```bash
{test commands}
```

## Reviewer Focus
- Codex: {security/correctness focus}
- Gemini: {architecture focus}

## Done When
- [ ] Implementation complete
- [ ] Required tests green
- [ ] Required reviews approved

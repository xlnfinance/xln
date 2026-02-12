---
agent: {agent-name}
session_id: {session-id}
feature: {feature-name}
status: in-progress | review | addressing-review | done
updated: {ISO-timestamp}
commit: {git-sha}
responding_to: {reviewN.md | null}
---

# Progress Report #{N}

## Completed
- {item}

## Open
- {item}

## Tests Run
- `{command}` -> {pass/fail}

## Evidence
- Files touched: `{path1}`, `{path2}`
- Key diff summary: {short summary}

## Next Action
- {next step}

## Ready for Review
- [ ] yes
- Review commit: `{sha}`
- Requested reviewers: `@codex`, `@gemini`

---
agent: {reviewer-name}
session_id: {session-id}
reviewing: {feature-name}
reviewed_commit: {git-sha}
status: approved | changes-requested
created: {ISO-timestamp}
---

# Review #{N}

## Findings (highest severity first)
- {SEVERITY} `path/to/file:line` - {issue}

## Tests Performed
- `{command}` -> {result}

## Verdict
- Status: approved | changes-requested
- Merge blockers:
  - [ ] CRITICAL = 0
  - [ ] HIGH = 0
- Required fixes before merge:
  - {item}

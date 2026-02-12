---
agent: {agent-name}
session_id: {session-id}
feature: {feature-name}
status: in-progress | review | addressing-review
updated: {ISO-timestamp}
commit: {git-sha}
responding_to: {reviewN.md | null}
---

# Progress Report #{N}

## ✅ Completed
- [x] Task 1 (commit: {sha})
- [x] Task 2 (commit: {sha})

**Commits:**
- `{sha}` - {commit message summary}

**Diff stats:**
```
path/to/file.sol | 123 +-----
path/to/file.ts  |  45 ++
2 files changed, 50 insertions(+), 118 deletions(-)
```

## 🚧 In Progress
- [ ] Task 3 (expected: {time})
- [ ] Task 4

**Current focus:** {What I'm working on now}

## ⚠️ Issues Encountered

### 1. {Issue Title}
**Description:** {What went wrong}

**Root cause:** {Why it happened}

**Plan:** {How I'm fixing it}

**Impact:** {Does this affect timeline/scope?}

## 🧪 Testing

### Passing
- ✅ `test/suite-a.test.ts` (15/15 tests)
- ✅ `test/suite-b.test.ts` (8/8 tests)

### Failing
- ❌ `test/suite-c.test.ts` (2 failures)
  - Reason: {why failing}
  - Fix: {what needs to happen}

### Coverage
```
Statements   : 85.23% (↑ 2.1%)
Branches     : 78.45%
Functions    : 82.67%
Lines        : 85.23%
```

## 📊 Metrics

| Metric | Before | After | Change |
|--------|--------|-------|--------|
| Contract size | X LOC | Y LOC | Δ Z |
| Gas (operation) | X | Y | Δ Z |
| Test coverage | X% | Y% | Δ Z% |
| Build time | Xs | Ys | Δ Zs |

## 🔄 Next Steps

1. Fix failing tests
2. Address {specific issue}
3. Request review from {agents}
4. {Additional steps}

**Estimated completion:** {timeframe}

## 🤔 Questions for Reviewers

**For Codex:**
- {Specific security/technical question}

**For Gemini:**
- {Architecture/design question}

---
**Status:** {Not ready | Ready for review | Awaiting feedback}

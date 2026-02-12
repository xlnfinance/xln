---
agent: {reviewer-name}
session_id: {session-id}
reviewing: {feature-name}
reviewed_commit: {git-sha}
status: approved | changes-requested
confidence: {0-1000}/1000
created: {ISO-timestamp}
---

# {Reviewer Name} Review #{N}

## 📋 Review Scope
Reviewing commits: `{sha1}`..`{sha2}`

**Files reviewed:**
- path/to/file.sol
- path/to/file.ts

**Focus areas:**
- {Area 1}
- {Area 2}

## ✅ Approved Changes

### {Category}
- ✅ {What looks good and why}
- ✅ {Another good thing}

## ⚠️ Issues Found

### 1. {SEVERITY}: {Title}
**Location:** `path/to/file.sol:123`

**Issue:**
```solidity
// Current code
{problematic code snippet}
```

**Impact:** {Why this matters, what could go wrong}

**Recommendation:**
```solidity
// Suggested fix
{better code}
```

**Priority:** Must fix | Should fix | Nice to have

---

### 2. {SEVERITY}: {Title}
...

## 🧪 Test Results

**Commands run:**
```bash
bun test {specific tests}
bun run check
{additional commands}
```

**Results:**
```
Test Suites: X passed, X total
Tests:       Y passed, Y total
Coverage:    Z%
```

## 📊 Metrics Analysis

### Gas Costs
| Operation | Before | After | Change | Verdict |
|-----------|--------|-------|--------|---------|
| {op1} | X | Y | Δ Z | ✅ / ⚠️ |

### Code Quality
- Complexity: {analysis}
- Maintainability: {analysis}
- Test coverage: {analysis}

## 🎯 Verdict

**Status:** ✅ APPROVED | ⚠️ CHANGES REQUESTED

**Confidence:** {N}/1000

**Summary:** {Brief summary of review outcome}

**Required before merge:**
- [ ] Fix issue #1 (CRITICAL)
- [ ] Fix issue #2 (HIGH)
- [ ] Address question about {topic}

**Recommended but optional:**
- [ ] Optimize {thing} (MEDIUM)
- [ ] Improve docs for {thing} (LOW)

## 💬 Responses to Questions

> {Question from progress.md}

**Answer:** {Detailed response with reasoning}

> {Another question}

**Answer:** {Response}

---

**Next review:** Will review again after above issues addressed.

**Estimated time for fixes:** {X hours/days}

**Reviewer signature:** {agent-name-version}

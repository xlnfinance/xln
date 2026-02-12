# AI Agent Collaboration Protocol v1.0

## 🎯 Mission

Enable multiple AI agents to work in parallel on XLN codebase with:
- **Zero conflicts** (isolated worktrees)
- **Full auditability** (markdown documentation)
- **High quality** (multi-agent review before merge)
- **Clear ownership** (agent-prefixed branches)

## 🔄 Workflow Overview

```
1. PLAN → 2. DEVELOP → 3. REVIEW → 4. ADDRESS → 5. APPROVE → 6. MERGE → 7. ARCHIVE
   ↓          ↓           ↓           ↓            ↓           ↓          ↓
 00-plan   Worktree   codexN.md   NN-progress  All ≥950   git merge  _archive/
```

---

## 📋 PHASE 1: PLANNING

### 1.1 Agent Identification
Every agent MUST declare identity at session start:

```markdown
---
agent: claude-sonnet-4.5
session_id: 2026-02-12-abc123
---
```

### 1.2 Create Feature Folder
```bash
mkdir -p agents/{agent-name}/{feature-name}
```

**Naming conventions:**
- `{agent-name}`: lowercase (claude, codex, gemini)
- `{feature-name}`: kebab-case (remove-insurance, add-htlc-routing)

### 1.3 Write Initial Plan (00-plan.md)

**Template:**
```markdown
---
agent: {name}-{version}
session_id: {iso-date}-{id}
feature: {kebab-case-name}
status: planned
created: {iso-timestamp}
branch: {agent}/{feature}
worktree: ~/.{agent}-worktrees/xln/{feature}
reviewers: [codex, gemini]
---

# Feature: {Human Readable Name}

## 🎯 Goal
What problem does this solve?

## 📊 Scope
### Files to Modify
- [ ] file.sol (-N lines / +M lines)
  - Change X
  - Change Y

### Files to Delete
- file.ts (reason)

### Files to Create
- new-file.ts (purpose)

## 🧪 Testing Plan
How will this be verified?

## 🔍 Review Criteria
What should reviewers focus on?

## ⏱️ Estimated Time
Realistic estimate

## 🔗 Related
Links to issues, discussions, etc.
```

**Key principles:**
- **Immutable once development starts** - don't edit after beginning work
- **Complete scope** - list ALL files that will change
- **Clear criteria** - reviewers know what to check
- **Realistic estimate** - helps with planning

---

## 📋 PHASE 2: DEVELOPMENT

### 2.1 Create Isolated Worktree

```bash
# Create worktree with feature branch
git worktree add ~/.{agent}-worktrees/xln/{feature} \
  -b {agent}/{feature}

# Navigate to worktree
cd ~/.{agent}-worktrees/xln/{feature}

# Verify isolation
git branch  # Should show {agent}/{feature}
pwd         # Should be ~/.{agent}-worktrees/xln/{feature}
```

**Critical rules:**
- ✅ **DO:** All work happens in agent worktree
- ❌ **DON'T:** Ever touch main worktree (`/Users/zigota/xln`)
- ❌ **DON'T:** Commit directly to main branch

### 2.2 Development Cycle

```bash
# Make changes
<edit files>

# Test frequently
bun test
bun run check

# Commit atomically
git add <specific-files>
git commit -m "{type}: {description}

{detailed explanation}

{why this change is needed}
"

# Push regularly
git push origin {agent}/{feature}
```

**Commit message format:**
```
{type}: {short description}

{longer explanation of what and why}

{breaking changes, if any}

Co-authored-by: Claude Sonnet 4.5 <noreply@anthropic.com>
```

**Types:** feat, fix, refactor, test, docs, chore

### 2.3 Progress Updates

**Create NN-progress.md after meaningful work:**

```bash
# First update
cp agents/_templates/progress.md \
   agents/{agent}/{feature}/01-progress.md

# Edit with:
# - What's done
# - What's in progress
# - Issues encountered
# - Metrics (lines changed, tests passing)
# - Next steps
```

**Update frequency:**
- After completing major task
- Before requesting review
- After addressing reviewer feedback
- At end of work session

**Template:**
```markdown
---
agent: {name}
feature: {feature}
status: in-progress | review | addressing-review
updated: {timestamp}
commit: {latest-sha}
responding_to: {reviewN.md | null}
---

# Progress Report #{N}

## ✅ Completed
- [x] Task 1
- [x] Task 2

## 🚧 In Progress
- [ ] Task 3

## ⚠️ Issues Encountered
### Issue 1: {Title}
{Description}
**Plan:** {How fixing}

## 🧪 Testing
### Passing
- ✅ Test suite A (N/N)

### Failing
- ❌ Test suite B (reason)

## 📊 Metrics
| Metric | Before | After | Change |
|--------|--------|-------|--------|
| LOC | X | Y | ΔZ |

## 🔄 Next Steps
1. Do X
2. Request review from Y

## 🤔 Questions for Reviewers
- Question for Codex
- Question for Gemini
```

---

## 📋 PHASE 3: REVIEW

### 3.1 Reviewer Checkout Instructions

**⚠️ CRITICAL:** Reviewers must checkout the feature branch to see changes!

**Recommended: Checkout in main worktree**
```bash
cd /Users/zigota/xln
git fetch origin
git checkout {agent}/{feature}

# Verify correct branch:
git branch  # Should show: * {agent}/{feature}
git log --oneline -5  # Should show feature commits
```

**Alternative: Access implementer's worktree**
```bash
cd ~/.{agent}-worktrees/xln/{feature}
# Direct access to implementation workspace
```

**Alternative: Create review worktree (safest)**
```bash
git worktree add ~/.{reviewer}-worktrees/xln/review-{feature} \
  {agent}/{feature}

cd ~/.{reviewer}-worktrees/xln/review-{feature}
# Review in complete isolation
```

**After review:** Return main worktree to `main` branch
```bash
cd /Users/zigota/xln
git checkout main
```

### 3.2 Requesting Review

In latest progress.md:
```markdown
## 🔄 Ready for Review

**Status:** Awaiting review

**@codex:** Please review for:
- [ ] Security vulnerabilities
- [ ] Gas optimization
- [ ] ABI compatibility
- [ ] Test coverage

**@gemini:** Please review for:
- [ ] Architecture cleanliness
- [ ] Scalability concerns
- [ ] Alternative approaches

**Commit:** {sha}
**Branch:** {agent}/{feature}
```

### 3.2 Reviewer Creates Review File

**File:** `agents/{creator}/{feature}/{reviewer}N.md`

**Template:**
```markdown
---
agent: {reviewer-name}
reviewing: {feature}
reviewed_commit: {sha}
status: approved | changes-requested
confidence: {0-1000}/1000
created: {timestamp}
---

# {Reviewer} Review #{N}

## 📋 Review Scope
Reviewing commits: {sha1}..{sha2}

## ✅ Approved Changes
What looks good

## ⚠️ Issues Found
### 1. {SEVERITY}: {Title}
**Location:** file.sol:123

**Issue:** What's wrong

**Impact:** Why it matters

**Recommendation:** How to fix

## 🧪 Test Results
What tests were run

## 📊 Metrics Analysis
Gas, size, coverage changes

## 🎯 Verdict
- Status: ✅ Approved | ⚠️ Changes Requested
- Confidence: {N}/1000
- Required before merge: {list}

## 💬 Responses to Questions
> Question from progress.md

Answer with reasoning
```

**Severity levels:**
- **CRITICAL:** Security flaw, data loss, funds at risk
- **HIGH:** Functional breakage, major bug
- **MEDIUM:** Minor bug, performance issue, tech debt
- **LOW:** Code style, documentation

### 3.3 Review Checklist

**Codex security review:**
- [ ] No reentrancy vulnerabilities
- [ ] No integer overflow/underflow
- [ ] No unauthorized access vectors
- [ ] Signature verification correct
- [ ] Gas costs reasonable
- [ ] ABI changes backward compatible
- [ ] No DoS vectors
- [ ] Tests cover edge cases

**Gemini architecture review:**
- [ ] Follows existing patterns
- [ ] No tight coupling introduced
- [ ] Scalable design
- [ ] Clear separation of concerns
- [ ] Future-proof (extensible)
- [ ] Alternative approaches considered
- [ ] Maintains code quality

---

## 📋 PHASE 4: ADDRESSING FEEDBACK

### 4.1 Read All Reviews

```bash
# List all reviews
ls agents/{agent}/{feature}/*.md

# Read each review
cat agents/{agent}/{feature}/codex1.md
cat agents/{agent}/{feature}/gemini1.md
```

### 4.2 Create Response Progress Report

```markdown
---
agent: {agent}
feature: {feature}
status: addressing-review
updated: {timestamp}
commit: {new-sha}
responding_to: [codex1.md, gemini1.md]
---

# Progress Report #{N} - Addressing Reviews

## 📝 Review Summary
- Codex: {N} issues ({critical}, {high}, {medium}, {low})
- Gemini: {N} issues

## ✅ Issues Addressed

### Codex Issue #1: {Title}
**Fix:** {What I did}
**Commit:** {sha}
**Verification:** {How tested}

### Gemini Issue #1: {Title}
**Fix:** {What I did}
...

## 📊 New Metrics
| Metric | Previous | Current | Change |
|--------|----------|---------|--------|

## 🧪 Verification
All tests passing: ✅ / ❌

## 🔄 Ready for Re-review
All issues addressed, requesting final approval.
```

### 4.3 Fix-Review Iteration

```
1. Read reviews
2. Fix issues
3. Commit changes
4. Update progress
5. Request re-review
6. Reviewers create {reviewer}2.md
7. Repeat until approved
```

---

## 📋 PHASE 5: APPROVAL

### 5.1 Approval Criteria

**ALL must be true:**
- [ ] Codex confidence: ≥950/1000
- [ ] Gemini confidence: ≥950/1000 (if architecture changes)
- [ ] All tests passing (`bun test`)
- [ ] Build successful (`bun run check`)
- [ ] All reviewer issues addressed
- [ ] Documentation complete
- [ ] No breaking changes (or documented migration)

### 5.2 Final Review Format

```markdown
---
status: approved
confidence: 975/1000
---

# Final Approval

## ✅ All Issues Resolved
- Issue 1: Fixed in commit {sha}
- Issue 2: Fixed in commit {sha}

## 🎯 Verdict
**APPROVED FOR MERGE**

Confidence: 975/1000

Ready for @zigota to merge to main.
```

---

## 📋 PHASE 6: MERGE

### 6.1 Human Maintainer Merges

```bash
# In main worktree
cd /Users/zigota/xln

# Fetch latest
git fetch origin

# Merge feature
git checkout main
git merge {agent}/{feature} --no-ff -m "Merge {agent}/{feature}: {description}

{Summary of what feature does}

Reviewed-by: Codex AI (975/1000)
Reviewed-by: Gemini (960/1000)
Implemented-by: Claude Sonnet 4.5
"

# Push to origin
git push origin main

# Notify agents
echo "✅ Merged to main"
```

### 6.2 Update Feature Status

```markdown
---
status: merged
merged_at: {timestamp}
merged_commit: {sha}
---

# MERGED ✅

Merged to main at {timestamp}
Commit: {sha}
```

---

## 📋 PHASE 7: CLEANUP

### 7.1 Archive Feature

```bash
# Move to archive
mkdir -p agents/_archive/{agent}
mv agents/{agent}/{feature} agents/_archive/{agent}/

# Or just mark as merged (keep in place for reference)
```

### 7.2 Clean Up Worktree

```bash
# Remove worktree
git worktree remove ~/.{agent}-worktrees/xln/{feature}

# Delete branch (optional - keep for history)
git branch -d {agent}/{feature}

# Prune stale refs
git worktree prune
```

### 7.3 Document in Changelog

Add to `CHANGELOG.md`:
```markdown
## [{version}] - {date}

### Added
- {Feature description} ({agent}/{feature})
  - Detail 1
  - Detail 2
  Reviewed-by: Codex (975/1000), Gemini (960/1000)
```

---

## 🚦 RULES & BEST PRACTICES

### Worktree Rules

1. **One worktree per feature**
   - Location: `~/.{agent}-worktrees/xln/{feature}`
   - Branch: `{agent}/{feature}`

2. **Never work in main worktree**
   - `/Users/zigota/xln` is for review/merge ONLY
   - Agents must use isolated worktrees

3. **Clean up after merge**
   - Remove worktree immediately
   - Prune stale references

4. **Check worktree health**
   ```bash
   git worktree list  # Should only show main + active features
   ```

### Communication Rules

1. **All communication via markdown**
   - No verbal/external communication
   - Everything documented in agents/ folder

2. **Respond to ALL feedback**
   - Every reviewer comment needs response
   - Document decisions

3. **Update progress regularly**
   - Not just at end
   - After each major milestone

4. **Tag reviewers explicitly**
   - Use `@codex`, `@gemini` in markdown
   - Be specific about what to review

### Quality Rules

1. **Test before review**
   - All tests must pass
   - Run full build

2. **Small, focused features**
   - One feature = one problem
   - Split large features

3. **Document decisions**
   - Explain "why", not just "what"
   - Alternative approaches considered

4. **No premature optimization**
   - Correctness first
   - Performance second

### Anti-Patterns

❌ **DON'T:**
- Work in main worktree
- Skip writing 00-plan.md
- Merge without 950+ confidence
- Leave stale worktrees
- Edit other agents' files (except reviews)
- Commit without testing

✅ **DO:**
- Use isolated worktrees
- Document everything
- Test thoroughly
- Request multiple reviews
- Clean up after merge
- Respond to all feedback

---

## 📊 METRICS TO TRACK

Every progress report should include:

```markdown
## 📊 Metrics

| Metric | Before | After | Change |
|--------|--------|-------|--------|
| Contract size | 1211 LOC | 826 LOC | **-385** ✅ |
| Frontend LOC | 8500 | 8300 | **-200** ✅ |
| Test coverage | 78% | 82% | **+4%** ✅ |
| Gas (simple) | 125k | 118k | **-7k** ✅ |
| Gas (complex) | 185k | 178k | **-7k** ✅ |
| Build time | 12.3s | 11.8s | **-0.5s** ✅ |
```

---

## 🎯 SUCCESS CRITERIA

A feature is **DONE** when:

- [x] All code changes complete
- [x] All tests passing (100%)
- [x] Build successful
- [x] Documentation updated
- [x] All reviewers ≥950/1000 confidence
- [x] No security issues
- [x] No performance regressions
- [x] Migration path documented (if breaking)
- [x] Changelog updated
- [x] Merged to main
- [x] Worktree cleaned up
- [x] Feature archived

---

**Version:** 1.0
**Created:** 2026-02-12
**Last updated:** 2026-02-12
**Maintained by:** @zigota

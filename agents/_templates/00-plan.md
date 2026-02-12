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

## 🎯 Goal
{What problem does this solve? Why is this needed?}

## 📊 Scope

### Files to Modify
- [ ] `path/to/file.sol` (-N lines / +M lines)
  - Change X
  - Change Y
  - Change Z

### Files to Delete
- `path/to/old-file.ts` (reason for deletion)

### Files to Create
- `path/to/new-file.ts` (purpose of new file)

### Files to Keep (No Changes)
- ✅ `important-file.ts` - explain why untouched

## 🧪 Testing Plan
```bash
# Commands to verify this feature
bun test path/to/tests
bun run check
```

**Coverage targets:**
- Affected modules: 100%
- Overall coverage: maintain or improve

## 🔍 Review Criteria

**For Codex:**
- [ ] Security: {specific concerns}
- [ ] Gas: {optimization areas}
- [ ] ABI: {compatibility checks}

**For Gemini:**
- [ ] Architecture: {design questions}
- [ ] Scalability: {growth concerns}
- [ ] Alternatives: {other approaches considered}

## ⏱️ Estimated Time
- Implementation: {X} hours
- Testing: {Y} hours
- Review cycles: {Z} days
- Total: {N} days

## 📝 Migration Notes
{Any deployment steps, breaking changes, migration scripts needed}

## 🔗 Related
- Issue: #{number}
- Discussion: #{number}
- Context: {link to conversation/doc}

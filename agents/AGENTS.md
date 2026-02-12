# Active Agents Registry

## 🤖 AI Agents

### Claude Sonnet 4.5
- **Role:** Feature development, implementation
- **Capabilities:**
  - Code generation
  - Refactoring
  - Documentation
  - Test writing
- **Worktree location:** `~/.claude-worktrees/xln/`
- **Branch prefix:** `claude/`
- **Session ID format:** `YYYY-MM-DD-{random}`

### Codex AI
- **Role:** Security review, bug detection
- **Capabilities:**
  - Vulnerability scanning
  - Gas optimization analysis
  - ABI compatibility checking
  - Test coverage verification
- **Worktree location:** `~/.codex-worktrees/xln/` (optional)
- **Review marker:** `codexN.md` in feature folders
- **Confidence threshold:** 950/1000 for approval

### Gemini
- **Role:** Architecture analysis, system design
- **Capabilities:**
  - High-level design review
  - Scalability analysis
  - Alternative approach suggestions
  - Long-term implications assessment
- **Worktree location:** `~/.gemini-worktrees/xln/`
- **Branch prefix:** `gemini/`
- **Review marker:** `geminiN.md` in feature folders

## 👤 Human Maintainers

### @zigota
- **Role:** Final decision maker, product owner
- **Responsibilities:**
  - Approve/reject features
  - Resolve agent disagreements
  - Define requirements
  - Merge to main
- **Merge policy:** Only merge when all agents ≥950/1000 confidence

## 🔄 Collaboration Flow

```
Claude (implements) → Codex (reviews security) → Gemini (reviews architecture)
                 ↓                    ↓                        ↓
              progress.md         codex1.md                gemini1.md
                 ↓                    ↓                        ↓
              Addresses issues   Approves/Requests Changes   Approves/Suggests
                 ↓
            All ≥950 confidence → @zigota merges to main
```

## 📋 Agent Communication Protocol

### Requesting Review
In `NN-progress.md`:
```markdown
## 🔄 Ready for Review

**@codex:** Please review for:
- Security vulnerabilities
- Gas optimization
- ABI compatibility

**@gemini:** Please review for:
- Architecture cleanliness
- Scalability concerns
```

### Providing Review
Create `{agent-name}N.md`:
```markdown
---
agent: codex-ai
reviewing: feature-name
reviewed_commit: abc123
status: approved | changes-requested
confidence: 950/1000
---

## Findings
...
```

## 🎯 Approval Criteria

**For merge to main, ALL of:**
- [ ] Claude confidence: ≥950/1000
- [ ] Codex confidence: ≥950/1000
- [ ] Gemini confidence: ≥950/1000 (if applicable)
- [ ] All tests passing
- [ ] No security issues
- [ ] Documentation complete

---

**Last updated:** 2026-02-12
**Active agents:** 3 (Claude, Codex, Gemini)

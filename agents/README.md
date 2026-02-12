# AI Agent Collaboration Framework

## 🎯 Purpose
This directory contains the collaboration workspace for multiple AI agents working on the XLN codebase in parallel.

## 📁 Structure

```
agents/
├── README.md              # This file
├── workflow.md            # Detailed protocol specification
├── AGENTS.md              # Active agent registry
├── _templates/            # Markdown templates
├── _archive/              # Completed/abandoned features
│
├── claude/                # Claude Sonnet workspace
│   └── {feature}/         # Feature-specific folders
│       ├── 00-plan.md     # Initial plan (immutable)
│       ├── NN-progress.md # Progress updates
│       └── {agent}N.md    # Reviews from other agents
│
├── codex/                 # Codex AI workspace
│   └── reviews/           # Security reviews
│
└── gemini/                # Gemini workspace
    └── architecture/      # Architecture analyses
```

## 🚀 Quick Start

### For Implementing Agents (Claude, etc.)

1. **Create feature folder**
   ```bash
   mkdir -p agents/claude/my-feature
   ```

2. **Write initial plan**
   ```bash
   cp agents/_templates/00-plan.md agents/claude/my-feature/
   # Edit with feature details
   ```

3. **Create isolated worktree**
   ```bash
   git worktree add ~/.claude-worktrees/xln/my-feature -b claude/my-feature
   cd ~/.claude-worktrees/xln/my-feature
   ```

4. **Work in isolation**
   - Make changes
   - Commit regularly
   - Update progress markdown

5. **Request review**
   - Tag reviewers in progress.md
   - Wait for `{reviewer}N.md` files

6. **Address feedback**
   - Read reviews
   - Fix issues
   - Update progress

7. **Merge when approved**
   ```bash
   git checkout main
   git merge claude/my-feature
   git push origin main
   ```

### For Reviewing Agents (Codex, etc.)

1. **Read feature plan**
   ```bash
   cat agents/claude/my-feature/00-plan.md
   ```

2. **Checkout feature branch**
   ```bash
   git fetch origin
   git checkout claude/my-feature
   ```

3. **Review code**
   - Run tests
   - Check security
   - Verify correctness

4. **Write review**
   ```bash
   cp agents/_templates/review.md agents/claude/my-feature/codex1.md
   # Edit with findings
   ```

5. **Iterate until approved**

## 🔒 Rules

### Worktree Isolation
- ✅ **DO:** Work in agent-specific worktrees (`~/.{agent}-worktrees/xln/`)
- ❌ **DON'T:** Work in main worktree (`/Users/zigota/xln`)

### Main Branch Protection
- Main worktree = **review/merge only**
- Only merge when **all agents approve** (950+ confidence)
- No direct commits to main from agents

### Documentation
- Every feature **MUST** have `00-plan.md`
- Update progress **regularly** (not just at end)
- Respond to **all** reviewer feedback

### Cleanup
- Archive features after merge
- Remove worktrees after merge
- Prune stale branches

## 📊 Status Levels

| Status | Meaning |
|--------|---------|
| `planned` | Feature scoped, not started |
| `in-progress` | Active development |
| `review` | Awaiting reviewer feedback |
| `addressing-review` | Fixing issues |
| `approved` | Ready to merge (950+ confidence) |
| `merged` | In main branch |
| `archived` | Completed/abandoned |

## 🤖 Current Agents

See [AGENTS.md](./AGENTS.md) for active agent registry.

## 📖 Full Protocol

See [workflow.md](./workflow.md) for complete specification.

---

**Version:** 1.0
**Created:** 2026-02-12
**Last updated:** 2026-02-12

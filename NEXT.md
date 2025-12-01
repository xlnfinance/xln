# NEXT.md - Priority Tasks

## 🔥 COMPLETED (2025-11-30): Codex/Gemini Review Fixes + Multi-Agent Protocol

### Codex Blockers Fixed ✅
- ✅ **timeIndex default to -1** - View.svelte:129 now uses `?? -1` (LIVE mode default)
- ✅ **InsurancePanel time-travel aware** - Shows warning in history mode
- ✅ **Architect mutations blocked in history** - `requireLiveMode()` guard on all 10 mutation functions

### Gemini Security Fixes ✅
- ✅ **Mempool DoS protection** - entity-consensus.ts:111 checks `LIMITS.MEMPOOL_SIZE` (1000)
- ✅ **JurisdictionEvent typing** - types.ts has discriminated union (5 event types)
- ✅ **Rollback logic** - Confirmed correct (ackedTransitions=incoming, sentTransitions=outgoing)

### Sphere Rendering Fixes ✅
- ✅ **Sphere sizing** - Graph3DPanel.svelte:4596-4605 uses `dollarsPerPx = 1000`
- ✅ **Grey sphere bug** - Color now queries actual reserves via `checkEntityHasReserves()`

### Multi-Agent Protocol ✅
- ✅ **Created .agents/** - Full coordination protocol with economy system
- ✅ **Onboarding flow** - Agents read multiagent.md, create profile, write ready.md
- ✅ **Token budgets** - claude=500k/day, others=200k/day, subagent spawning
- ✅ **Papertrail** - All interactions logged to papertrail/{date}/

---

## 📁 FILES MODIFIED THIS SESSION:

```
runtime/
├─ entity-consensus.ts (mempool limit check)
├─ types.ts (JurisdictionEvent discriminated union)

frontend/src/lib/view/
├─ View.svelte (timeIndex default -1)
├─ panels/ArchitectPanel.svelte (requireLiveMode guards)
├─ panels/InsurancePanel.svelte (isHistoryMode + warning)
├─ panels/Graph3DPanel.svelte (dollarsPerPx, checkEntityHasReserves)

.agents/
├─ multiagent.md (full protocol v2)
├─ manifest.json
├─ economy/ledger.json
├─ profiles/claude-architect.md
├─ inbox/{claude,codex,gemini,glm}/
├─ outbox/{claude,codex,gemini,glm}/
├─ papertrail/2025-11-30/
├─ queue/, consensus/, subagents/, completed/
```

---

## 🎯 NEXT SESSION PRIORITIES:

### 1. Visual E2E Testing (HIGH)
- Run AHB demo end-to-end
- Verify sphere sizes look correct with new formula
- Confirm grey/green coloring matches reserves

### 2. Multi-Agent Onboarding (HIGH)
- Invite codex-reviewer, gemini-tester to .agents/
- Create first task in queue/
- Test consensus flow

### 3. SettingsPanel Slider (MEDIUM)
- Add `dollarsPerPx` slider to SettingsPanel
- Auto-adjust to prevent sphere overlap

### 4. File Splitting (LOW)
- ArchitectPanel.svelte is huge (~2300 lines)
- Consider splitting into sub-components

---

## 📋 LOW HANGS (can do quickly):

1. **Settings slider for dollarsPerPx** - ~20 lines in SettingsPanel.svelte
2. **Kill stale background shells** - Many zombie processes running
3. **Add .agents/ to .gitignore** - Prevent papertrail from bloating repo

---

## 🤖 MULTI-AGENT ONBOARDING PROMPT:

```
You are joining the XLN multi-agent development team.
READ THIS FIRST: /Users/zigota/xln/.agents/multiagent.md

After reading:
1. Create your profile in .agents/profiles/{your-codename}.md
2. Write "ready" to .agents/inbox/{your-codename}/ready.md
3. Check .agents/queue/ for unclaimed tasks
4. Follow papertrail protocol for ALL interactions

Your codename: codex-reviewer | gemini-tester | glm-auditor
```

---

## 📝 HUMAN COMMANDS (1 letter):

- `y` = approve & continue
- `n` = reject (explain why)
- `?` = show status
- `!` = emergency stop
- `1-9` = pick option
- ` ` = skip/next

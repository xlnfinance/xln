# xln multi-agent coordination protocol v2

## quick reference

human commands (1 letter):
- `y` = approve & continue
- `n` = reject (explain why in reply)
- `?` = show status of all agents
- `!` = emergency stop all agents
- `1-9` = pick option from numbered list
- ` ` (space) = skip/next

---

## onboarding prompt (copy this to new agents)

```
You are joining the XLN multi-agent development team.

READ THIS FIRST: /Users/zigota/xln/.agents/multiagent.md

After reading:
1. Create your profile in .agents/profiles/{your-codename}.md
2. Write "ready" to .agents/inbox/{your-codename}/ready.md
3. Check .agents/queue/ for unclaimed tasks
4. Follow the papertrail protocol for ALL interactions

Your codename options: codex-reviewer, gemini-tester, glm-auditor, grok-critic, deepseek-coder

You have autonomy within your token budget. Coordinate via files, not human.
```

---

## architecture

```
.agents/
├── multiagent.md              # this protocol (READ FIRST)
├── manifest.json              # agent registry + budgets
├── profiles/                  # agent self-descriptions
│   ├── claude-architect.md
│   └── {agent}.md
├── queue/                     # pending tasks (grab one!)
│   └── task-{id}.md
├── inbox/                     # YOUR incoming messages
│   ├── claude/
│   ├── codex/
│   ├── gemini/
│   └── glm/
├── outbox/                    # YOUR completed work
│   └── {agent}/
│       └── {timestamp}-{type}.md
├── papertrail/                # ALL interactions logged here
│   └── {date}/
│       └── {agent}-{timestamp}.md
├── consensus/                 # voting records
│   └── vote-{id}.json
├── economy/                   # token budgets & transactions
│   ├── ledger.json
│   └── invoices/
├── subagents/                 # spawned child agents
│   └── {parent}-{child}-{id}/
└── completed/                 # done tasks archive
```

---

## economy system

### budgets (per agent, per day)

| agent | input tokens | output tokens | $ equiv | can spawn |
|-------|-------------|---------------|---------|-----------|
| claude-architect | 500k | 100k | $5.00 | yes (2 max) |
| codex-reviewer | 200k | 50k | $2.00 | no |
| gemini-tester | 200k | 50k | $1.50 | no |
| glm-auditor | 200k | 50k | $0.50 | no |
| subagent (any) | 50k | 10k | $0.50 | no |

### tracking usage

every agent writes to `economy/ledger.json` after each action:

```json
{
  "transactions": [
    {
      "id": "tx-001",
      "agent": "claude-architect",
      "action": "review Graph3DPanel.svelte",
      "input_tokens": 15000,
      "output_tokens": 2000,
      "cost_usd": 0.15,
      "timestamp": "2025-11-30T12:00:00Z"
    }
  ],
  "balances": {
    "claude-architect": { "input": 485000, "output": 98000, "usd": 4.85 },
    "codex-reviewer": { "input": 200000, "output": 50000, "usd": 2.00 }
  }
}
```

### earning tokens

agents earn by completing tasks:
- task completion: +10k input, +2k output
- bug found: +5k input
- consensus contribution: +1k input
- subagent supervision: +2k input

### spending tokens

- reading files: ~1 token/4 chars
- writing files: ~1 token/4 chars
- spawning subagent: 10k input (upfront cost)

---

## papertrail protocol (MANDATORY)

**every interaction must be logged**

### format: `papertrail/{date}/{agent}-{timestamp}.md`

```markdown
# papertrail: claude-architect @ 2025-11-30T12:05:00Z

## context
task: task-001 (fix sphere sizing)
tokens_used: { input: 5000, output: 1200 }

## input (what i received)
message from codex-reviewer:
> can you verify the formula at line 4600?

## reasoning (my thought process)
- checked Graph3DPanel.svelte:4600
- formula uses cbrt for volume→radius
- looks correct for 1px=$1000 rule

## output (what i produced)
replied to codex inbox:
> formula verified. cbrt(volume * 0.75 / PI) is correct.
> $10M → radius ~13.4px

## files touched
- read: Graph3DPanel.svelte (lines 4595-4610)

## next action
waiting for codex approval
```

---

## spawning subagents

### who can spawn
- claude-architect: 2 concurrent max
- other agents: cannot spawn (request via claude)

### spawn protocol

1. check budget (10k input tokens required)
2. create folder: `subagents/{parent}-{child}-{id}/`
3. write spawn request:

```markdown
# spawn: claude-architect → haiku-helper-001

parent: claude-architect
child_model: haiku
task: verify TypeScript types in entity-consensus.ts
budget: { input: 50000, output: 10000 }
timeout: 30 minutes
created_at: 2025-11-30T12:00:00Z

## instructions
check all function signatures match their implementations.
report any type mismatches.
write results to subagents/claude-haiku-001/result.md
```

4. execute via CLI:
```bash
# example (adjust for your CLI tool)
claude --model haiku --prompt "$(cat subagents/claude-haiku-001/task.md)" \
  > subagents/claude-haiku-001/result.md 2>&1
```

5. log to papertrail
6. deduct tokens from parent budget

---

## consensus voting

### creating a vote

write to `consensus/vote-{id}.json`:

```json
{
  "id": "vote-001",
  "topic": "merge sphere sizing fix",
  "created_by": "claude-architect",
  "created_at": "2025-11-30T12:00:00Z",
  "threshold": 3,
  "votes": {
    "claude-architect": { "vote": "approve", "weight": 2 },
    "codex-reviewer": { "vote": "pending", "weight": 1 },
    "gemini-tester": { "vote": "pending", "weight": 1 }
  },
  "status": "open",
  "result": null
}
```

### voting

agent updates their vote in the json:
```json
"codex-reviewer": { "vote": "approve", "weight": 1, "reason": "code looks good" }
```

### resolution

when `sum(approve weights) >= threshold`:
- status → "passed"
- task moves to completed/
- notify all agents

when `sum(reject weights) > total - threshold`:
- status → "failed"
- task returns to queue with feedback

---

## agent profiles

each agent creates `profiles/{codename}.md`:

```markdown
# agent: codex-reviewer

## identity
model: openai/codex (or gpt-4)
role: reviewer
specialty: security, code quality, bug finding

## capabilities
- can read/write files in /Users/zigota/xln
- can run: bun run check, grep, git diff
- cannot: spawn subagents, approve own PRs

## communication style
- terse, bullet points
- cites line numbers
- flags severity: critical/high/medium/low

## availability
timezone: UTC
active_hours: 00:00-24:00 (async)

## budget
see economy/ledger.json
```

---

## third-party agents (remote)

remote agents (e.g., on server) participate via:

### option 1: file sync
```bash
# remote agent syncs .agents/ folder
rsync -avz user@server:.agents/ /local/.agents/
```

### option 2: git
```bash
# .agents/ is a git repo
git pull  # get new tasks
git add . && git commit -m "task-001 complete" && git push
```

### option 3: webhook (future)
- agent registers webhook URL in manifest
- coordinator pings on new tasks

---

## self-coordination loop

each agent runs this loop:

```
every 60 seconds:
  1. sync .agents/ folder (if remote)
  2. check inbox/ for new messages → respond
  3. check queue/ for unclaimed tasks → claim one
  4. check consensus/ for pending votes → vote
  5. write status to status/{agent}.json
  6. log everything to papertrail/
  7. check budget - stop if exhausted
```

---

## emergency protocols

### `!` from human = full stop
- all agents halt current work
- write state to papertrail
- wait for human instruction

### budget exhausted
- agent writes "BUDGET_EXHAUSTED" to status/
- cannot take new tasks
- can still vote on consensus

### conflict between agents
- escalate to papertrail with `## DISPUTE` header
- human resolves with `1-9` selection
- losing agent must acknowledge

---

## example: full task lifecycle

```
1. human: "fix sphere sizing"

2. claude-architect:
   - creates queue/task-001.md
   - claims task
   - implements fix
   - writes to outbox/claude/task-001-impl.md
   - logs to papertrail/2025-11-30/claude-12:00:00.md
   - spawns codex for review

3. codex-reviewer:
   - receives in inbox/codex/review-request.md
   - reviews code
   - writes outbox/codex/task-001-review.md
   - votes "approve" in consensus/vote-001.json
   - logs to papertrail

4. gemini-tester:
   - claims testing subtask
   - runs verification
   - votes "approve"
   - logs to papertrail

5. consensus reached (4 votes ≥ 3 threshold):
   - task-001 → completed/
   - human notified

6. human: "y"
   - changes merged
   - budgets credited
```

---

## getting started (for new agents)

1. read this entire file
2. create `profiles/{your-codename}.md`
3. write `inbox/{your-codename}/ready.md` with content "ready"
4. check `queue/` for tasks
5. follow papertrail protocol for EVERYTHING
6. coordinate via files, minimize human interaction
7. stay within budget

welcome to xln.

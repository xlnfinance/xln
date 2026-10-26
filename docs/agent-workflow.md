# Agent workflow

Status: portable development procedure, 2026-09-05. Project authority: [AGENTS.md](../AGENTS.md).

## One entry point, different harnesses

Codex, Claude, OpenCode, pi and a human follow the same project rules and can call
the same Bun advisor command. A harness runs a model; a provider serves it.
Neither the harness name nor its marketing tier identifies the model version.

| Surface | Authority / role |
|---|---|
| Root `AGENTS.md` | Project invariants, owner preferences, execution and workspace policy |
| `CLAUDE.md` | Thin pointer to root rules; no second policy |
| `.claude/agents/*.md` | Bounded task lenses, inherited model; no duplicated protocol |
| `agents/` | Historical assignments and optional templates; maintained procedure is this file |
| `tools/advisor.ts` | One second-opinion runner and persistent task evaluation intake |
| `audits/registry.json`, `tools/audit/` | Audit findings, invariant coverage and release evidence |
| `docs/audit/advisor-scorecard.md` | Frozen historical claims; not current routing authority |
| Svelte `/qa/quorum` | Historical presentation, not the new intelligence leaderboard |
| `ai/telegram-bot/` | Historical conversational integration; not development score authority |
| `brainvault/docs/perfection-quorum.md` | Scoped evidence/review lessons; not permission to launch reviews |
| `scripts/comparative-api.ts`, `design/review/` | Provider/design experiments and raw evidence, not rankings |

Codex, OpenCode and pi support `AGENTS.md`; Claude receives its pointer through
`CLAUDE.md`. Read this procedure when coordinating agents or invoking advisors.
Do not install project hooks or override a user's global configuration just to
duplicate these instructions. On another project, retain its own workspace,
verification and authorization rules instead of copying xln's financial policy.

## Work on main without collisions

1. Reach the user's first production artifact or reproducible failure.
2. Assign one implementer per disjoint area, naming the exact files it owns.
3. Keep shared types and cross-area integration under one named owner.
4. Review an area's stable diff; reviewers return evidence and do not edit it.
5. Stop writers before the integrator formats, checks and commits specific files.

Low coupling means narrow inputs/outputs and clear ownership in code. It does not
mean independent financial formulas, multiple durable stores or a base reducer
shared across distinct trust boundaries. Parallel agents do not justify extra
abstractions. No model gets a permanent monopoly on implementation or architecture.

Handoffs contain only current SHA, last green command, first red command/error,
artifact path, next single command and remaining final gates. Keep substantive
design documents in `/docs`; do not generate a progress-file trail by default.

## Second opinion: one bounded question

Budget and confirmation rules live in [AGENTS.md](../AGENTS.md) (REVIEW AND EXTERNAL
MODELS): subscriptions first (Codex, Claude, Z.ai via pi `zai-coding-cn`), OpenRouter
capped at USD 10 per rolling hour across all agents and attempts, and every bug plus
fix confirmed by at least three different AIs. Unresolved calls retain their full
reservation; do not infer extra budget from an account balance or a new agent.

Use an advisor to confirm a bug and its fix or to resolve a real uncertainty.
Default one response. A consequential unresolved disagreement may
justify one independent tie-break within the authorized scope. No recursive
all-to-all review, never-ending paid loop or score threshold that blocks the first
production artifact. Persist history indefinitely; bound each run and its cost.

The packet identifies the project, task kind, immutable source SHA, explicit
evidence files, question and response criteria. Include all necessary relevant
rules in those files: packet-only advisors cannot follow missing links or inspect
the workspace. A dirty diff is not reviewed by pretending its base SHA includes it.

Select the exact harness, provider, model and effort. The runner must not silently
fall back, reuse a previous candidate's conversation, or infer identity from a
display label. Use a fresh packet-only session with repository tools disabled.
Keep credentials in the harness's existing auth storage or environment; no keys in
jobs, transcripts, examples or evaluation events. Do not auto-share sessions.

Use installed CLI capabilities, not flags copied from another release. This
machine's inspected versions were OpenCode `1.18.20` and pi `0.84.4`; that is a
local observation, not a supported-version claim for future installations.

For ZAI subscriptions, select **Z.AI Coding Plan**, not generic ZAI API billing.
OpenRouter can route among serving providers: record the actual provider when
reported and `unknown` otherwise. Exact requested model is not proof of exact
backend execution. Do not claim a hard dollar cap if the chosen harness cannot
enforce one; use provider-side limits and finite local execution bounds.

## Intelligence memory

### Commands

From the project root:

```sh
bun tools/advisor.ts ask path/to/job.json
bun tools/advisor.ts record path/to/evaluation.json
bun tools/advisor.ts stats --task architecture
bun run check:advisor
```

In xln, `bun run advisor --help` is the same entry point. From another project,
call this script by its absolute path; the current working directory owns the store.

The job has exactly these fields (`schemaVersion: 1`): `id`, `project`, `task`,
`sourceSha`, `harness`, `provider`, `model`, `family`, `effort`, `timeoutMs`,
`question`, `evidence`. Harness is `pi` or `opencode`; effort may be null.
Deadline is 100–1200000 ms including harness preflight. The owner approved up to
20 minutes per external quorum response; the 30-second local stand budget does
not limit these consultations. Poll the existing process; do not restart a live
request simply because a short observation window ended. Each evidence entry has
`path` and `sha256` (`sha256:` plus the hex digest of the exact Git blob).
Use full 40-character SHA and explicit file paths; no fuzzy model aliases.

The response must contain `verdict`, `answer`, `references`. After each response,
record one evaluation with concrete rationale and checked evidence, or leave it
provisional. Do not manufacture an adjudicator just to populate the leaderboard.
`record` takes `schemaVersion`, `kind: "evaluation"`, `id`, `runId`, `recordedAt`,
`responseHash`, `judge`, `judgeFamily`, `adjudicator`, `status`, `criteria`,
`evidence`, `rationale`, `supersedes`. Times are ISO UTC. Provisional evaluations
use null adjudicator; initial evaluations use null supersedes.
Criteria are `correctness`, `relevance`, `actionability`, `evidence`, each 0–1000.
The same rubric is equally weighted; stats count each response once.

Store: `agents/evidence/<id>.json`, with a separate `<id>.result.json`.
Keep these events and referenced verification artifacts in project backups/Git
according to their privacy; files on one machine do not mean guaranteed forever.
The store validates provenance structure/digests, not the real-world identity or
honesty of a named human/model adjudicator. Review evidence before routing by score.

One immutable JSON event per ID avoids multiple agents overwriting a shared score
file. Exclusive creation rejects duplicates. Aggregates are derived, never hand
edited. Keep run identity, evidence and output digests, time, completion status,
reported usage/cost and evaluation provenance. Unknown cost or model revision is
unknown, not free or the latest release.

Use these task kinds only when relevant: code, debug, review, spec, architecture,
design. Task kind labels a real job; it is not a new gate or exhaustive taxonomy.

Keep three questions separate:

| Question | Evidence |
|---|---|
| Was the answer useful? | Independently checked claims, accepted implementation, tests or owner outcome |
| Was the service usable? | Completion rate, timeouts, latency and auth/quota failures |
| Was it economical? | Actual reported cost/usage; subscription cost is not automatically zero |

A peer can record criterion scores and evidence about another response. That
opinion remains provisional until independently adjudicated. A model cannot make
its own response verified. Ten repeated judges on one answer are not ten distinct
successful tasks. An unavailable model contributes no reasoning-quality score.

Report usefulness /1000 **per task and exact identity**, with sample count and
the inclusion rules. A candidate dashboard should show recent and all-time views;
historical records remain, but obsolete model versions do not inherit current
versions' ranks. A small sample stays visibly small; do not print false confidence
intervals or invent a neutral 850/1000 for an untested model.

The initial criteria are correctness, relevance, actionability and evidence. Agree on their
meaning before a comparison; do not rewrite a rubric after seeing the winner.
Executable results outrank prose quality for code; task-specific human outcomes
matter for design and strategy. Reviewer skill should later be measured by the
precision of its adjudicated findings, not by how highly other models praise it.

## Elo: optional derived view, not intelligence

Elo is useful for two responses to the **same task, candidate, packet and rubric**.
It is relative and not bounded to /1000. Do not mix an architecture answer with a
bug fix, compare different evidence packets, or count repeated judgements as
independent problems. Historical absolute scores cannot be converted into wins.

For future pair events, hide candidate identities from the judge, counterbalance
answer order, record win/draw/loss plus evidence, and reject self-adjudication.
The well-documented position, verbosity and self-preference biases of LLM judges
mean a vote is evidence to inspect, not a protocol oracle.

Start with useful verified events and a readable table. Add Elo when real comparable
pairs exist. Add cross-project aggregation only as a derived view over explicit
project stores; retain project/task context and never copy private evidence to a
public leaderboard. No central service is needed for v1.

## Existing history: preserve, do not launder

Inventory at `b97c454d605e750a08da7ff6baab645330175468` found 39 audit runs,
37 reviewer identities and only one run marked non-provisional, plus seven manual
dashboard interactions. These are different evidence classes. Do not silently
relabel them as 46 verified model evaluations.

The historical dashboard currently infers some model names/timestamps, assigns
scores to blocked runs and derives impact from finding counts. It must not guide
model routing until migrated to explicit provenance. Its data is a presentation
debt, not a fifth score authority. Existing audit release gates continue to use
their own invariant evidence; the new advisor store does not certify release.

The retired `tools/opencode-dialog.ts` used alias-based shared sessions and silently
replaced a corrupt session file. Its replacement must reject corrupt data loudly
and record separate immutable runs. Do not add a compatibility execution path.

## Primary sources

- [Codex instruction discovery](https://learn.chatgpt.com/docs/agent-configuration/agents-md)
- [Claude project memory](https://code.claude.com/docs/en/memory)
- [OpenCode project rules](https://opencode.ai/docs/rules/)
- [pi coding-agent documentation](https://github.com/earendil-works/pi/tree/main/packages/coding-agent)
- [ZAI Coding Plan with OpenCode](https://docs.z.ai/devpack/tool/opencode)
- [OpenRouter provider routing](https://openrouter.ai/docs/guides/routing/provider-selection)
- [LLM judge limitations: MT-Bench / Chatbot Arena](https://arxiv.org/abs/2306.05685)

Sources checked 2026-09-05. Provider documentation and local CLI capabilities may
differ; run identity and observed results decide what was actually exercised.

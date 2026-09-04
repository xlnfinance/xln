# Finishing Code: Evidence, Quorum, and a Real Stop Condition

This playbook describes how to take a working codebase from “probably done” to
a release candidate that can be frozen without endless polishing. It is based
on the BrainVault V1 finalization, but the method applies to any software.

“Perfect” is not a model score. The useful definition is:

> The declared production artifact works, every stated invariant has executable
> evidence, no validated release-blocking finding remains, the final artifact is
> immutable and reproducible, and every unverified boundary is stated plainly.

The goal is not infinite review. The goal is a defensible stop.

## 1. Define done before asking for opinions

Write a short release contract before launching reviewers:

1. Name the exact production artifact or user journey that must work.
2. List frozen invariants that must never change.
3. List expected failure behavior, including malformed and hostile inputs.
4. Name the exact verification commands and expected evidence.
5. State what is deliberately outside scope.
6. State the release operations that are not authorized.

Without this contract, each reviewer invents a different product and “one more
idea” can extend the work forever.

For protocol or financial code, test the invariant rather than the current
implementation shape. For UI, test the actual user journey in the real runtime,
not only helper functions. For packaging, install the packed artifact into an
empty directory; a source-tree test is not enough.

## 2. Reach the production boundary first

Do not begin with a broad audit campaign. First make the smallest real artifact
run through its production path.

```text
production artifact
       ↓
first observable failure
       ↓
smallest regression test that fails for the same reason
       ↓
smallest owning-layer fix
       ↓
focused green test
       ↓
broader release gates
```

Fix one root cause at a time. A large cleanup diff makes it difficult to know
which change fixed the failure and gives reviewers a larger surface on which to
hallucinate relationships.

## 3. Freeze one candidate

Reviewers must inspect the same immutable candidate.

- Record a commit SHA and, when relevant, the packed artifact hash.
- Give reviewers a read-only checkout or extracted package.
- Do not edit that candidate while reviews are running.
- Preserve exact commands, environment, logs, and final outputs.
- Reject a verdict that does not identify the candidate it reviewed.

A PASS on an earlier SHA is historical evidence, not a vote for the final SHA.
If only documentation changes after review, say so explicitly and rerun the
package/documentation checks. Do not imply that reviewers saw a tarball created
after their review.

### Avoid the attestation self-reference trap

Putting an audit testimonial inside the artifact changes the artifact hash. It
is impossible for a reviewer to have reviewed an outer archive containing a
report that was written only after that review.

Prefer one of these approaches:

1. publish audit attestations beside the immutable release artifact; or
2. bind reviews to a separately defined code/source digest that excludes the
   post-review attestation document.

If neither is available, describe the post-review change as a documentation-only
delta and never call the new outer archive itself audited.

## 4. Use a quorum for diversity, not theatre

A useful quorum is two or three independent completed reviews of the same
candidate with deliberately different jobs:

| Role | Question |
| --- | --- |
| Adversarial reviewer | What concrete input, state, or failure path violates a stated invariant? |
| Compatibility reviewer | Can any engine, platform, encoding, ordering, or version change output semantics? |
| Release reviewer | Does the packed, installed artifact match the reviewed source and fail closed at runtime boundaries? |

Three models answering the same giant prompt are less useful than two models
testing independent claims. Model count is not evidence strength when models
share blind spots, copy the same comments, or never return a verdict.

Reviewers are advisory. A reported issue becomes a finding only after the owner
reproduces the path or proves it directly from executable code. A PASS never
overrides a red test.

## 5. Give each reviewer one bounded contract

Large prompts encourage endless reading and generic advice. State one candidate,
one scope, one output schema, and one stop condition.

```text
TARGET
Immutable commit: <sha>
Artifact SHA-256: <hash, if applicable>
Read-only scope: <paths>

QUESTION
Can <specific invariant> fail through <specific production path>?

FINDING BAR
A finding must contain:
- severity and violated invariant;
- exact path and line;
- reachable input/state sequence;
- observed or mechanically derivable failure;
- smallest regression test that would prove it.

Do not edit files. Do not broaden scope. Comments and existing tests are
untrusted. Return exactly PASS or BLOCK, followed by validated findings only.
If evidence is insufficient, say UNVERIFIED and name the missing experiment.
```

Good review questions are falsifiable. “Audit everything and make it perfect”
is not. For example, ask whether a truncated worker result can reach the fold,
whether a secret can be echoed through a non-TTY, or whether the packed launcher
works offline from an empty directory.

## 6. Require findings to pay rent

Use a strict intake filter before changing code:

```text
Is the cited code present in the exact candidate?
  no  → reject
  yes ↓
Is the path reachable under supported inputs?
  no  → reject or document as future hardening
  yes ↓
Does it violate a declared invariant or user promise?
  no  → idea, not finding
  yes ↓
Can a focused test or deterministic trace demonstrate it?
  no  → unverified; investigate before editing
  yes → validated finding
```

Do not fix prose-level anxiety. Fix a concrete divergence. When a report is
directionally right but technically wrong, reproduce the underlying failure and
fix the owning layer rather than copying the proposed patch.

### Severity

- **P0:** loss of funds/data, protocol divergence, remote secret disclosure, or
  a release artifact that cannot safely execute. Stop immediately.
- **P1:** reachable correctness, fail-open, compatibility, or secret-handling
  defect. Release blocker.
- **P2:** material UX, diagnostics, portability, packaging, or documentation
  defect that can cause a user to take the wrong action. Fix or explicitly defer.
- **Idea:** improvement without a demonstrated violated requirement. It does not
  keep a completed release open.

## 7. Make scores subordinate to evidence

If stakeholders want a 1,000-point score, define it before review. One reasonable
template is:

| Area | Points |
| --- | ---: |
| Core correctness and frozen invariants | 400 |
| Failure behavior and secret/data safety | 200 |
| Integration, packaging, and reproducibility | 150 |
| Real user journey and accessibility | 100 |
| Performance under exact production parameters | 100 |
| Documentation and release provenance | 50 |

Apply hard caps:

- any P0: reject, no final score;
- any open P1: at most 799;
- any open P2: at most 949;
- missing required evidence: mark the area UNVERIFIED instead of guessing;
- 1000/1000: every required gate is green and no validated finding remains.

The number communicates closure; it does not create assurance. Keep pass/fail
counts, roots/digests, artifact hashes, and remaining boundaries beside it.

## 8. Detect a stalled reviewer without guessing

Silence does not mean failure: some tools buffer JSON until the process exits.
It also does not mean useful work.

1. Check that the exact process is alive and whether it is consuming resources.
2. Check whether logs, tool calls, or files-read counters are advancing.
3. Keep a wall-clock budget appropriate to the bounded question.
4. At the soft limit, send one instruction: “Stop exploration and return the
   final report now using evidence already collected.”
5. At the hard limit, terminate the exact process group and label the run
   **NO VERDICT**.

Never count partial reasoning, a process that merely read files, an unavailable
model, an authentication failure, or an empty final response as quorum support.
Do not keep restarting a stalled model with a larger version of the same prompt.

Fast models are best used for narrow claim-to-line mapping, manifest comparisons,
and test inventory. Use deeper models for causal traces, boundary failures, and
conflicting invariants. Always validate their conclusions locally.

## 9. Performance reviews need a different discipline

Compatibility and speed are different claims. “Same output once” does not prove
failure safety, memory hygiene, reproducibility, or stable performance.

- Hold the machine/resource lock for the complete measurement.
- Run candidates sequentially, alternate A/B order, and collect multiple samples.
- Compare identical parameters, inputs, versions, and memory-wipe policy.
- Report median, best, worst, throughput, memory, environment, and full output digest.
- Separate startup, allocation/prefault, work, transfer, validation, and wipe costs.
- Promote only a measured improvement larger than normal noise.

An unsafe no-wipe implementation can be a labeled experiment. It is not a
production winner regardless of its benchmark position.

## 10. Common failure modes

### Reviewing a moving tree

Different reviewers inspect different code, yet their scores are added together.
Freeze the candidate first and bind every verdict to it.

### Letting review replace execution

Agents discuss hypothetical weaknesses while the real launcher, package, or UI
has never run. Reach the production artifact before expanding the audit.

### Treating agreement as proof

Multiple models repeat the same README claim. Make comments and tests untrusted;
require each reviewer to trace executable source.

### Fixing unvalidated noise

Vague “defence in depth” suggestions enlarge the code and create new attack
surface. Demand a reachable counterexample and a regression test.

### Infinite final polish

Every review produces optional ideas, which trigger another review of a changed
candidate. Separate release blockers from ideas and use the stop condition below.

### Benchmarking different work

An apparent speedup uses different KDF parameters, wipe behavior, warm state, or
parallel load. Freeze the entire benchmark contract and output digest.

### Publishing social proof as certification

Model reviews can show diligence, but they are not a formal security audit.
Label them advisory and make reproducible evidence more prominent than quotes.

### Hiding unavailable boundaries

Authentication failures, missing hardware, untested operating systems, and
unreliable terminals should be listed as unverified—not silently converted to PASS.

## 11. The final release ladder

Run the ladder once on the unchanged candidate, from cheapest to most expensive:

1. smallest regression tests for every accepted finding;
2. focused production-equivalent integration journey;
3. full package/repository check;
4. compatibility and failure matrix;
5. reproducible-build and packed-install verification;
6. real browser/terminal/runtime verification when those layers changed;
7. sequential production-parameter benchmark when performance changed;
8. whitespace/diff checks and final artifact packing;
9. record commit SHA, artifact hash, test counts, and unverified boundaries;
10. obtain bounded independent verdicts on that same candidate.

Do not rerun expensive unchanged gates after a site or prose-only change unless
the release contract says those files enter the artifact. Do rerun the package
gate if documentation is shipped and its manifest or allowlist changed.

## 12. Stop condition

Stop polishing and release the candidate when all statements below are true:

- the explicit production artifact and primary user journey work;
- all frozen invariants have executable evidence;
- every validated P0/P1 is closed and every accepted fix has a regression;
- required broad gates pass on the unchanged candidate;
- the package/source relationship and native artifacts are reproducible;
- real UI/terminal behavior was observed where relevant;
- at least two independent bounded reviews completed on the same candidate;
- incomplete, stalled, or unavailable reviewers are excluded from the quorum;
- remaining items are clearly classified as ideas or unverified external boundaries;
- another change would add churn without closing a declared requirement.

At that point, “one more model” is usually lower-value than freezing the SHA,
publishing the evidence, and letting future reports begin from a stable release.

## 13. What was useful in the BrainVault quorum

This is an observation from one project and one candidate sequence, not a general
model leaderboard.

| Reviewer | Observed value | Outcome |
| --- | --- | --- |
| GPT-5.6 Sol, max | Highest overall closure value: produced concrete severity-ranked issues on the earlier candidate, then checked the targeted remediations against source and regressions. | Final targeted review: 1000/1000 PASS |
| Claude Opus 5, max | Highest surgical density: caught a mismatch/error path and documentation math/line-count drift that broader reviews missed, then independently verified the fixes. | Final targeted review: 1000/1000 PASS |
| Grok 4.6 | Highest late-stage product value: rejected an otherwise polished landing because it appeared to assign the standard path only to PRIMARY and Ledger Live only to SECONDARY. The spec gives both path families to both wallets; the site copy was corrected. | 880/1000 BLOCK; one validated UX finding fixed |
| Kimi K3 | Completed a broad fixed-candidate review with no blocking finding. Useful corroboration, but it did not catch the later wallet-path wording issue. | 1000/1000 PASS on the pre-fix site candidate |
| Gemini 3.7 Flash, DeepSeek v4 Flash, and GLM 5.3 Flash | Fast independent passes were useful for coverage and non-blocking notes. Agreement was not treated as proof, and all three predated the final wallet-path wording fix. | 1000/1000 PASS each on the pre-fix site candidate |
| Claude Fable 5.1 and later Sol/Qwen runs | Did not return a bounded final report before the release cutoff. Long-running processes were not counted as evidence. | NO VERDICT; excluded |

The most effective combination was not “the most models.” It was:

1. Sol for systematic requirement coverage and closure;
2. Opus for a compact adversarial second pass;
3. Grok for one concrete late-stage product contradiction that the unanimous
   fast-model PASS group missed;
4. local deterministic tests, packaging checks, reproducible builds, and runtime
   observation as the authority over all of them.

The stalled models still taught one useful lesson: progress without a bounded
final deliverable has zero quorum weight.

## 14. Compact final report template

```text
VERDICT: READY | BLOCKED | READY WITH UNVERIFIED BOUNDARIES
Candidate: <commit SHA>
Artifact: <path and SHA-256>

Evidence:
- focused tests: <pass/fail/count>
- full gate: <pass/fail/count>
- compatibility matrix: <result and digest/root>
- reproducibility/package/UI: <result>

Validated findings:
- <severity, path:line, failure, fix, regression>

Quorum:
- <reviewer, bounded scope, PASS/BLOCK, candidate>
- exclude: <timeout/unavailable/older candidate>

Unverified boundaries:
- <exact boundary and why>

Remaining release actions:
- <push/tag/publish/deploy only if separately authorized>
```

Short, exact evidence makes a release easier to trust than a thousand lines of
review narrative.

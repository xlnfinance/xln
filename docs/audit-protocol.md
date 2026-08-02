# Evidence-driven modular audit protocol

Status: **canonical engineering axiom**  
Scope: architecture, implementation, security, reliability, performance, UX,
operations, and release readiness in any codebase.

The governing rule is simple:

> No quality claim outranks current, reproducible evidence attached to an exact
> source snapshot and a named invariant.

This protocol turns an unknown codebase into a risk-ranked map, converts that
map into narrow audit assignments, independently adjudicates findings, and
keeps every fix protected by executable evidence. It deliberately separates
audit coverage, product quality, finding severity, and reviewer confidence;
combining them into one optimistic percentage hides risk.

## 1. Axioms

1. **Map before judging.** Identify trust, state, money, authority, persistence,
   and external-effect boundaries before searching for bugs.
2. **Audit invariants, not folders.** Directories help locate ownership; an
   invariant or end-to-end path defines what must remain true.
3. **Exact snapshot or no verdict.** Every run records the immutable commit,
   dirty-content fingerprint when applicable, scope, exclusions, environment,
   model, prompt hash, and commands.
4. **Evidence is layered.** A code trace is not an integration test; a passing
   happy path is not a failure-boundary test; a broad gate is not a proof of the
   narrow invariant.
5. **Findings are hypotheses until reproduced.** A second reviewer must confirm
   every P0/P1 root cause independently. Generic advice is not a finding.
6. **Fix root causes once.** Duplicate symptoms share one root-cause key, one
   accepted task, one owner, and one regression family.
7. **The fixer is not the only verifier.** Closure requires independent review
   plus the smallest relevant test, the targeted flow, and the owning broad
   gate.
8. **Change invalidates only its dependency cone.** File and dependency
   fingerprints mark affected evidence stale; unrelated modules keep credit.
9. **Priority and confidence are separate.** High impact with low confidence is
   sent to a second audit immediately, not buried and not implemented blindly.
10. **Release gates consume evidence; they do not invent it.** A release is a
   deterministic query over current proofs, accepted risk, and policy.
11. **Scores summarize evidence; they never replace it.** A reviewer score is
    advisory and cannot close a finding or compensate for missing tests. The
    release gate is zero confirmed P0/P1 plus current required evidence. The
    stricter ideal gate may demand three reviewers and a 990/1000 floor, but it
    is a named post-release-quality target, not a reason to negotiate scores.
12. **One product operation has one production path.** Legacy behavior,
    compatibility aliases, fallback readers or writers, version-selected
    `v2`/`v3` execution branches, and parallel financial formulas are release
    blockers unless the owner explicitly approves a bounded offline migration.
    An availability policy such as direct-then-relay is one named canonical
    route, not permission to retain an older protocol path.

## 2. Canonical hierarchy

```text
system
└── domain
    └── module
        └── submodule
            ├── invariant
            ├── end-to-end path
            └── failure boundary
                └── evidence
                    └── finding → fix → independent verification
```

- A **domain** is a major trust or execution plane: contracts, runtime,
  transport, storage, product UI, operations, or supply chain.
- A **module** owns one coherent state, authority, or failure boundary. It may
  span several folders.
- A **submodule** is a bounded implementation responsibility that can be
  audited independently.
- An **invariant** is a falsifiable statement, such as “no response on the read
  lane contains private key material”.
- A **path** is one user or operator outcome from entry to durable observable
  result, such as registration → account → payment → receipt.
- A **failure boundary** names a hostile transition: restart, timeout,
  backpressure, duplicate input, stale socket, malformed proof, partial write,
  cancellation, or concurrent operation.
- **Evidence** is a reproducible observation tied to the exact snapshot.

The hierarchy gives ownership; cross-module paths form a dependency graph. Do
not force an end-to-end flow into one module merely to preserve a tree.

## 3. How to split any codebase into modules

Start from behavior and trust boundaries, then map files:

1. List externally visible outcomes and irreversible effects.
2. Locate every authority boundary: signer, admin, consensus quorum, capability,
   database writer, network peer, browser, worker, and deployment operator.
3. Locate state lifecycles: create, validate, mutate, commit, publish, recover,
   rotate, delete.
4. Separate components whose failure, determinism, or trust model differs.
5. Join code only when it shares the same owner, invariants, state lifecycle,
   and release evidence.
6. Add cross-module user paths after module ownership is stable.

Each module manifest records:

```text
id · purpose · criticality · owners · source globs · test globs · exclusions
dependencies · entry points · outputs/effects · state · authorities
invariants · paths · failure boundaries · required evidence · release profile
```

Every invariant also owns explicit source and test globs. Its invariant ID is
the claim scope: a run that names only a module has inspected that module but
has not attested any invariant. The union of invariant globs must cover every
non-excluded module source and test file. Free-form prose must never widen
claim scope.

An exclusion always has a reason. “Partial coverage” without omitted paths and
their risk is invalid output.

## 4. Audit cycle

```text
MAP → PLAN → AUDIT → REPRODUCE → ADJUDICATE → FIX → VERIFY → MONITOR
```

1. **Map:** build the module/dependency graph and inventory assets, entry
   points, authorities, state, and effects.
2. **Plan:** rank invariant-sized audit units by importance and missing
   evidence. Freeze the target SHA and exact scope.
3. **Audit:** one reviewer traces one path or at most three related invariants.
4. **Reproduce:** turn every material claim into a deterministic trigger,
   counterexample, trace, or failure injection.
5. **Adjudicate:** verify reachability and product semantics; reject noise,
   duplicates, intentional behavior, and claims invalidated by the trust model.
6. **Fix:** change the smallest correct ownership boundary. Never weaken an
   invariant to make a test pass.
7. **Verify:** run L1 → L2 → owning L3 gate and obtain independent review.
8. **Monitor:** fingerprint dependencies; mark stale evidence and schedule only
   the affected delta-audit.

Broad “audit the whole repository” passes are gap scans. They never replace
narrow, comparable audit units.

## 5. State machines

Module state:

```text
UNMAPPED → MAPPED → IN_REVIEW → AUDITED
AUDITED + changed fingerprint → STALE
any state + confirmed P0/P1 → BLOCKED
```

Finding state:

```text
CANDIDATE → CONFIRMED | REJECTED
CONFIRMED → ACCEPTED | OWNER_DEFERRED
ACCEPTED → FIXED → VERIFIED
```

- `CONFIRMED` requires an independent reproduction.
- `REJECTED` retains the reason so the same false positive is not rediscovered.
- `FIXED` means code exists; it does not mean the issue is closed.
- `VERIFIED` requires current evidence at all required levels.
- `OWNER_DEFERRED` requires explicit policy, owner, expiry, and compensating
  control. It is never a silent “later”.

Evidence state:

```text
MISSING | PASS | FAIL | STALE
```

Only current `PASS` evidence contributes to coverage.

## 6. Evidence ladder and honest percentages

Default invariant evidence weights:

| Evidence | Weight | Required meaning |
| --- | ---: | --- |
| Code and data-flow trace | 15% | Reachable source path and ownership understood |
| L1 narrow regression | 20% | Smallest deterministic counterexample passes |
| L2 targeted real flow | 25% | Real components exercise the user/protocol path |
| Failure injection | 25% | Restart, race, corruption, timeout, or hostile boundary |
| L3 broad/release gate | 10% | Owning suite passes on the same snapshot |
| Independent verification | 5% | Different reviewer reproduces the claim/result |

```text
audit coverage = current PASS evidence weight / required evidence weight
```

Module and system coverage are risk-weighted averages of invariant coverage.
`FAIL`, `MISSING`, and `STALE` contribute zero. A module with one fully tested
minor path and an untouched money path must not look “50% audited” unless the
risk weights actually justify it.

Quality measures confirmed risk debt, capped by what is known:

```text
riskDebt  = 45×P0 + 20×P1 + 7×P2 + 2×P3 + structuralDebt
rawQuality = max(0, 100 - riskDebt)
quality    = min(rawQuality, 40 + 0.6×auditCoverage)
```

Additional caps:

- open P0: quality ≤20%;
- open P1: quality ≤60%;
- unresolved P0/P1 candidate: quality ≤75%;
- unaudited module: never 100% quality.

Coverage answers “how much did we prove?” Quality answers “how good is the
current result?” Confidence answers “how likely is this particular judgment to
be correct?” These numbers are never substituted for one another.

## 7. Importance, confidence, and action policy

Score importance from 0–100 using the geometric mean of:

- financial or safety impact;
- blast radius;
- production exposure;
- irreversibility.

```text
actionPriority = importance × (0.5 + confidence / 200)
```

The confidence multiplier keeps a catastrophic but uncertain claim near the
top while routing it through verification first.

Canonical action policy:

- confidence ≥95%: act autonomously when the change is reversible and does not
  alter consensus, cryptography, contracts, or product semantics;
- confidence <95%: request a blind second audit from another model family or an
  xhigh reviewer;
- still <95% after two independent analyses: ask the owner a concrete question
  with evidence and bounded options;
- P2/medium semantic changes: require owner approval;
- consensus, cryptography, and contract changes: require owner approval at any
  confidence;
- P0/P1 safety containment may be proposed immediately, but destructive or
  externally visible actions still require authority.

## 8. Multi-agent audit protocol

Each assignment contains:

```text
immutable SHA · module ID · one path or ≤3 invariants · source/test scope
explicit exclusions · threat/failure boundaries · required output schema
commands allowed · no-edit/read-only rule · confidence requirement
```

The completed run records exact `invariantIds` and the corresponding
`moduleFingerprints`. Evidence counts only when an attesting completed run
names that invariant, records the same module fingerprint, and shares the
evidence source SHA. A module scorecard counts only when its run names every
current invariant in that module at the scorecard's exact fingerprint.

Roles are separated:

1. **Mapper:** defines ownership, dependency cone, invariants, and gaps.
2. **Auditor A:** receives a narrow blind prompt and produces candidate root
   causes with reproduction evidence.
3. **Auditor B:** uses another model family and independently audits the same
   immutable scope without seeing A’s conclusions.
4. **Adjudicator:** traces real reachability and rejects findings that ignore the
   system’s state, nonce, authority, or consensus model.
5. **Fixer:** implements only confirmed root causes in an isolated worktree.
6. **Verifier:** independently reruns the counterexample, L1, L2, and owning
   broad gate on the final candidate SHA.

Use available concurrency for independent modules, not multiple writers in one
worktree. The integrator alone resolves overlaps and owns the final candidate.

Canonical staffing for one release epoch:

- exactly one writer owns the mutable integration worktree;
- zero to three read-only auditors inspect bounded scopes in parallel;
- auditors work from an immutable SHA whenever a verdict can affect a gate;
- no auditor commits, rebases, merges, or fixes inside the writer worktree;
- a new writer starts only after the previous epoch lands in clean `main` or is
  explicitly abandoned.

Recommended reviewer allocation by task class:

- 70% to the current leader for that class;
- 20% to the strongest different model family;
- 10% to a challenger, preventing permanent leaderboard lock-in.

## 9. Finding and adjudication contract

A valid finding includes:

```text
id · rootCauseKey · module/invariant · exact SHA · severity · confidence
reachable trigger · expected vs actual · impact · source locations
reproduction command/test · evidence artifact hash · reviewer · disposition
```

Severity:

- **P0 critical:** immediate loss, global integrity failure, or unrecoverable
  corruption on a reachable path;
- **P1 high:** material safety, liveness, authority, funds, or release-integrity
  failure;
- **P2 medium:** bounded correctness/availability/UX risk requiring planned
  remediation;
- **P3 low:** local hardening or maintainability debt with no material current
  impact.

Before acceptance, adjudication asks:

1. Is the path reachable in the configured product?
2. Does the claim understand the actual authority, nonce, state, and finality
   model?
3. Is this a new root cause, a duplicate symptom, intended behavior, or stale
   code?
4. Can another reviewer reproduce it without reading the first conclusion?
5. What regression would fail before the fix and pass after it?

## 10. Reviewer leaderboard

Reviewers are rewarded for independently confirmed root causes, not report
length or finding count:

| Result | Discovery points |
| --- | ---: |
| Unique confirmed P0 | 16 |
| Unique confirmed P1 | 8 |
| Unique confirmed P2 | 3 |
| Unique confirmed P3 | 1 |
| Duplicate, generic advice, unreproduced claim | 0 |

Track unique confirmed bugs, severity yield per ten audit units, Wilson
precision over adjudicated claims, reproduction completeness, time, and cost per
confirmed bug. The composite score is:

```text
1000 × (0.55×normalized severity yield
      + 0.30×Wilson precision
      + 0.15×reproduction completeness)
```

Fewer than five adjudicated claims is `PROVISIONAL`. False positives remain in
the denominator. Model name, version, effort, prompt hash, scope, and snapshot
must be recorded so the comparison is meaningful.

## 11. Delta audits and evidence caching

Every evidence record retains its source SHA for provenance. Eligibility for a
current audit state is keyed by:

```text
invariant ID + module fingerprint + evidence kind + environment fingerprint
```

An old-SHA result remains reusable when the exact module fingerprint and
environment still match; requiring the repository HEAD alone would discard
valid evidence after an unrelated commit. The attesting run and immutable
artifact remain bound to the evidence's recorded source SHA.

The module fingerprint covers owned paths plus declared dependencies. On a
change:

1. calculate the touched dependency cone;
2. mark only matching evidence `STALE`;
3. plan missing evidence in descending action priority;
4. reuse current artifacts outside the cone;
5. run each expensive broad gate once per unchanged candidate.

Higher release gates consume structured artifacts from lower gates instead of
rerunning identical security packs or E2E suites. Cache reuse is allowed only
when all four key parts match.

The canonical fingerprint also follows real relative imports and reverse test
imports. This closes two dangerous gaps that hand-maintained globs miss: a
module importing financial constants or jurisdiction normalizers outside its
folder, and a regression test whose filename does not contain the module name.
Cycles are included as actual file reachability; a broad invalidation cone is
an architecture-coupling signal to refactor, never a reason to omit evidence.

## 12. Merge and release gates

Merge requires:

- current fingerprints for touched modules;
- L1 and L2 for changed critical invariants;
- no confirmed P0/P1;
- owner approval for semantic P2, consensus, cryptography, or contracts;
- independent review when confidence began below 95%;
- repository-wide check green on the exact candidate.

Release requires:

- critical-module audit coverage ≥90%;
- funds, determinism, persistence, and authority invariants at 100%;
- P0/P1 = 0;
- every open P2 explicitly accepted with owner and expiry;
- independent delta-audit on the exact release SHA;
- release, topology, restart, package, and user-path evidence green.

Public contract deployment additionally requires 100% current coverage for
every contract authority, signature-domain, value-conservation, bytecode, ABI,
and deployment-binding invariant. A locally green build is necessary evidence,
not permission to deploy; historical public deployments remain unchanged until
the exact candidate satisfies this gate.

Uncapped production/mainnet requires 100% coverage for all critical invariants
and mandatory paths, a full independent audit on the exact SHA, soak evidence,
and zero unresolved high-impact candidates.

The separate ideal gate is stricter than release: every mapped module must have
100% coverage, 100% derived quality, no open finding of any severity, and a
current review floor of 990/1000 across at least three reviewers and two model
families. Scores are never averaged; the minimum current score governs. This
ideal gate is pursued only after the named product release gate is already
green; it cannot keep an MVP in permanent audit churn.

## 13. Canonical storage model

Use one machine-readable audit registry for modules, invariants, runs, evidence,
findings, and reviewer adjudication. Use one backlog for accepted open work.
Never maintain parallel task lists in audit reports.

- The registry stores facts, states, references, and fingerprints.
- The backlog stores only accepted, still-open remediation with stable audit IDs.
- Immutable artifacts store full logs outside the source tree or in a dedicated
  evidence store.
- Every artifact entry exact-binds its invariant ID, evidence kind, module
  fingerprint, attesting run IDs, and recorded timestamp; relabeling any one of
  these fields invalidates the artifact.
- Human documentation explains the protocol and architecture; it does not copy
  mutable percentages or duplicate findings.
- Dashboards and status tables are generated from the registry.

## 14. Canonical command surface

The repository exposes one generated view of the registry:

```bash
bun run audit:status          # all module percentages and reviewer ledger
bun run audit:plan            # next work ranked by risk and missing evidence
bun run audit:validate        # schema, ownership, artifacts, and source globs
bun run audit:verify          # validation plus current-evidence requirement
bun run audit:gate:merge      # current evidence plus P0/P1 merge policy
bun run audit:gate:release    # merge policy plus release coverage thresholds
bun run audit:gate:ideal      # every module 100% with 990/1000 review quorum
```

`bun run check` uses `validate`, so an honest incomplete audit does not make an
otherwise healthy checkout permanently red. Merge/release decisions use
`verify` and the profile gates; stale evidence therefore still fails closed.

`verify` treats evidence as append-only history: an archival row may have an
old fingerprint, but every required evidence kind must have a current
replacement. `status` and both gates use the same derived staleness model, so a
dashboard cannot disagree with automation. Percentages, module states, and
reviewer rankings are outputs; hand-edited copies are never canonical.

## 15. Adoption sequence

1. Create a module inventory without claiming coverage.
2. Define critical invariants, paths, failure boundaries, and dependency globs.
3. Baseline existing tests as evidence only after proving what they exercise.
4. Audit the highest-importance, lowest-coverage path first.
5. Introduce independent adjudication and the reviewer ledger.
6. Enable staleness checks on touched modules at merge time.
7. Enable release thresholds only after the first honest baseline.
8. Add evidence caching after outputs are structured and reproducible.

The protocol is working when a new engineer can answer, from generated data:

- what can lose money or authority;
- which invariant protects it;
- what exact evidence is current;
- what changed since that evidence;
- which findings are independently confirmed;
- why the next task is the highest-priority one;
- what must pass before merge or release.

## 16. Release epoch and phase handoff

One release epoch has one scope, one writer, and one immutable candidate:

1. Declare the product paths being released and the modules explicitly deferred.
2. Start one writer worktree from current `main`; preserve unrelated user work
   in place and integrate it only by content-aware commit or merge.
3. Run read-only investigations in parallel. Adjudicate P0/P1 twice before
   editing when the root cause or ownership boundary is uncertain.
4. Fix in priority order: irreversible money/authority, deterministic replay,
   persistence/restart, authenticated transport, then user-path correctness.
5. Prove every fix L1 then L2. Create a candidate commit only when the mutable
   worktree has no unexplained changes.
6. Pin two independent auditors to that exact candidate. Any accepted finding
   creates a new candidate and invalidates only its dependency cone.
7. On the final unchanged candidate, run browser/F12 evidence and the owning L3
   gate exactly once, then integrate directly into `main`.
8. Remove merged temporary worktrees and branches. Preserve an annotated audit
   or release tag when the snapshot must remain addressable.

The handoff packet contains: final SHA, scope and deferrals, open findings,
current evidence commands/results, module fingerprints, frozen boundaries,
operator constraints, and the first three tasks of the next phase. A handoff is
valid only from clean `main`; a new main agent never inherits an unexplained
dirty integration worktree.

When a core-to-product phase boundary is declared, the verified core becomes a
change-controlled dependency. Product/UI work may consume its public API but
does not refactor core opportunistically. A core change reopens only for a
reproduced P0/P1, a required product invariant, or explicit owner approval.

## 17. Prohibited shortcuts

- one unexplained “audited %” or “quality %”;
- severity without a reachable trigger;
- confidence derived from model reputation alone;
- accepting an external report without local reproduction;
- broad scans that omit folders without naming them;
- reviewer rankings based on raw finding count;
- a fix verified only by its author;
- closing a finding because code changed, without a regression;
- rerunning expensive gates on the same snapshot instead of reusing evidence;
- treating old evidence as current after its dependency fingerprint changed.

The final invariant is recursive: this protocol itself changes only through a
reviewed proposal, a concrete failure it addresses, and evidence that the new
rule improves signal, safety, or cycle time.

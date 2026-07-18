# xln mainnet handoff

This is the **only live TODO/NEXT file**. Treat every older audit, chat summary,
and generated report as advisory until it is rechecked against the exact snapshot
recorded below.

## 0.0 Current handoff — 2026-07-17 debug acceleration and E2E stop point

This section supersedes every older “current/stop point” below. Older sections
remain useful as the complete backlog, but their snapshots and red counts are
historical.

### Exact pre-documentation snapshot

- Branch: `main`.
- HEAD: `b4d99b9cf7781c7f02b5f6faab69c63953b96a3c`.
- Status before this documentation edit: `916` entries = `595` tracked + `321`
  untracked.
- Short-status SHA-256:
  `c38677b7f8fd5e997711e3b6f8569f9b95d08443b87efe8fe28102e85075694d`.
- Untracked-list SHA-256:
  `5da97d22bc8443ec0abd27f44b4336ce51303fc10070a4800b828cc633f2f022`.
- Tracked diff: `595 files, +59,226/-21,716`.
- `frozen-core.json` SHA-256:
  `2732af3b3fa5b5688ce9c3ff414251f921013918d3e067372f0119ee28618ffa`.
- Re-capture these values immediately. This file edit intentionally changes the
  status/content hash. Do not reset, clean, checkout over, or delete any part of
  this shared worktree.
- Release state: **BLOCKED**. No commit, push, deployment, production canary, or
  GitHub release was performed. `frozen-core:approve` was not run.

### Latest proven root fixes

1. Remote admin Entity commands no longer require the browser payment-journal
   vault to be unlocked. A valid admin capability lane uses the server's signed,
   sequenced, commandId/inputHash-deduplicated one-shot path; same-vault payment
   intents still own durable retry. Terminal receipts are intentionally not left
   as permanent wallet banners.
2. Storage snapshot rotation now retains every replay diff after the **oldest**
   retained snapshot. The previous code pruned from the newest snapshot and made
   the advertised older snapshot unreplayable.
3. Two separately authorized, byte-identical `direct_payment` intents are no
   longer collapsed while the first payment is in `Account.pendingFrame`.
   Entity-command nonce/idempotency distinguishes retries before Account
   projection; lifecycle txs remain exact-payload idempotent.
4. Failure debugging now has exact code fingerprints (tracked + untracked bytes),
   a latched drift guard, a tagged Map/Set/BigInt state diff with first divergent
   path, exact rerun capsules, and a complete 5,000-event relay forensic dump.

Directly involved files:

- `frontend/src/lib/stores/xlnStore.ts`
- `tests/frontend/runtime-command-bus.test.ts`
- `tests/e2e-radapter-remote.spec.ts`
- `runtime/storage/index.ts`
- `runtime/__tests__/storage-frame-journal-retention.test.ts`
- `runtime/entity/consensus/index.ts`
- `runtime/entity/consensus/account-mempool-queue.ts`
- `runtime/__tests__/account-mempool-queue.test.ts`
- `runtime/qa/code-fingerprint.ts`
- `runtime/qa/code-fingerprint-cli.ts`
- `runtime/qa/runtime-state-diff.ts`
- `runtime/qa/runtime-state-diff-cli.ts`
- `runtime/__tests__/qa-code-fingerprint.test.ts`
- `runtime/__tests__/runtime-state-diff.test.ts`
- `runtime/scripts/run-e2e-parallel-isolated.ts`

### Latest green evidence on these exact fixes

```text
debug helpers + payment multiplicity L1     10 pass / 0 fail / 47 expects
storage frame-journal retention file        29 pass / 0 fail / 109 assertions
target 40 admin remote-runtime E2E           1 pass / 0 fail / 18.8s / strict F12
  artifacts: .logs/e2e-parallel/20260717-160244-393
target 45 rebalance-cycle E2E                1 pass / 0 fail / 35.8s / strict F12
  artifacts: .logs/e2e-parallel/20260717-161750-046
```

Target 45 forensic chain, now encoded by the regression:

- H51 proposed Account H7 containing faucet payment X.
- H53 received a second legitimate user intent with identical AccountTx bytes
  plus the ACK for H7.
- Old `queueUniqueAccountMempoolTx` compared X against `pendingFrame` and silently
  discarded the second intent. The receipt was “observed”, but Account H8 never
  existed and exposure stayed exactly 500 USDC.
- The correct fix is multiplicity preservation for `direct_payment`, not changing
  the faucet amount, rebalance threshold, timeout, or receipt semantics.

### Current hard RED

`bun run check:runtime-types` currently fails only in
`runtime/scripts/run-e2e-parallel-isolated.ts` with 12 TypeScript diagnostics:

1. `:1174` manifest shard status type excludes `cancelled` even though the runner
   now preserves cancelled shards.
2. `:1689-1702` tuple inference for the owned-port PID Map is not explicit.
3. `:1954`, `:1984`, `:2010` pass `signal: undefined` under
   `exactOptionalPropertyTypes`; spread the property only when defined.
4. `:3012` leaves unused `const code`.

Do not weaken types or cast the whole manifest. Fix each boundary narrowly, run
the relevant runner L1 files, then rerun `bun run check:runtime-types`.

The causal frame-DB CLI was designed but **not written** before handoff. It is a
debug accelerator, not a release blocker. If implemented, keep it minimal and
read-only:

```text
bun runtime/qa/runtime-causal-trace-cli.ts \
  <frameDbPath> <entityId> <counterpartyId> [fromRHeight] [toRHeight]
```

It should use the existing validated `readFrameDbRuntimeActivity` and
`readFrameDbAccountFrames` APIs and correlate R-height, EntityTx type/data hash,
touched Account, Account height/source/state hash, and ACK. Do not add a second
storage decoder.

### Strict next order

1. Re-capture HEAD/status/untracked/content fingerprint and ensure there is one
   writer. Use:

```bash
bun runtime/qa/code-fingerprint-cli.ts snapshot
```

2. Fix only the four runner type groups above. L1 first:

```bash
bun test \
  runtime/__tests__/e2e-runner-primary-failure.test.ts \
  runtime/__tests__/e2e-runner-secondary-failure.test.ts \
  runtime/__tests__/e2e-runner-isolation.test.ts \
  runtime/__tests__/e2e-browser-failure-hook.test.ts \
  runtime/__tests__/qa-code-fingerprint.test.ts \
  runtime/__tests__/runtime-state-diff.test.ts
bun run check:runtime-types
```

3. Run the complete functional category. The previous eight-shard sweep stopped
   at target 45, so passes from a partial/cancelled run do not prove the category:

```bash
bun runtime/scripts/run-e2e-parallel-isolated.ts \
  --qa-category=functional --shards=8 --workers-per-shard=1 \
  --max-failures=1 --strict-browser-health --preserve-artifacts
```

4. For each failure: exact capsule rerun only, L1 regression, root fix, exact L2,
   then resume from that target. Never increase a timeout to hide missing state
   progress and never use semantic payload equality to dedupe distinct user
   financial intents.
5. After functional is all green, run the resilience/worst-case category, then
   the release/MM gates and the full protocol stack in section 5 below.
6. Recheck the current bytes for the audit claims below. Do not copy findings from
   an old snapshot into a verdict.

### Audit claims still requiring current-code proof

These are not all re-confirmed bugs; they are mandatory audit questions before
release because their original reports observed a moving worktree:

- Account proposal timestamp, `r2c` expiry, and `profile-update` must use the
  committed Entity-frame timestamp, never the validator's local tick.
- Account jurisdiction, direct-payment route, `watchSeed`, cross-J commitments,
  deadlines, and rebalance policy must come from committed/certified state or the
  signed input, never local gossip, runtime seed, sibling replicas, or adapter
  registry during reducer replay.
- Account finalize and Entity reducer must not mutate/read unrelated live Entity
  replicas to decide consensus state or certified outputs.
- HTLC plaintext secret must not enter a proposal/WAL before the durable unlock
  transition; ordinary same-Entity propagation stays in the same Entity-frame
  apply phases, cross-Entity propagation uses the authenticated output lane.
- J-range preflight must cover proposer signature, exact observation height,
  canonical event order, certified-anchor corruption, overlap prefix, and reducer
  acceptance. Invalid proposals soft-reject/quarantine the lane; they must not halt
  the runtime.
- Watcher log/receipt completeness and multi-J `(chainId, Depository)` selection
  remain fail-closed. The watcher only reads the jurisdiction machine; it does not
  transport Entity frames.

### Full gates still unproven on the current worktree

```bash
bun run test:unit
bun run test:contracts:full
bun runtime/scenarios/determinism-test.ts
bun runtime/scenarios/run.ts --all
bun run security:audit-pack
bun run test:e2e:release
bun run test:e2e:mm
bun run check
bun build runtime/runtime.ts --target=browser --external http --external https \
  --external zlib --external fs --external path --external crypto \
  --external stream --external buffer --external url --external net \
  --external tls --external os --external util
```

Only after all gates are green: make reviewed logical commits, push, freeze an
immutable SHA, independently re-audit the eight protocol properties, and then
follow the 0.1.9 release/deploy/canary procedure in section 6. Never run
`frozen-core:approve`; an actual frozen-core violation is an owner hard stop.

## 0. Snapshot and non-negotiable rules

- Captured: `2026-07-16T18:40:58+03:00`.
- Branch: `main`.
- HEAD: `b4d99b9cf7781c7f02b5f6faab69c63953b96a3c`.
- HEAD subject: `fix(consensus): certify exact jurisdiction prefixes`.
- Worktree status hash: `29ecf3a9faeae12a6761df04a13fc0559b1ae44c874b685c3758570002ccdbfc`.
- Status entries before this file: `850`; untracked files: `417`.
- Untracked-list hash: `6cfb3ba8a00037c3100df493d9520d6f46794fb0def1b3dbf2696e72b290276c`.
- Unstaged diff before this file: `560 files, +51,111/-19,098`.
- The worktree contains valuable user work from several protocol tracks. Never
  reset it, clean it, checkout over it, or stage everything blindly.
- Freeze concurrent writers before any independent audit. Record HEAD, status
  hash, untracked hash, and hashes of audited files. Stop the audit on byte drift.
- Never run `bun run frozen-core:approve`, never edit `frozen-core.json`, and
  never bypass `frozen-core:check`. A frozen-core violation is an owner gate.
- No stubs, mocks for production paths, silent skips, swallowed errors, fallback
  authority, fake registration, or compatibility layer for a nonexistent public
  network.
- Use Bun. Keep RJEA deterministic. Use the browser build command from AGENTS.md.
- Test every fix L1 narrow, then L2 targeted flow, then L3 broad gate.
- Release `0.1.9` remains blocked until all P0/P1 items below are green on one
  immutable commit and the eight protocol properties receive a fresh independent
  audit.

### 0.0 Current authoritative stop point: per-Env contract authority

- Captured after the owner said `stop and handoff` on `2026-07-16`. No runtime
  code was changed after this stop. Branch/HEAD remains `main` at
  `b4d99b9cf7781c7f02b5f6faab69c63953b96a3c`.
- Pre-handoff worktree snapshot: `852` status entries, `417` untracked files;
  short-status hash
  `45a5e7c3a00398047e27f4165afe6b4a4ef5d7905825233d6054342dac08cdad`;
  untracked-list hash
  `6cfb3ba8a00037c3100df493d9520d6f46794fb0def1b3dbf2696e72b290276c`;
  tracked diff `562 files, +51,999/-19,617`. This file edit changes the final
  status hash; use the external `context-save` checkpoint named in the handoff
  response for the final post-documentation snapshot.
- Release state: **BLOCKED**. No commit, push, deploy, production canary, GitHub
  release, or frozen-core approval was performed.

Latest proven RED and root cause:

- Full unit before this workstream was `2737 PASS / 1 FAIL`, `41,353 assertions`,
  `2,738 tests`, `390 files`. The sole failure was the multisig HTLC validator
  encryption test with `MISSING_SIGNER_KEY`.
- Minimal order-dependent RED:
  `bun test runtime/__tests__/runtime-import-external-side-effects.test.ts runtime/__tests__/multisig-htlc-validator-encryption.test.ts`
  produced `31 PASS / 1 FAIL`; the target test alone passed. The isolated PASS
  was false confidence.
- Root cause 1: `runtime/protocol/dispute/proof-builder.ts` held a process-global
  DeltaTransformer address. A BrowserVM import for Env A changed ProofBody
  construction in unrelated Env B. Contract authority must be local to the exact
  trusted `(chainId, Depository)` JReplica.
- Root cause 2: ProofBody construction failure was returned as
  `proposal.success=false` and ignored by the Entity proposer path, so the test
  could pass without ever proposing the expected Account frame.
- Root cause 3: the test described “two validators” while its source board is
  `1-of-1`. Cold restores of that Entity require the same vault key; registering
  that exact source key is legitimate, while adding gossip or a second arbitrary
  signer would mask the bug.

Uncommitted implementation now in the tree:

- `buildAccountProofBody(account, deltaTransformerAddress)` is pure and explicit;
  the process-global setter/getter were removed from production.
- Production ProofBody paths resolve the transformer from the current Env's exact
  Entity-certified `(chainId, Depository)` JReplica. The transformer itself comes
  only from durable `JReplica.contracts.deltaTransformer`; missing or ambiguous
  authority fails loud. Frontend restore no longer backfills every JReplica from
  one primary jurisdiction.
- Account proof construction now throws `DISPUTE_PROOF_BUILD_FAILED` instead of
  silently leaving an input in the mempool. Focused domain/import tests reached
  `3 PASS / 1 FAIL` before the next issue below.
- The next real failure was `SIGNER_RESOLUTION_FAILED`: Account-output routing
  depended on local gossip even though validators already have the recipient
  signer in the certified prepared HTLC envelope. The unfinished change carries
  that signer as `HtlcRoute.outboundSignerId` and derives the Account-output
  proposer from the exact certified lock/route rather than gossip.

**Current code is intentionally not green and must not be committed.** The last
`bun run check:runtime-types` stopped with exactly two TypeScript errors because
`validatePreparedHtlcPayment` returns `nextHopSignerId` at runtime but its explicit
`Promise<Readonly<{...}>>` type does not declare it:

```text
runtime/entity/tx/handlers/htlc-payment.ts(87,32): Property 'nextHopSignerId' does not exist
runtime/protocol/htlc/payment-admission.ts(791,5): object literal may only specify known property
```

Exact resume order for this active stop point:

1. Re-capture HEAD/status/untracked hashes and ensure one writer. Read the latest
   external checkpoint before editing.
2. Add `nextHopSignerId: string` to the explicit return type of
   `validatePreparedHtlcPayment` in
   `runtime/protocol/htlc/payment-admission.ts`; then run
   `bun run check:runtime-types`.
3. Run the minimal L1 order-dependent regression above plus the focused tests
   matching `ignores hostile gossip`, `fails closed on a missing or duplicate`,
   `BrowserVM import publishes one live adapter`, and `two cold restores`.
4. Do **not** add gossip to make the HTLC test pass. The next-hop signer must come
   from the already certified prepared route/profile and every validator must
   independently derive the same value.
5. Migrate remaining test-only global setter/build calls to explicit addresses.
   `rg -n "setDeltaTransformerAddress|getDeltaTransformerAddress|buildAccountProofBody\\(" runtime frontend/src`
   currently finds stale setter imports/calls in `dispute-arguments`,
   `proof-builder`, `audit-failfast-regressions`, `cross-jurisdiction-swap`,
   `htlc-dispute-secret-publication`, and `transformer-ordering`, plus direct
   one-argument builders in several tests. Active-transformer fixtures pass their
   exact address; fixtures with no programmable commitments may pass `''`.
6. Update callers of the changed `buildSettlementSealDraft` and
   `applyFinalizedAccountJEvents` signatures. Update
   `runtime/scripts/check-consensus-hanko-scan.ts`, whose expected source string
   still names the old one-argument builder.
7. Add regressions proving two interleaved Envs cannot affect each other's proof
   bytes/hash, missing/duplicate exact jurisdiction authority fails loud, and a
   ProofBody configuration failure cannot be swallowed as a semantic rejection.
8. Run named L1, whole related files, then `bun run test:unit`. Only after
   `2738/2738` (or the new exact total) is green continue with the ordered gates
   in section 5.

Files most directly involved in the unfinished unit are:

- `runtime/protocol/dispute/proof-builder.ts`
- `runtime/account/consensus/helpers.ts`
- `runtime/account/consensus/propose.ts`
- `runtime/runtime.ts`
- `frontend/src/lib/stores/vaultStore.ts`
- `runtime/types/account.ts`
- `runtime/protocol/htlc/payment-admission.ts`
- `runtime/entity/tx/handlers/htlc-payment.ts`
- `runtime/entity/tx/handlers/htlc-onion-advance.ts`
- `runtime/entity/consensus/index.ts`
- `runtime/__tests__/account-hanko-domain-trust.test.ts`
- `runtime/__tests__/runtime-import-external-side-effects.test.ts`
- `runtime/__tests__/multisig-htlc-validator-encryption.test.ts`

### 0.1 Superseded stop point: full-unit stabilization

- Captured after the owner requested `stop and handoff`:
  `2026-07-16T20:11:25+03:00`. Development, tests, release, and deployment are
  stopped. This section supersedes the archived HTLC stop point below.
- Branch/HEAD: `main` at
  `b4d99b9cf7781c7f02b5f6faab69c63953b96a3c`.
- Final worktree snapshot after this documentation edit: `852` status entries,
  `562` tracked and `290` untracked; short-status hash
  `45a5e7c3a00398047e27f4165afe6b4a4ef5d7905825233d6054342dac08cdad`;
  untracked-list hash
  `51fd857f2528d374a54f629a51d2aedd582db5c1ba09b82ddda46ca4b7c2ac0e`.
  The external `context-save` checkpoint records the final binary-diff hash and
  stat without introducing a self-referential hash into this file. Re-capture all
  values before changing any byte because this is a large shared dirty tree.
- Release state: **BLOCKED**. No commit, push, deployment, production canary, or
  GitHub release was made.

Latest verified HTLC result:

- The fee-adjusted route mismatch was fixed in
  `runtime/protocol/htlc/onion-advance.ts`: expected outbound amount is
  `route.amount - (route.pendingFee ?? 0n)`, not the gross incoming amount.
- Regression uses gross `7,000,007`, fee `7`, downstream `7,000,000`.
- Focused HTLC: `23/23 PASS`, `151 assertions`; related stack: `43/43 PASS`,
  `409 assertions`.
- Isolated visible payment Playwright: `1/1 PASS`; strict browser health
  `0 errors / 0 warnings`; sender `92.9999`, recipient `7`.

Latest full-unit state:

- Broad command: `bun run test:unit`.
- Exact result: `2737 PASS / 1 FAIL`, `41,353 assertions`, `2,738 tests`,
  `390 files`, `152.13s`.
- Sole failure:
  `multisig HTLC validator encryption > seals raw process ingress and lets two validators replay the prepared frame without gossip`.
- Exact error:
  `MISSING_SIGNER_KEY: no registered private key for signer 0xeee7d3f3b8934e8e3036313443f0ea33f164591b`.
- The same named test passes isolated (`1/1`, `16 assertions`) and its whole file
  passes isolated (`23/23`). All known transformer-address setter files plus the
  multisig file pass together (`255/255`, `1,502 assertions`). This points to a
  remaining full-suite order/concurrency/global-key-lifecycle leak; do not hide it
  with retries, isolation flags, or a second registration until the exact deletion
  or scope mismatch is proven.

Test corrections already made and verified:

- `cross-jurisdiction-swap.test.ts`: stale text expectation replaced with the
  canonical `J_RANGE_EVIDENCE_HASH_MISMATCH`; full file `75/75 PASS`,
  `415 assertions`.
- `entity-account-resource-bounds.test.ts`: rollback fixture now supplies the
  required pending Account triple; named L1 `1/1 PASS`, `3 assertions`.
- `audit-failfast-regressions.test.ts`: J sender test now uses a valid signed
  canonical range; HTLC fee fixture now uses the opaque secret offer and the
  shared reveal-height reserve. Audit + multisig run `152/152 PASS`,
  `1,038 assertions`.
- `user-mode-diagnostics.test.ts`: removed a stale ownership assertion; wallet
  bootstrap ownership lives in `vaultStore.ts` and has its own regression.
- Transformer-address globals are reset after tests in the affected files; the
  prior cross-file pollution is proven closed by the `255/255` run above.

One unresolved consensus concern requires an explicit owner decision before code:

- `runtime/entity/tx/j-events.ts` currently runs J-range budget/canonical checks
  before the exact active-proposer sender check. A malformed unauthorized input
  can therefore report a shape error instead of `J_RANGE_NOT_ACTIVE_PROPOSER`,
  despite the nearby comment promising authorization-first rejection.
- Proposed minimal fix: compare `data.from` to the resolved active proposer before
  budget validation, then retain the full canonical validator afterward. This is
  a consensus behavior change and was not made without owner approval.

Exact resume order from this stop:

1. Capture a fresh immutable worktree snapshot and ensure there is one writer.
2. Diagnose the sole full-unit signer-key failure at L1. Assert key presence after
   registration and across each `processRuntime` boundary; compare serial versus
   concurrent full-suite execution. Fix the proven owner of the global lifecycle.
3. Re-run the named test, whole multisig file, related stack, then full unit until
   `2738/2738` is green.
4. Resolve the J authorization-before-budget decision; add RED/GREEN only if the
   owner approves the consensus ordering change.
5. Run `bun run check` fresh. Its previous PASS predates the latest test edits and
   must not be cited as current evidence.
6. Continue the ordered release gates in section 5. Full scenarios require
   `bun runtime/scenarios/run.ts --set=all`; current `--all` silently selects only
   the default six and must be fixed or rejected loudly.

### 0.2 Archived stop point: earlier HTLC payment flow

- Captured after the owner requested an immediate stop: `2026-07-16 19:21:32
  +03:00`. No more code or test work was performed after that request.
- Branch/HEAD: `main` at
  `b4d99b9cf7781c7f02b5f6faab69c63953b96a3c`.
- Current worktree: `851` status entries, `417` untracked files; status hash
  `20f5282f525714595be20fe62d9a82c23eed28fa6160613fe9738d6053b69cfb`;
  NUL-delimited untracked-list hash
  `51fd857f2528d374a54f629a51d2aedd582db5c1ba09b82ddda46ca4b7c2ac0e`;
  tracked diff `561 files, +51,595/-19,460`. Re-capture these before touching
  anything because several agents previously observed byte drift inside already
  dirty files.
- Release state: **BLOCKED**. No commit, push, deployment, production canary, or
  GitHub release was made.

First exact browser RED and the fix now in the dirty tree:

- Run: `.logs/e2e-parallel/20260716-160207-595`; result `FAIL` in `97.2s`.
  `HtlcInitiated` committed, but the sender never received `HtlcFinalized`.
  Failure bundle:
  `.logs/e2e-parallel/20260716-160207-595/shard-0/artifacts/playwright/failure-debug`.
- Root cause: production Account ACK is nested in a top-level
  `consensusOutput`, while the reveal prehook only inspected a bare
  `accountInput`. The prior unit was false-green because it used a bare input and
  fake Hanko bytes.
- Current uncommitted fix shares exact certified-output verification between
  replay and the HTLC reveal prehook. Only an exact pending HTLC ACK candidate is
  verified and allowed to trigger proposer decryption. Bare Account input does
  not reveal a secret.
- Changed files on this path:
  `runtime/entity/consensus/output-certification.ts`,
  `runtime/entity/consensus/index.ts`,
  `runtime/entity/htlc-onion-post-commit.ts`,
  `runtime/__tests__/multisig-htlc-validator-encryption.test.ts`, and diagnostic
  detail in `runtime/protocol/htlc/onion-advance.ts`. Some are untracked relative
  to HEAD, so an empty `git diff` is not proof that their bytes are unchanged.
- L1 after the fix: production-wrapper regression `1/1 PASS` (`5 assertions`);
  complete multisig HTLC validator-encryption file `23/23 PASS`
  (`149 assertions`); three focused ordering/reveal regressions `3/3 PASS`
  (`35 assertions`). A broader related run was `116 PASS / 2 FAIL` before the
  prehook was narrowed; the complete suite has not been rerun after narrowing.

Current exact RED:

- Run: `.logs/e2e-parallel/20260716-161455-471`; result `FAIL` in `27.1s`.
  Hub H3 exits on
  `HTLC_ONION_ADVANCE_REVEAL_ROUTE_BINDING_MISMATCH`. Browser health then reports
  `10 errors / 6 warnings` as consequences of the runtime crash. Failure bundle:
  `.logs/e2e-parallel/20260716-161455-471/shard-0/artifacts/playwright/failure-debug`.
- The failing branch is now narrowed to token/amount binding, not the route
  Entity/lock binding. Leading hypothesis, not yet proven: the stored route amount
  is the incoming amount, while `revealAccepted` carries the fee-adjusted outgoing
  Account lock amount.
- Do not remove the check. First add a narrow RED for a forwarded route where
  incoming and outgoing amounts differ. Then prove which existing certified
  outgoing Account-frame/lock evidence is authoritative. Prefer validating
  against that evidence over adding another stored amount field if it preserves
  exact hashlock, token, route, ACK frame hash/height, offer hash, and downstream
  lock-amount binding.
- A read-only LevelDB forensic load returned an older materialized H3 Entity
  (`height=15`, baseline accounts only), while the failed runtime API showed newer
  sender/recipient accounts. Treat that persisted read as stale and not evidence
  for either amount semantics.

Exact resume order:

1. Read `AGENTS.md` and this file; stop all concurrent writers; hash the five HTLC
   files above plus HEAD/status/untracked list.
2. Reproduce the amount mismatch at L1 with a fee-adjusted forwarded route and
   dump the complete route, incoming lock, outgoing lock, and certified ACK.
3. Make the smallest invariant-preserving fix; do not broaden the schema or delete
   validation without proof.
4. Run the full related focused suite, then the single isolated payment Playwright
   command below. Only after it is green with F12 `0/0` continue to broader gates.

## 1. What is already implemented and verified in this dirty snapshot

These are code-complete milestones, not a release verdict. Re-run their focused
tests after any overlapping edit.

### 1.1 HTLC deadline and secret handling

- Shared minimum reveal reserve is `HTLC.MIN_REVEAL_HEIGHT_DELTA_BLOCKS = 3`.
- Hop construction, admission, onion advancement, and resolution use the same
  reserve instead of scattered `-1` arithmetic.
- The proposer alone creates the random secret. Validators commit encrypted
  envelope data and payment parameters; they must not see plaintext before the
  destination Account durably unlocks.
- Same-Entity propagation is a second apply phase in the same Entity frame through
  the Entity-local lock map. It must not create a needless next frame.
- Cross-Entity output is used only when the route genuinely crosses Entities,
  notably cross-chain/cross-jurisdiction paths.
- Focused result: `44/44 PASS`, `411 assertions`.
- Remaining requirement: fresh adversarial review must prove plaintext is absent
  from proposal/frame/WAL before durable unlock and appears only in the intended
  post-unlock same-frame path or authenticated cross-Entity propagation.

### 1.2 Strict J-range validation and exact prefixes

- One strict validator lives in
  `runtime/jurisdiction/j-event-range-validation.ts`.
- It validates proposer identity, configured jurisdiction, exact heights,
  `observedAt === scannedThroughHeight`, bytes32 fields, strict block/event order,
  evidence hashes, range hash, history root, and proposer signature.
- Preflight, reducer, and J-prefix consensus share canonical validation. Invalid
  proposals soft-reject without state mutation; certified anchor corruption still
  fails loud.
- Fully stale range is idempotent only after validating the envelope/signature.
- Matching overlap verifies the whole prefix and applies only the suffix.
- Conflicting overlap rejects with no mutation.
- Backlog is fully drained in bounded pages. Do not interpret “sync everything”
  as one unbounded consensus frame: the current real-Anvil regression drained
  700+ blocks over three pages.
- Focused result: `117/117 PASS`, `551 assertions`.

### 1.3 Startup shutdown and J catch-up barrier

- Failed post-bind server startup now stops loops/adapters, closes runtime and
  infra LevelDB handles, force-closes the listener, clears globals, and exits
  nonzero while preserving the root error.
- New child-process regression proves the health port refuses connections after
  failure: `1/1 PASS`, `3 assertions`.
- Hub and MM keep mutating rAdapter/direct/reliable ingress closed until local
  jurisdiction watchers reach the frozen chain target and Entity consensus has
  consumed the backlog.
- Reads/auth remain available during catch-up. Retry uses the same `commandId` and
  cannot enqueue twice.
- Canonical drain implementation moved to
  `runtime/jadapter/backlog-drain.ts`; do not create another scenario-only copy.
- Targeted startup/rAdapter stack: `149/149 PASS`, `1,828 assertions`.
- Real Anvil backlog drain: `1/1 PASS`, `17 assertions`.

### 1.4 Compact bounded history and bulk restore

- `readFrameDbAccountFrames` supports reverse bounded reads with `limit`,
  `maxAccountHeight`, and `maxRuntimeHeight`.
- Both hydration and public persisted Account-history callers pass bounds into
  LevelDB instead of filtering after a full prefix scan.
- New `loadEntityStatesAtHeightFromStorage` loads one snapshot, decodes every tail
  diff exactly once, applies all Entity/Account/book docs in one in-memory map,
  then hydrates strictly typed Entity states in deterministic Entity-ID order.
- The public single-Entity reader remains for bounded historical/RPC reads.
- Bulk regression proves two Entities share one decode per diff and produce exact
  canonical Entity hashes.
- Focused compact/codec result: `16/16 PASS`, `58 assertions`.
- Bulk/bounded result: `5/5 PASS`, `34 assertions`.
- Real storage and SIGKILL recovery result: `48/48 PASS`, `746 assertions`.
- `bun run check:runtime-types` passed after the final storage edit.

### 1.5 Existing protocol work that still needs broad re-verification

- On-chain Hanko payloads are bound to trusted local `chainId + Depository` domain
  in Solidity and TypeScript. Prior focused contract inventory reported `78/78`,
  but the current 560-file tree needs the full contract suite.
- Validators independently replay state and recompute secondary manifests before
  signing; proposer does not control validator hashes.
- Validator-local J history, exact Entity-finalized anchors, ordered reliable
  frames/certificates/ACK/J-finality, J-submit durability, atomic storage publish,
  leader progress restore, consumption accumulator, signed Entity commands,
  numeric alias binding, and durable rAdapter command frontiers are present in the
  tree with focused tests. Do not call them release-green until L3 passes.
- The current category gate reports `124 tests`: `84 functional`,
  `40 resilience`, `0 untagged/conflicting`.

## 2. P0: do these first; no release discussion before they are green

### P0.1 Freeze one candidate snapshot

1. Stop all other coding/audit agents and owner `bun run dev` processes that touch
   this worktree.
2. Capture HEAD, `git status --porcelain=v1 | shasum -a 256`, untracked-list hash,
   and `git diff --stat`.
3. Inspect every staged/unstaged/untracked file. Several files were previously
   `MM`; re-stage only after reviewing current bytes.
4. Split logical commits. At minimum keep protocol domains, multisig, J semantics,
   transport/durability, storage, HTLC, and UI/E2E separable. Never `git add -A`.
5. Run `bun run check` before every commit. If frozen core fails, stop for owner.

### P0.2 Restore the real user happy path in isolated Playwright

The owner has personally observed wallet creation and Account opening failures.
Do not accept hidden test APIs as proof of working UX.

Run visible wallet creation first:

```bash
bun runtime/scripts/run-e2e-parallel-isolated.ts \
  --pw-project=chromium \
  --pw-files='tests/e2e-brainvault-parity.spec.ts::standalone BrainVault creates and starts the XLN wallet with deterministic seed material' \
  --shards=1 --workers-per-shard=1 --strict-browser-health \
  --video=retain-on-failure --trace=off --screenshot=only-on-failure --max-failures=1
```

Then visible Account/payment/reload:

```bash
bun runtime/scripts/run-e2e-parallel-isolated.ts \
  --pw-project=chromium \
  --pw-files='["tests/e2e-payment-smoke.spec.ts::fresh runtimes can open accounts, faucet, pay, and reload persisted state"]' \
  --shards=1 --workers-per-shard=1 --strict-browser-health \
  --video=retain-on-failure --trace=off --screenshot=only-on-failure --max-failures=1
```

Acceptance:

- Real visible BrainVault form creates/unlocks a wallet and survives reload.
- No `FINANCIAL-SAFETY VIOLATION`, `RUNTIME_INPUT_QUARANTINED`, nonce mismatch,
  hidden runtime error, blank action, or disabled Account button.
- Connect opens an Account, faucet credits it, Pay commits once, reload restores
  the same balances/receipts, and retry does not double-pay.
- F12: `0 errors / 0 warnings`. Do not downgrade real failures to silence them.
- The isolated runner must use its own ports, databases, Svelte build dirs, and
  Anvil processes. It must never attach to or kill the owner’s `bun run dev`.

After both single flows pass:

```bash
bun run test:e2e:functional
```

### P0.3 Prove HTLC secret privacy and liveness on current bytes

Write/retain RED regressions for:

- proposer encrypted envelope contains token/amount/deadlines and no plaintext;
- non-proposer validators cannot decrypt the final layer;
- proposal, committed frame, WAL, snapshot, debug JSON, and browser wire do not
  contain preimage before durable destination unlock;
- hash comparison uses the original committed hash before any state mutation;
- destination unlock and upstream secret propagation happen in the same Entity
  frame when no cross-Entity boundary exists;
- after durable unlock, board visibility cannot race ahead of commit;
- too little reveal time rejects the incoming success path but still propagates
  the known secret backward so upstream can protect itself;
- cross-chain/cross-Entity propagation is authenticated, exact-hash bound, durable,
  idempotent, and not reused for ordinary same-Entity payments;
- dispute can always resolve malformed optional transformer evidence; transformer
  failure cannot brick settlement.

Then run focused HTLC tests, payment L2, and a fresh independent read-only audit.

### P0.4 Prove every external action has exact board authority

- Any current board signer may submit an individual action from their own identity,
  such as chat/propose/vote.
- Collective payment/config/admin/rotation actions must use the existing
  `propose -> signed votes -> execute` flow and configured board threshold.
- Entity frame precommits are not governance votes.
- External J-batch, Account frame for another Entity, dispute/settlement, Entity
  transfer, and release-control action must carry exact domain-bound quorum Hanko
  over the precise hash each validator independently replayed.
- `validators[0]`/`members[0]` proposes by default. It never supplies other
  validators’ signatures or hashes.
- Duplicate/unknown signer, wrong signature order/index mapping, excessive shares,
  insufficient configured stake, wrong chain, wrong Depository, wrong Entity,
  wrong nonce, wrong action hash, and replay must fail closed.
- Threshold is board configuration. Do not globally rewrite `debtOutstanding` or
  invent a different integer/accounting system. Rotation shareholder-majority
  rules are a separate governance policy.

### P0.5 Run full correctness gates on one immutable candidate

Required order:

```bash
bun run check
bun run test:unit
bun run test:contracts:full
bun run security:audit-pack
bun run check:determinism
bun runtime/scenarios/determinism-test.ts
bun runtime/scenarios/run.ts --all
bun run test:e2e:release
bun run test:e2e:mm
bun run gate:mainnet
bun build runtime/runtime.ts --target=browser --external http --external https --external zlib --external fs --external path --external crypto --external stream --external buffer --external url --external net --external tls --external os --external util
```

Record exact pass counts and wall times. Any failure returns to L1/L2; do not loop
the whole L3 suite while one bug is still isolated.

## 3. P1: protocol and product requirements before 0.1.9

### P1.1 External audit handoff: re-audit the eight release-blocking invariants

The auditor must use current bytes and independently verify:

1. Every on-chain Hanko uses trusted `block.chainid + Depository address`; runtime
   gets domain only from trusted jurisdiction config, never peer/frame calldata.
2. Every validator independently replays multisig state, recomputes secondary
   hashes, and contributes only its own key to real configured quorum.
3. Entity-certified J anchor is authoritative; conflicting local hash is corruption
   and quarantines/fails loud without fallback to local history.
4. J overlaps implement stale no-op, exact duplicate no-op, matching prefix plus
   suffix, and conflicting-prefix rejection with zero mutation.
5. Consensus frames/certificates/Account ACK/J-finality use ordered reliable lanes
   keyed by `entityId + height + frameHash`; heights cannot collapse in dedup.
6. J-submit failed/terminal state is a replayable RuntimeTx; committed unsent work
   is due immediately after restore; backoff starts only after durable attempt.
7. History/current/meta/head publish atomically or with a proved recovery fence;
   real SIGKILL at each boundary restores exact canonical state.
8. Leader votes, certificates, pending rounds, consensus progress, J history, and
   pending submit state restore exactly or rebuild deterministically.

Required adversarial dimensions: two Anvil chains with identical contract
addresses, board rotation, proposer failover, validator catch-up, drop/reorder/
duplicate/restart, reorg before and after certified anchor, and different validator
watcher scan heights converging on the maximum common prefix.

### P1.2 Finish board/entity governance and its real wallet UX

Canonical decisions from the owner:

- Board format is weighted members plus configured threshold, conceptually
  `[[alice,1],[bob,2]], threshold=2`; `members[0]` is default proposer.
- A board member can be an EOA, lazy Entity ID, or registered Entity ID. Claims
  recursively expand authority and leaf signer stake. Every leaf signs/votes for
  itself; exact claims are passed with the Hanko.
- Recursive claims must terminate; cyclic authority is forbidden at verification.
  Do not require one canonical Hanko byte layout: different valid ordering/index
  layouts are acceptable if exact authority/digest verification succeeds. Reject
  duplicate stake, unused privilege, invalid branches, and cycles.
- A lazy Entity is permanent, not temporary: its ID is its immutable root-board
  hash and its root board cannot rotate. A registered Entity may rotate its board.
  There is no rotatable sub-ID primitive.
- One board hash may control unlimited registered Entity IDs but only its one lazy
  Entity ID.
- Multisig creation: creator imports only their own replica/key; other members join
  through an untrusted invitation, recompute board hash/Entity ID/jurisdiction, and
  approve with their own wallets. Never collect everyone’s private keys in one
  runtime.
- Registration is paid by the creator’s unlocked wallet without relayer/meta-tx in
  0.1.9. Register/approve the board participants before Entity registration.
- Add Playwright for single-signer, multisig lazy, and registered Entity creation,
  both with J-registration and without it. Test refresh/reload and independent
  runtimes/key stores.

### P1.3 Board rotation, grace, and shareholder petitions

- Registered Entity can replace its board after the required control/governance
  majority. Lazy Entity cannot rotate its root board.
- Previous board remains valid for seven days and can create valid Hanko during the
  grace period. After expiry, its signatures are invalid.
- Accounts must reseal to the new board during grace or exit/settle/dispute. New
  board may reseal only the already pinned settlement/dispute hashes without
  changing nonce/ops or requiring a second governance vote.
- Dispute-proof nonce changes only when dispute-relevant ProofBody changes: off
  delta or subcontract body add/resolve. Credit-limit-only changes do not bump it.
- `jNonce` advances only after J-finalized settlement/dispute. Replica mismatch has
  no ±1 tolerance: fail closed and catch up.
- Dividend holders may publish a petition but must collect real majority votes.
  Precedence: control majority highest; current board may override dividend;
  dividend is lower; optional foundation rescue is last resort.
- Public relay stores only active petitions, compact terminal hashes, and at most
  100 discussion messages per Entity. It never becomes consensus authority.
- Cover proposal, votes, cancellation using the same nonce, execution, grace,
  expiry, account reseal, dispute liveness, dust-holder rejection, and restart.

### P1.4 Dispute and token arithmetic invariants

- Keep existing `uint256 debtOutstanding`; do not replace it with a new signed or
  custom accumulator type.
- Reject/avoid a malicious token whose supply/balances exceed supported integer
  bounds. Do not store a duplicate supply cap in Depository; query the ERC token.
- If finalization can repay only 40 of a promised larger debt, finalization still
  resolves and clamps the decrease to available 40. Do not brick dispute because
  optional transformer data is absurd or over allowance/hold.
- Transformer arguments are adversarial optional evidence: malformed/out-of-gas
  soft-fails to empty/no-op while signed ProofBody, hashes, nonce, and Account state
  remain fail-fast.
- A `FatalTokenError` event/quarantine policy is deferred; do not spend release
  time on it unless a real gate exposes the need.
- Token identity stays compact `tokenId` in Depository. Transformer can query the
  Depository for ERC-20 address. Do not carry redundant address or chain ID inside
  every asset value; jurisdiction already supplies chain context.

### P1.5 Consumption/output frontier and persistence bounds

- Entity state must not grow per consumed output. Keep a compact Merkle accumulator
  `{root,count}` plus bounded per-source frontier/sequence semantics.
- Target validator independently verifies exact output proof before apply. Same
  sequence/different semantic hash quarantines that source relationship and keeps
  both signed outputs as evidence; it must not halt unrelated Entity lanes.
- Immutable CAS nodes publish atomically with the Entity frame; snapshot contains
  every reachable node; restore validates root/count and missing/corrupt nodes fail
  loud.
- Test insert, exact retry, equivocation, invalid proof, independent validators,
  crash before/after CAS publish, snapshot/restore/continued insert, and one million
  outputs without linear EntityState growth.
- User Entity size near 1 GiB is a warning, not a hard consensus cap. Hub operators
  may configure much larger storage. Protocol collections still require explicit
  bounded semantics.

### P1.6 Persistent UI command intent

- `commandId` belongs to the user intent and exists before first send.
- Persist unresolved exact payload/hash/runtime association/status in encrypted
  wallet/vault-derived IndexedDB, never plaintext localStorage.
- Reload/reconnect retries the same intent with the same ID. Two intentionally
  identical payments get different IDs. Same ID with different payload rejects.
- After observed success or terminal rejection, remove the journal record.
- Same-vault runtime association is sufficient for mainnet. Capability-only remote
  admin does not need durable automatic payment retry.
- Retry that can spend waits for wallet unlock.
- Existing rAdapter server dedup/frontier tests are green; missing proof is a real
  visible browser timeout/reload/retry E2E.

### P1.7 Profile recertification

- Do not dedupe only on encryption-manifest hash.
- A complete manifest must call the canonical local profile certification helper,
  which validates profile hash, Hanko, and pending certification.
- Same manifest plus changed profile must generate a new certification.
- P2P and core lifecycle must share one predicate. Cover reload/reconnect.

### P1.8 `bun run dev` must be boring

- Start in stages: Anvil 1/2 bind and answer correct chain IDs, contracts exist,
  then MESH/watchtower/runtime/Vite.
- A child exit must report the root log and shut down only owned children. Never
  kill unrelated owner/E2E processes.
- Resolve stale Anvil state/port collision by owner-scoped run directories and
  explicit readiness, not sleeps or blanket `pkill`.
- Run an actual clean `bun run dev`, open `https://localhost:8080/app`, create a
  wallet, open Account, pay, reload, inspect F12, then terminate cleanly.
- Remove root-cause Vite `writeAfterFIN` on Playwright WebSocket closure.
- Reclassify only truly expected `ROUTE_DEFERRED_NO_P2P` and insufficient-capacity
  messages; do not suppress unexpected warnings/errors.

## 4. P2: medium priority after P0/P1 are stable

### P2.1 Wallet/QA UX polish already present but not visually accepted

- Keep the xln mascot hidden by default for `0.1.9`. Preserve its implementation
  and tests; resume opt-in mascot visual acceptance only after the release.
- Keep Runtime/Entity heights, timestamps, board, votes, hooks, proposals, and
  consensus diagnostics under Settings -> Consensus. Do not show a floating
  “Committed/Accepted H###” badge over normal wallet pages.
- Restore every useful prior setting, including time machine/history inspection.
- Show installed Entity hooks/extensions read-only in Settings.
- Desktop/wide layout may use one hierarchical left sidebar; mobile uses compact
  tabs/bottom navigation from the same route/state model. Avoid two separate apps.
- QA home must show a small sortable table with short name, functional/resilience
  category, green/fail status, and duration. Category metadata is already complete;
  verify laptop, iPhone, and Mac Studio screenshots.
- Run screenshot-driven E2E at mobile, laptop, and wide desktop. Score and fix every
  visible overlap, missing control, inaccessible label, or stale badge.

### P2.2 Canonical hash audit cadence

- Recheck whether `canonicalHashPeriodFrames=0` can still disable the independent
  restore oracle in production. Production default must verify every frame.
- If zero remains useful for tests/dev, reject it in production rather than adding
  another complex cadence mode.

### P2.3 J-submit error classification

- `runtime/jurisdiction/j-submit.ts` previously matched transient errors using
  message substrings such as `503`, `504`, timeout, and rate-limit.
- Recheck current code. Use structured HTTP/RPC error codes/status only. Unknown
  contract revert is terminal; do not retry forever because its text contains a
  number.

### P2.4 Watcher completeness dependency

- Watcher is an internal runtime module that reads J-chain events. It does not
  exchange Entity frames.
- Re-audit receipt-root/log completeness when bloom says “maybe present”. Shared
  lossy RPC must not let quorum watchers silently co-omit a real event.
- Preserve fail-closed multi-J selection by chain ID plus Depository. Legacy address
  fallback is allowed only for exactly one match.

### P2.5 Modular extensions, no naming refactor during stabilization

- Orderbook, lock/HTLC book, and lending book are Entity-level extensions that may
  extend both EntityTx and AccountTx through the layered REA API. They do not live
  under `account/` as Account-owned state.
- Keep current names until release gates are green. Afterwards split modules into
  clear extension folders without changing protocol bytes.

### P2.6 Counterfactual/custom transformer wallet integration

- Start only after old release blockers and best-case E2E are green.
- Use the current stable Solidity compiler/toolchain.
- Reusable deployed transformer code plus per-use encoded arguments is preferred;
  avoid deploying a full contract for every clause.
- UI reads a safe comment-like DSL/ABI metadata from transformer source and renders
  typed HTML inputs plus decoded `encodedBatch` preview.
- Support both predeployed and deploy-once flows without mocks. Keep contract byte
  code/gas small and preserve dispute liveness under malformed args.
- Add real wallet Playwright for custom transformer creation, argument encoding,
  Account use, dispute, reload, and F12 0/0.

## 5. P3: cleanup after release, in separate commits

- Move tracked Markdown out of `frontend` into `docs` without breaking routes or
  docs catalog generation.
- Update module/auditor map and stale runtime documentation paths.
- Evaluate foundation admin UI for real jurisdiction-stack deployment. Do not
  expand foundation rescue before 0.1.9.
- Prune only display/local watcher history that is safely finalized. Preserve the
  minimal certified roots/metadata required to prove anchors and restore.
- Memoize or index only after measuring a real hot path. Prefer fewer lines and
  simpler primitives.
- Keep functions under roughly 30 lines and files under roughly 300 lines when
  touching them; do not churn large legacy files merely to satisfy aesthetics.

## 6. Release `0.1.9` procedure after all gates and fresh audit pass

1. Make the worktree clean through reviewed logical commits and push `main`.
2. Bump the one canonical version source.
3. Generate release Markdown and JSON using existing tooling:

```bash
bun run release:snapshot
```

4. Verify release page visually at `/releases` on mobile/laptop/wide desktop.
5. Run:

```bash
bun run test:release-integrity
bun run foundation-release:verify
bun run foundation-release:publish-check
```

6. Never run `frozen-core:approve` and do not refreeze core. The owner intentionally
   left the manifest empty until external audit.
7. Deploy code-only with the existing command:

```bash
bun run deploy:prod
```

8. Verify `https://xln.finance` health, wallet creation, console 0/0, remote runtime
   import, and production canary.
9. Run:

```bash
bun run test:e2e:prod:payment
```

10. Verify Foundry data is below 10 GiB and project test artifacts below 50 GiB.
11. Create GitHub release `v0.1.9` only after production canary succeeds.
12. Record exact commands, pass counts, wall times, commit SHA, production URL,
    GitHub release URL, and honest residual risks.

## 7. Known test/output caveats

- Expected `[ERROR]` lines appear in negative storage tests that assert fail-closed
  behavior. Judge exit code and assertion name, not log color alone.
- `test:e2e:fast` can miss visible wallet creation because a helper may call hidden
  `window.__xln.vault.createRuntime`. Keep the visible BrainVault spec in the
  functional/release bar.
- Only isolated runner plus `--strict-browser-health` proves browser console
  `0 errors / 0 warnings` without touching the owner stack.
- Do not run direct `bunx playwright` against default ports while owner `bun run dev`
  is active; root config may reuse `:8080` and frontend config may proxy `:8082`.
- Static grep is not proof. Trace entrypoint -> validation -> mutation -> atomic
  persistence -> close/reopen -> canonical hash.
- Golden vectors must use independently pinned bytes/hashes. Solidity and TS
  expected values calling the same helper are not independent evidence.

## 8. Last known green evidence (stale after current HTLC edits)

```text
HTLC focused                         44 pass / 0 fail / 411 assertions
J focused                           117 pass / 0 fail / 551 assertions
startup/rAdapter targeted           149 pass / 0 fail / 1,828 assertions
startup failure child               1 pass / 0 fail / 3 assertions
real Anvil J backlog                1 pass / 0 fail / 17 assertions
compact codec/storage               16 pass / 0 fail / 58 assertions
bounded + bulk storage              5 pass / 0 fail / 34 assertions
storage + real SIGKILL recovery     48 pass / 0 fail / 746 assertions
runtime TypeScript                  PASS on the earlier storage snapshot
full bun run check                  PASS on the earlier snapshot; PENDING now
full unit                           PENDING on current snapshot
functional browser E2E              PENDING on current snapshot
release/MM E2E                      PENDING on current snapshot
security pack                       PENDING on current snapshot
contracts full                      PENDING on current snapshot
determinism/scenarios               PENDING on current snapshot
production deploy/canary            NOT STARTED; correctly blocked
```

## 9. First commands for the next agent

```bash
cd /Users/zigota/xln
sed -n '1,260p' AGENTS.md
git rev-parse HEAD
git status --short
git status --porcelain=v1 | shasum -a 256
git ls-files --others --exclude-standard -z | shasum -a 256
shasum -a 256 runtime/entity/consensus/output-certification.ts runtime/entity/consensus/index.ts runtime/entity/htlc-onion-post-commit.ts runtime/protocol/htlc/onion-advance.ts runtime/__tests__/multisig-htlc-validator-encryption.test.ts
```

Freeze those bytes. Start at P0.2/P0.3: add one narrow forwarded-route RED proving
the fee-adjusted incoming/outgoing amount semantics, fix only that invariant, and
run `multisig-htlc-validator-encryption.test.ts`. Then run the exact isolated
payment Playwright command from P0.2. Do not run broad gates or expand scope until
the real wallet can create, open an Account, pay once, reload, and show F12 `0/0`.

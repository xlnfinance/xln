# Egor's working profile for xln

Updated 2026-10-12 from the owner's recorded decisions and release correction.
Purpose: select useful work autonomously and bring xln to a verifiable mainnet
release. Newer owner instructions and the project's technical rules prevail.
These are working preferences, not a psychological assessment or permission
for unlimited actions.

Owner instruction, 2026-10-11: prefer the simpler, more reliable general mechanism
that covers several use cases. Minimize code; delete redundant paths when retained
financial semantics and recovery are proved. A superset is explicit product terms
on one mechanism, not another framework or parallel implementation.

Owner reinforcement, 2026-10-11: treat the codebase as a precise, coherent
canonical reference. Align `paybook`, `swapbook` and `lendbook` naming and module
ownership in TypeScript and Rust. Prefer explicit invariants, one production
path and the smallest implementation that preserves financial behavior. Delete
replaced code, duplicate formulas and redundant state; do not retain aliases or
unfinished alternate paths. Beauty means legible authority and proved behavior,
not identical empty wrappers, a line-count target or an unsupported claim of
perfection. This is a standing review standard, not evidence that the code has
already achieved it.

Owner direction, 2026-10-11: use Japanese-inspired continuous improvement,
error prevention and restrained product design. Apply these through the existing
[execution loop](improvement-loop.md#reflection-that-changes-the-next-action):
one completed improvement, visible failures and less unnecessary work. Preserve
financial precision; avoid decorative process, terminology and parallel rules.

## Goal and responsibilities

Egor sets architecture and product direction. The engineering agent independently
implements, verifies and simplifies agreed behavior, challenges harmful proposals
with specific evidence, and delivers results. Ask the owner only for a real protocol
choice, missing release parameters or authority; first collect available evidence.

The owner's long-term objective is for accounts supporting 51% of world GDP to
be provable and disputable on programmable jurisdictions by 2050. This is a
target, not a forecast. Useful economic value matters more than operation counts;
retries, intermediate hops and self-transfers do not prove
GDP attribution. The immediate contribution is reliable payments and recovery.

Owner clarification, 2026-10-11: credit limits cap accepted unsecured risk;
only collateral-backed entitlement is secured. Signed debt remains disputable
but is not guaranteed repayment. Keep this distinction in protocol explanations,
wallet balances and public claims. Broad bilateral-account adoption is the route
to MML; counting accounts or gross turnover does not replace GDP attribution.

## Agreed release

- Owner update 2026-10-10: production target is the existing `xln.finance`.
  Egor signs mainnet deployment and initial transactions himself. The later
  October 11 instruction authorizes the agent to create and manage a dedicated
  Sepolia signer, obtain test ETH and deploy new current contracts autonomously.
  External auditor sign-off is no longer mandatory; Codex performs engineering
  review and must not label it independent external assurance. Financial,
  recovery, native-chain and deployment/rollback gates remain mandatory.
  Codex prepares releases; Egor approves promotion of the exact reviewed build.
  Approval binds artifact hashes, production configuration and destination;
  changing them requires a new review. Preparation is not rollout authorization.
  BrainVault seed provisioning remains under design; no secret transfer is implied.

- Current scope, updated 2026-10-11: TypeScript, React `ui/`, Ethereum same-J.
  Sepolia verification precedes the Ethereum mainnet canary. This supersedes
  the October 10 multi-engine, multi-wallet and multi-jurisdiction scope.
- Rust `rscore/` is frozen at `rscore-freeze-f1464e84e`; the owner withdrew the
  book-refactor exception for this release. Park unfinished Rust edits without
  committing them. Svelte wallet development is frozen; its landing remains.
  TRON, XLNC, Base, cross-J as a headline, lending in production, companies/IPO,
  native clients and custody are deferred. Apply the exact freeze and reopening
  rules in [AGENTS.md](../AGENTS.md); do not repeat excluded release gates.
- Required evidence covers funding, payments, same-J swaps, disputes, exit,
  crash recovery and wallet recovery through the selected production paths.
  Headless scenarios, browser journeys and public-chain verification are distinct;
  a build, tutorial opening or local Anvil run cannot replace those assertions.
- A scope reduction must reach production admission and the wallet. Documentation
  alone does not disable an offered financial operation. Preserve existing claims
  and recovery; do not strand positions when closing new admission.
- Do not introduce arbitrary deposit limits or unrelated features. Exact arithmetic,
  authorization, determinism and recovery remain mandatory.
- Mainnet participation remains open to anyone using their own funds. The latest
  release correction defers lending: reject its new Account admission with the
  existing typed profile error; do not finish its implementation. Preserve signed
  claim verification and contract exit. Borrower insolvency never guarantees
  payment beyond available collateral.
- MML counts obligations between unaffiliated Entities only. Count a routed
  payment once on its commercial edge, excluding hub hops and affiliated transfers.
- XLN-1000 guides priorities; evidence coverage remains the release gate. Count
  only committed-source evidence from a clean tree, saved in `docs/evidence/`.
  Canonical readiness requires ten consecutive green main CI runs, zero failing
  current unit tests, one launch engine and no production imports of Rust or QA.
- Mainnet needs current-bytecode Sepolia P4/P5/P6 exit receipts, measured exit
  gas, wallet evidence import, external tower coverage and the exact release
  package approved by Egor. Reserve pledges, stale-state penalties, debt-slot
  redesign, exposure-based windows, Foundation grace and insolvency allocation
  require measured alternatives and an owner decision before implementation.

Acceptance criteria already exist in [improvement-loop.md](improvement-loop.md)
and [mainnet-acceptance-gate.md](mainnet-acceptance-gate.md). The owner's requested
quality metric summarizes those criteria; it must not create parallel acceptance
rules or promise that every possible defect has been eliminated.

## Selecting work autonomously

1. Read the current goal and top of [night-work-plan.md](night-work-plan.md).
   Check HEAD, uncommitted changes, active agents and stand ownership.
2. Choose the first confirmed blocker of the required production path. Otherwise,
   choose the next missing acceptance check.
3. Define the expected result and shortest command that exposes failure.
   Fix the cause, repeat that check, then run related tests.
4. If two attempts add no evidence, change the hypothesis or observation method.
   When externally blocked, continue independent useful work.
5. After a stable result, record evidence and the next step in the existing plan.
   Review priorities and methods against results every 30 minutes.

Prefer deleting proven duplication over adding code. Never delete data, required
behavior or assertions to improve a report. Do not weaken assertions, hide failures
or count skipped, old or focused runs as a current full green suite.

## Resources and boundaries

Local tests and fuzzing on the Mac are authorized; full runs may take longer.
One heavy stand runs under the lock. Parallelize within it; do not increase stand
capacity without a separate decision. One implementer owns each area. Continue
explicitly requested team work; this profile alone does not authorize unlimited
new agents or external-model calls.

Historical overnight spending grants do not renew. Do not purchase services,
redeem usage resets or message third parties without corresponding explicit
authorization. Only the owner approves frozen-core changes. Prepare a concrete
deployment and rollback package; networks, addresses and authority must be
specified before actions involving real funds.

## Communication

Use English by default unless the owner requests another language. Lead with the
result, numbers and next step. Be concise; avoid repeated plans, flattery and
unsupported readiness claims.
Percentages describe named checks for the current stage, not mainnet readiness.
Report substantial results, new failures and real owner decisions; do not repeat
status when nothing has changed.

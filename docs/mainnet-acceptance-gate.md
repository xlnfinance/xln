# xln mainnet acceptance gate

**[Index](readme.md)** | **[Mainnet Bar](mainnet.md)** | **[Ops Runbook](deployment/ops-runbook.md)**

This document is the strict release gate for the next public xln launch loop.
Scope follows [AGENTS.md](../AGENTS.md) RELEASE SCOPE (owner decision 2026-10-18):
Pay, same-J Swap, Cross-swap and Lending on EVM and native TRON, served by the React
wallet. Participation is open to everyone spending their own funds; there is no
protocol funding ceiling. Testnet evidence precedes and never authorizes mainnet.
Financial, signer-authority and recovery gates remain mandatory. Existing
`capped-testnet` command names identify the operator gate; they no longer promise or
require a monetary cap.

External audit sign-off is optional (owner 2026-10-10); every bug and fix is confirmed
by at least three different AIs per AGENTS.md, without claiming independent external
assurance. No wording in this document downgrades the real-funds bar in
[mainnet.md](mainnet.md).

## Decision Snapshot

| Item | Decision |
|------|----------|
| Launch scope | Pay, same-J Swap, Cross-swap, Lending; EVM and native TRON; React wallet |
| Value cap | None at protocol level; each creditor accepts its own bilateral risk |
| Soak duration | 1 hour uninterrupted on the release candidate |
| External audit | Optional; engineering/security gates and >=3-AI bug confirmation remain required |
| Topology | One official tower and three hubs |
| Exception rule | P0/P1 never ship; P2 only with explicit owner sign-off; P3 with an issue |
| Recovery SLA | Restore path completes in less than 60 seconds after seed entry or local backup upload |

Executable policy file: [../ops/capped-testnet-policy.json](../ops/capped-testnet-policy.json).

Soak means a long-running release candidate run under realistic load and
restarts. It is meant to catch memory leaks, timing drift, flaky persistence,
RPC instability, reconnect bugs, tower upload gaps, and health-monitoring lies.
Any crash, manual repair, data loss, unexplained console error, or failed gate
restarts the 1-hour clock.

## Mechanism

The mechanism is a loop, not a one-time checklist:

1. Freeze one exact release-candidate commit.
2. Run gates. A gate is a binary barrier with required evidence: if any required
   check fails or evidence is missing, the release cannot move forward.
3. Fix the first real blocker with L1/L2/L3 verification.
4. Commit the fix, freeze a new release candidate, and restart the gates.
5. After all gates pass, run the 1-hour soak on the same candidate.
6. If soak fails, treat it as a real blocker and restart the loop after the fix.
7. Only after green gates plus green soak, run the one-tower / three-hub canary.

In this model, a gate answers "is this candidate allowed to advance to the next
stage?" Soak answers "does this candidate stay healthy when it runs long enough
for slow bugs to appear?"

Concrete examples:

- `bun run check` is a source gate: types, invariants, frontend build, and
  static project rules must pass.
- `bun run gate:release` is an integrated release gate: runtime tests,
  contracts, RPC settlement, persistence, watchtower smoke, fast e2e, system
  tests, deterministic replay, and the storage benchmark.
- `bun run gate:mainnet-preflight` is the operator-facing preflight: it runs
  source checks, deterministic money invariants, security audit pack, release
  gate, full browser e2e, watchtower smoke, and capped topology health.
- `bun run gate:capped-testnet:preflight` is the capped launch preflight: it
  validates policy, dirty-worktree status, release evidence, full e2e,
  watchtower smoke, and one-tower / three-hub health without the 1-hour soak.
- `bun run gate:capped-testnet` is the full capped launch gate, including soak.
- Browser/F12 drill is a product gate: the actual app must work without uncaught
  console errors in the flows users touch.
- `bun run soak:capped-testnet` is the 1-hour capped soak: repeated
  release-profile checks without manual repair.

## xln Mental Model For The Gatekeeper

- xln is a bilateral finance system, not a broadcast ledger clone. The core
  invariant lives across core/entity/account/jurisdiction machines.
- RJEA logic must be deterministic: same previous env plus same inputs produces
  the same next env. Active infra, wall-clock time, random bytes, timers, and
  network side effects do not belong inside the state machine.
- The tower is a service surface, not a runtime actor. It may provide encrypted
  backup and last-resort dispute protection from one daemon, but those two
  services must stay independently configurable and testable.
- Recovery starts when a seed exists. The client queries all configured towers,
  decrypts candidates locally, presents the highest runtime-height versions,
  allows local encrypted backup upload, and creates a new wallet only after the
  user explicitly chooses that path.
- Open participation still means money-moving code. Fail closed. No silent
  fallback, no mocks in evidence, no swallowed errors.

## Strict Acceptance Prompt

Use this prompt for every release-candidate review:

```text
You are the xln capped-testnet release gatekeeper.

Your job is to decide whether this exact commit may launch within the current
AGENTS.md scope, with one official tower, three hubs and open participation.
There is no global monetary ceiling. Credit limits bound accepted unsecured risk;
only collateral secures recovery.

Output only one of:
- CAPPED_TESTNET_PASS
- CAPPED_TESTNET_FAIL

Default to FAIL unless every required evidence item is attached and current.
Do not accept "probably", screenshots without logs, local mocks, skipped tests,
manual database repair, hidden fallback to fresh wallet creation, or unactioned
P0/P1 blockers.

Understand xln before judging it:
- Runtime/Entity/Account/Jurisdiction transitions must be deterministic.
- Bilateral account proofs, nonces, balances, and dispute bodies are the safety
  boundary.
- Tower backup and tower last-resort dispute protection are separate services
  even if served by the same daemon.
- The tower must not read backup contents before a breach/reveal path.
- The client must never silently replace failed recovery with new-wallet
  creation.
- BrowserVM success alone is not release evidence.

Required scope:
- landing and onboarding
- seed entry / brainwallet derivation / explicit recovery choice
- encrypted runtime backup and local encrypted backup import
- last-resort dispute protection
- direct payments
- same-account swaps
- cross-j swaps
- lending (bank/facility/term-loan/savings through canonical production admission)
- every flow above on EVM and on native TRON (TVM); two EVM simulators do not count
- persistence/WAL restore
- contracts and RPC settlement
- relay/P2P/hub topology
- production health, metrics, rollback, and secrets posture

Required evidence:
1. Exact git commit hash and dirty-worktree status.
2. `bun run check` output.
3. `bun run security:audit-pack` output.
4. `bun run gate:release` output.
5. `bun run test:e2e:full` output.
6. `bun run test:watchtower:smoke` output.
7. 1-hour soak output from
   `bun core/scripts/release/run-soak-gate.ts --profile=release --minutes=60`.
8. Production-health output proving one tower and three hubs are healthy.
9. Browser/F12 console evidence for landing, bootstrap, recovery, payment,
   swap, cross-swap, lending, dispute, and reload flows with zero uncaught errors.
10. Rollback drill evidence from the same deployment topology.

Hard FAIL if any of these are true:
- RJEA nondeterminism is observed or suspected.
- A state-machine path uses active infra, wall-clock time, random bytes, or
  timer side effects.
- Recovery fails and the UI silently creates or opens a fresh wallet.
- Tower backup can be read before user-side decrypt or breach/reveal.
- Last-resort disputer can act early, act on same-proof evidence, or act without
  a newer valid proof.
- Any P0/P1 bug exists without a merged fix and passing regression test.
- Any money-moving flow requires a manual database edit, browser reset, or
  operator-only ritual.
- Health does not prove exactly the intended one-tower / three-hub topology.
- Secrets, RPC endpoints, gas funding, or rollback are implicit.
- Bilateral exposure limits, financial correctness or recovery lack executable evidence.

Report format:
- Verdict: CAPPED_TESTNET_PASS or CAPPED_TESTNET_FAIL
- Commit:
- Scope:
- Topology:
- Evidence table:
- Blockers by severity:
- Residual risks:
- Next loop:
```

## Acceptance Matrix

| Area | Pass condition | Evidence |
|------|----------------|----------|
| Determinism | RJEA remains pure and reproducible | `bun run check:src`, release gate, soundcheck evidence |
| Contracts | Depository, nonce, replay, settlement, and dispute paths are green | `bun run test:contracts:full`, `bun run test:rpc-settlement` |
| Bilateral consensus | Account proofs bind state, nonces, balances, and dispute bodies | unit tests plus targeted e2e dispute/payment flows |
| Persistence | WAL/snapshot restore survives restart and crash drills | `bun run test:persistence:cli`, release soak |
| Recovery | Seed immediately discovers tower backups, shows versions, and never silently creates fresh state | watchtower recovery e2e plus browser console evidence |
| Tower backup | Tower stores encrypted bytes and lookup metadata only | `bun run test:watchtower:smoke`, tower recovery e2e |
| Last-resort dispute | Tower acts only after valid breach condition and only with newer proof | watchtower dispute unit/e2e coverage |
| Payments | Direct payment survives reload, recovery, and hub reconnect | e2e full and browser drill |
| Swaps | Same-account and cross-j swaps settle or fail loudly | e2e full, flow coverage, cross-j tests |
| Lending | Funding, draw, repayment, maturity/default and savings close settle exactly and survive crash recovery | lending financial scenarios, `tests/e2e/product/e2e-lending.spec.ts` |
| Native TRON | Pay, Swap, Cross-swap and Lending pass on genuine TVM/native RPC with finality | native TRON stand evidence |
| Landing | Landing does not bypass security, recovery, or onboarding warnings | browser drill and console evidence |
| Topology | One tower and three hubs are healthy from the production endpoint | `bun run prod:health` plus deployment health payload |
| Ops | Rollback, secrets, RPCs, gas funding, and alerts are explicit | ops runbook drill evidence |

## Release Loop

1. Freeze a release candidate commit.
   - Record commit hash and `git status --short`.
   - No code changes during evidence collection.
   - If any fix lands, restart the loop from step 1.

2. Run the fast gate.
   - `bun run check`
   - `bun run security:audit-pack`
   - `bun run gate:release`

3. Run the complete user-flow gate.
   - `bun run test:e2e:full`
   - `bun run test:watchtower:smoke`
   - Browser/F12 console drill on landing, bootstrap, recovery, payment, swap,
     dispute, reload, and local backup import.

4. Run the 1-hour soak.
   - `bun run soak:release` remains the longer release soak script.
   - The capped-testnet gate command is the one-hour soak:

     ```bash
     bun run soak:capped-testnet
     ```

   - No manual repair is allowed during soak.
   - Any failure restarts the 1-hour clock after the root-cause fix.

5. Run the capped topology canary.
   - Deploy one official tower and three hubs.
   - Confirm the landing and app use this topology.
   - Confirm health, tower receipts, hub mesh, RPC settlement, and rollback.

6. Classify every issue.
   - P0: loss of funds, silent wrong state, deterministic divergence,
     unauthorized dispute, plaintext backup exposure.
   - P1: recovery cannot complete, payment/swap/cross-swap/lending broken on EVM
     or TRON, health/rollback blind spot.
   - P2: degraded UX or operator friction that does not threaten funds.
   - P3: polish only.

7. Fix one blocker at a time.
   - L1: smallest unit/spec around the failure.
   - L2: targeted integration or e2e for the broken path.
   - L3: broad gate only after L1 and L2 are green.
   - Commit each verified fix separately.

8. Decide.
   - PASS requires zero P0/P1, signed-off P2 list, green evidence, and complete
     1-hour soak.
   - FAIL produces the next loop's first blocker and exact repro command.

## Launch Sign-Off

The launch owner must paste this block into the release issue:

```text
Verdict:
Commit:
Dirty worktree:
Scope: Pay, same-J Swap, Cross-swap, Lending on EVM and native TRON + landing
Topology: one tower, three hubs
1h soak artifact:
Gate artifacts:
Browser/F12 artifact:
Rollback artifact:
Open P2/P3:
Explicit exceptions:
Next rollback command:
```

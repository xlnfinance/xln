# C4 audit — independent re-run / reproduction angle

- Date: 2026-08-26
- Auditor angle: independent RE-RUN and VERIFY of `proofs/solidity/report.md` (C4 row of `proofs/readme.md`)
- HEAD at audit: `b95e7ee3b6345a296535aeb6a5d375efc1a27c88` (same as report's final-run SHA)
- Environment verified: forge 1.7.1 (`4072e487`), halmos 0.3.3, `jurisdictions/out -> forge-out` symlink present
- Scope discipline: read-only for contracts + wave-1 artifacts; writes only in this directory

## Verdict summary

**C4 evidence reproduces.** Full suite 75 passed / 2 failed with byte-identical failure
messages; new suites 9+7+7+7+5 all green; both failures deterministic in `--match-contract`
isolation; halmos 5/5 PASS. Frozen core clean. Both failures pre-exist C4 (files last
touched 2026-08-09, zero contract commits between pinned SHA and HEAD). One finding of the
report (DebtChunking residual 200) is re-characterized by this audit: books are exact, the
residual is deliberate O(1) single-entry forgiveness vs a full-drain test expectation —
not bookkeeping corruption, not division dust.

## Findings + severity

| # | Severity | Finding |
|---|---|---|
| F1 | Info (confirm) | All headline claims reproduce exactly (table below). No false claims found in the report. |
| F2 | Medium, pre-existing | `BatchBounds.t.sol:147` — worst-case R2C batch (4×64 distinct-cold-counterparty pairs) costs 15,049,243 gas ≥ 15M liveness budget documented at `Depository.sol:95-98`. Real liveness-budget breach, deterministic. Owner must raise budget or lower aggregate cap (256 pairs is legal per passing cap tests). |
| F3 | Low–Medium, pre-existing | `DebtChunking.t.sol:213` residual 200: NOT integer-division dust and NOT bookkeeping corruption — `_assertBooksAgree` (line 212) passes; residual is exactly 2 intact FIFO debts (2×100) because `_forgiveDebtsBetweenEntities` (`Depository.sol:833-858`) deliberately forgives only the single cursor-head debt per settlement (O(1), comment at 842-844). Test expects full 3-debt drain from one settlement. See 5-line analysis below. Residual signer-semantics concern: `forgiveDebtsInTokenIds=[T]` reads as "forgive all T debts" but forgives one queue entry. |
| F4 | Low, process | No C4 commit exists. All C4 artifacts are untracked working-tree files (10 test files + `proofs/solidity/`). The audit task's `git show --stat` check is impossible as specified; verified equivalently via `git status` (untracked set = exactly the 10 files + `out` symlink). Risk: `git clean -fd` erases the entire C4 evidence; no immutable SHA covers it. |
| F5 | Low | Halmos path counts not exactly stable across rebuilds: `clampExact` 982 vs reported 953 (+3%), `allowanceGate` 96 vs 95; other 3 lemmas exact (4/17/2). PASS/FAIL and magnitudes stable. Likely bytecode metadata-hash rebuild or solver nondeterminism; report presents counts as exact with no stability note. |
| F6 | Info | 92 tracked files modified under `jurisdictions/typechain-types/` + `jurisdictions/artifacts/` — regeneration side-effect of compiling frozen contracts. Not contract source; report does not mention this working-tree side-effect. |
| F7 | Info | Working tree now 419 dirty entries (report recorded 411) — parallel-task churn, not C4. C4 footprint within it is exactly the 10 untracked test files + symlink. |

## Reproduction table (command → expected vs actual)

| Command (in `jurisdictions/`) | Expected (report) | Actual (this audit) | Match |
|---|---|---|---|
| `forge test --match-path 'test/foundry/*'` | 75 passed / 2 failed | 75 passed / 2 failed; failures: `test_gas_maxReserveToCollateralProduct` (gas 15049243 ≥ 15000000), `test_forgivenessAfterPartialEnforcementKeepsBooksExact` ("200 != 0") | YES (byte-identical messages) |
| `forge test --match-path 'test/foundry/DepositoryConservation.invariants.t.sol'` | 9 pass | 9 passed; 0 failed | YES |
| `forge test --match-path 'test/foundry/TransformerAllowance.invariants.t.sol'` | 7 pass | 7 passed; 0 failed | YES |
| `forge test --match-path 'test/foundry/HankoThreshold.invariants.t.sol'` | 7 pass | 7 passed; 0 failed | YES |
| `forge test --match-path 'test/foundry/HashLadder.invariants.t.sol'` | 7 pass | 7 passed; 0 failed | YES |
| `forge test --match-path 'test/foundry/HalmosLemmas.t.sol'` | 5 pass | 5 passed; 0 failed | YES |
| `forge test --match-contract BatchBoundsTest` (isolation) | fails without new files | 11 passed / 1 failed — same gas failure, deterministic | YES |
| `forge test --match-contract DebtChunkingTest` (isolation) | fails without new files | 3 passed / 1 failed — same "200 != 0", deterministic | YES |
| `halmos --match-test 'allowanceGate' --loop 20 --solver-timeout-assertion 120s` | PASS, 95 paths | PASS, 96 paths, 0.76s | PASS yes / paths ±1 |
| `halmos --match-test 'clampExact' ...` | PASS, 953 paths | PASS, 982 paths, 11.45s | PASS yes / paths +3% |
| `halmos --match-test 'orderedPairIsolation' ...` | PASS, 4 paths | PASS, 4 paths | YES exact |
| `halmos --match-test 'rootRoundTrip' ...` | PASS, 17 paths | PASS, 17 paths | YES exact |
| `halmos --match-test 'nibbleReconstruct' ...` | PASS, 2 paths | PASS, 2 paths | YES exact |
| `git status --porcelain -- jurisdictions/contracts/` | empty | empty (0 lines) | YES |
| C4 commit `git show --stat` | diff only test/+proofs/ | **No C4 commit exists** — artifacts untracked; `git status` shows exactly the 10 test files + `out` symlink + regenerated typechain/artifacts | GAP (F4) |
| `git log` BatchBounds.t.sol / DebtChunking.t.sol | predate C4, unmodified | both last modified `c86d2fca9` (2026-08-09); clean in status; zero commits `80924b035..HEAD` touch `jurisdictions/contracts/` | YES |

Pre-existing-on-baseline (pinned SHA `80924b035`) is transitively verified: both test
files unmodified since 2026-08-09 and no contract commit between `80924b035` and `b95e7ee3b`,
so the same bytecode + same tests necessarily produce the same two failures. Direct run at
the pinned SHA was not possible without `git stash` (forbidden by task rules).

## DebtChunking residual 200 — technical explanation (owner triage input)

1. Setup: 35 debts × 100 = 3500 outstanding (`DebtChunking.t.sol:185-187`), then
   `enforceDebts(debtor, T, 32)` pays exactly 32 full debts FIFO — cursor stops at 32,
   3 live entries remain at queue indices 32–34 (`Account.sol:183-228`), test asserts
   active == 3 and passes (line 189).
2. One cooperative settlement with `forgiveDebtsInTokenIds = [T]` (lines 192-210) routes to
   `_forgiveDebtsBetweenEntities` (`Depository.sol:518-523 → 833-858`), which is
   deliberately O(1): it forgives ONLY the single cursor-head debt (`queue[idx]`, idx=32,
   amount 100, creditor matches), zeroes it, decrements outstanding by 100, advances cursor
   to 33 (line 855) — comment at 842-844: "may forgive only the debtor's current debt …
   never scan or partially process an unbounded tail."
3. Residual = 300 − 100 = exactly 200 = two intact whole FIFO entries (2 × 100), not
   integer-division dust — no division exists anywhere on this path.
4. Books stay exact: `_assertBooksAgree("after forgiveness")` (line 212) PASSES —
   `debtOutstanding`, active count and cursor stay mutually consistent; only the
   test's "everything forgiven from one settlement" expectation (line 213) is wrong
   relative to the documented single-entry design.
5. Not a permanent strand (liveness intact): each subsequent forgiveness settlement
   forgives one more entry; `enforceDebts` resumes from cursor 33 — but the signer-visible
   semantics ("forgive token T" actually = "forgive one T-debt entry") is a real
   economic-meaning mismatch worth an owner decision: fix the test to loop 3 settlements,
   or change design to drain the queue per token.

The C4 report's own characterization ("candidate bookkeeping divergence of partial
enforcement + forgiveness") is imprecise: bookkeeping is exact; the divergence is
between a full-drain test expectation and deliberate O(1) single-entry forgiveness.

## 100/100 gap list

1. **Commit the C4 artifacts** (10 test files + `proofs/solidity/`) — today a single
   `git clean -fd` destroys the entire proof; no immutable SHA covers the C4 evidence (F4).
2. **DebtChunking triage**: reclassify as test-vs-design mismatch per analysis above;
   decide loop-3-settlements test fix vs queue-drain design change; document the
   single-entry forgiveness semantics at the API surface (F3).
3. **BatchBounds 15M budget breach**: owner decision — raise `LIVENESS_BUDGET` or lower the
   aggregate 256-pair cap; 15,049,243 > 15,000,000 is a live worst-case protocol-budget
   violation today (F2).
4. Halmos path-count stability: pin build artifacts or add a ±tolerance note so 953→982
   deltas are not mistaken for evidence drift (F5).
5. Report the typechain/artifacts regeneration side-effect in the evidence section (F6) —
   cosmetic but keeps the working-tree claim exact.
6. Report's own listed extensions, unchanged: historical-batch replay coverage and
   `FOUNDRY_PROFILE=deep` (1024×128) run of the new suites.

## Grade

**92/100.**

- Full evidence reproduction: every runnable claim matches, including exact failure
  messages and suite counts; honest documentation of HEAD drift, untracked footprint and
  the halmos `gasleft()` artifact (with a control proving it on real EVM).
- −4: C4 evidence not committed (immutability gap, F4).
- −2: DebtChunking mischaracterized as bookkeeping divergence when books are provably
  exact and the cause is documented O(1) single-entry forgiveness (F3) — this matters
  because it feeds the owner's triage with the wrong category.
- −2: halmos path counts presented as exact but not rebuild-stable (F5).
- No deduction for the two pre-existing test failures themselves: they are real, correctly
  reported, correctly isolated, and outside C4's scope (frozen files).

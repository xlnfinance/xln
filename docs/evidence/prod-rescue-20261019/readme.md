# Production rescue candidate, 2026-10-19

Baseline main: `c14cabfba5c9396e8614b996ff5a60c2bdea36f8`.
This records a candidate before publication. It is not mainnet acceptance or proof
that the public frontend serves these changes. Measured results and immutable
source/log hashes are in [candidate-evidence.json](candidate-evidence.json).

The public primary test-wallet flow reached usable Home in 58.381 seconds after
55,796 header reads. Nine foundation actions included faucet, Pay 25 USDC and
Swap 25 USDC; the advanced Hubs lesson failed because its target was missing.
The candidate restores that target and mobile tutorial navigation. Its separate
fresh boot measured 48.285 seconds with 53,677 header reads; differing heads prevent
claiming a causal speedup. Dense authenticated scanning retains the preceding
anchor and both complete reorg-fenced header passes.

Observer history now replays one exact stored Runtime height for the requested
Entity pages, preserving integrity validation. The complete owning browser test
passed, including mobile reload and return to the wallet. The latter exposed an
IPv6-only Vite listener behind an IPv4 gateway; the canonical launcher binds IPv4
and readiness now probes the actual wallet route.

Rust cross-J lifecycle diverged only at signed dispute evidence. Its encoder
omitted the fourth, empty loans array required by the existing Solidity/TS ABI.
Independent Ethers vectors confirmed the cause. The unchanged TS lifecycle fixture
and corrected Rust lifecycle agree. The Rust launch profile continues rejecting
unsupported loan covenant bodies; its existing ignored test is not certification.

A captured ordinary ACK followed by a complete atomic pair exposed TS dispatch
reordering. Dispatch now batches adjacent ordinary units while retaining cohort
position, atomic completeness and backpressure. Captured WAL rows are unchanged.
All 41 Rust test binaries and doctests passed: 1145 tests, 0 failures, 1 existing ignore.

The current production-stand browser L2 passed 9/9 in 190.163 seconds, with
zero skipped, unexpected or flaky tests. It exercised both cross-swap variants,
lending, actual funding/payment/swap/history and tutorial navigation on two EVM
chains. This does not establish native TRON support.

The exact `bun run test:unit` command passed 5487 tests with 675634 assertions,
zero failures and one existing conditional Rust semantic-completeness skip. The
exact `bun run test` command passed all five scenarios and its Chromium rebalance
E2E (1/1, zero skips/flaky/unexpected/browser errors). A public landing entry check
also passed 2/2 actual clicks to the online React wallet gate on desktop/mobile;
it does not establish wallet creation or tutorial completion.

After those exact commands, unconsumed Account-root diagnostics and four unused
type reexports were removed: owning L1 passed 21/21 with 77 assertions, the actual
unused-surface gate passed, and the financial/tutorial browser L2 above was rerun.
The publication verifier now preserves independent BrainVault edits while rejecting
all XLN dirtiness, hidden index flags and cross-boundary renames. Its aggregate
check budget is 300 seconds, covering a measured 186-second check; 20/20 real-Git
and process-cleanup tests passed with 100 assertions. Exact unit/test successes
precede these final changes; focused L1/L2 verifies the changes.

The unchanged final check, public served-version and tutorial verification, full
release, native TRON and public-chain acceptance remain separate gates.
Private browser profiles, wallet material, storage, WAL and traces are excluded.

The first checked publication is `68711729ea1d4a04ec28060a53a5062a845de40e`;
[its publication evidence](publication-68711729ea.json) records direct public
asset hashes, 4/4 primary/reload checks and 52/52 tutorial actions. A separate
real incoming-WETH exercise then reproduced false Trade completion. The
[next candidate evidence](trade-receipt.json) binds completion to a committed
receipt for the submitted order and records the negative/positive browser
regressions plus recovery of the unchanged earlier swap WAL. Publication of
that correction and final release/mainnet gates remain separate.

# Host-independent verification

Run `bun run verify` on a clean, committed `main`. It runs the existing
`bun run check` with a 60-second process budget. It uses the Bun executable
running the verifier and needs the same installed dependencies and tools as
`check`. It does not call GitHub, require a network connection to a Git host,
or substitute a different test suite.

Every run stores a full combined stdout/stderr log and an atomic JSON result
under `<git-common-dir>/xln-verification/<commit>/<run>/`. The result records
the commit, tree, branch, changed paths, Bun/Git/Node/Forge/Cargo versions,
OS, machine, duration, exit status and timeout/interruption status. Missing
optional version probes are recorded with their exit status; missing tools
required by `check` still fail the check itself. There is no cached-success
path. At timeout or interruption, the verifier reads actual process ancestry,
records the owned PIDs and process groups, and stops those exact groups,
including separately detached descendants. It sends TERM so existing cleanup
wrappers can run, then escalates to KILL and verifies exit. It never matches
process names or signals unrelated groups. Cleanup failure rejects the run
and retains the failure evidence.

Both tracked changes and nonignored untracked files reject verification;
the verifier reports their counts and records their exact paths. It never
deletes, stashes, stages or commits files. Commit or preserve unrelated work
outside the active tree before verification. The commit and cleanliness are
checked again afterward, so concurrent writes invalidate that run. Stop
all source writers for release verification. Ignored dependencies, current
testnet stores and build products are not source-cleanliness evidence.
Index flags that hide tracked paths (`assume-unchanged` or `skip-worktree`)
also reject verification; the verifier preserves those flags.

Install the local push gate once per clone with `bun run verify:install`.
The installer sets only that repository's `core.hooksPath=.githooks` and
refuses conflicting hook configuration or active default hooks, showing
the exact conflict without overwriting it. `bun` must be on the Git
process's `PATH`. The hook checks every nondeletion update: only `main`
at the exact current HEAD is accepted, and a fresh verifier run must pass.
Deletion-only pushes do not run code checks. The hook performs no remote
administration and does not authorize force pushes.

This works with any Git remote, including a private SSH server or a local
bare repository. A local hook is an accident-prevention gate, not a security
boundary against someone deliberately bypassing client hooks. A shared
server can enforce repository policy separately if needed. Automatic GitHub
CI is not required for this workflow.

For release evidence, preserve the result and log in `docs/evidence/` with
the checked commit named explicitly. Those reports describe that immutable
source commit; adding a report does not retroactively verify a different
commit. Keep focused L1/L2 and browser evidence required by the change beside
the release report. `verify` covers only the existing `check` command and
does not claim replay parity, live economics, TPS or mainnet readiness.

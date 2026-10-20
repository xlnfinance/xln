# Playwright discovery unit boundary

The exact unit command timed out while listing Cross tests through the real Playwright CLI. The old `EMPTY_OUTPUT` error hid the terminated child. The same two-package discovery completed within its unchanged five-second limit in a fresh repo-root process.

The unit runner now executes the three Playwright subprocess-contract files in a fresh process at the repository root, before the financial suite. It excludes exactly those files from the bulk process and retains explicit-target behavior, every existing assertion and all original deadlines. The separate core-directory stdio cohort remains unchanged.

Failed discovery now reports the actual child exit status, signal and elapsed time while preserving both stderr and structured JSON reporter errors. Two regressions invoke the real CLI with an unknown project and an unmatched spec; neither accepts an empty catalog.

Validation: **67/67 focused tests, 1,052 assertions**, then exact **`bun run test:unit`: 5,526/5,526, zero failures or skips**, in 1,458.591 seconds with unchanged candidate bytes. The original discovery case took 3,783 ms in that full run. The specific cause of the prior child slowdown is not established; this change isolates subprocess resource lifetime without extending its test budget.

[Machine-readable evidence](proof.json) binds the patch, source files and retained logs. Financial runtime, contract and public deployment behavior are outside this patch. Fresh final-SHA financial, browser, release and soak acceptance remains required.

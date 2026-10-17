# Entity selection belongs to the connected Runtime

Base: `5c7e04dd50800d1e2a461616138cdb9c63bc35e5`.

The required H1/H2/H3 browser targeted a removed Svelte wallet header (baseline
exit1,33.732s). Porting it to actual React remote connections exposed a production
bug: Lock disconnected the adapter but retained H3's active Entity. Selecting the
saved H2 wallet and connecting made App see connected status plus that stale
Entity, so it unmounted Gate before H2's Entity choice. The regression timed out
at that choice; the exact trace is preserved in `context-react-2-boundary`.

The canonical `disconnectAdapter` now clears its active Entity selection before
publishing disconnected status. Saved wallet metadata remains; a new connection
must select its own Entity. No server capability, signer, financial transition,
storage format or checkpoint/WAL rule changes.

The browser opens H1, H2 and H3 through explicit endpoint/key consent, verifies
actual Runtime/Entity identities and jurisdiction RPC/Depository metadata, and
locks each session. Saved metadata contains all three endpoints/Entities and no
capability. Choosing saved H2 must show its endpoint with an empty key, remain
disconnected until explicit authorization, display the Entity chooser, then open
the exact H2 Entity. The old grouped Svelte header is not restored.

## Evidence

- Real three-Runtime regression1/1,28.120s (`context-react-4`). The test also
  verifies each served Entity is selectable and the selected chain is rendered.
- Intermediate test errors are retained: RPC URL was incorrectly asserted to be
  a contract address; final navigation expected Home while the valid current
  screen remained Settings. Neither required a production workaround.
- Related embedded BrainVault unlock/profile recovery, current remote-link
  guards, fullcheck, clean committed browser and pre-push verifier are recorded
  as `context-embedded-regression`, `context-link-guards`, `context-final-check`,
  `context-clean-head`, `context-publish` before publication is accepted.

Actual logs/exits/timings, failure traces, build hashes and browser manifests:
`/Users/zigota/agent-jobs/xln-mainnet-autonomy-20261017/` in `context-*` artifacts.
Runs hold the capacity-one stand with60s budgets. Exact timed-out processes were
gone and stand free before the next run. No timeout is counted as green.

After `bun run stand:status`, reproduce:

```sh
bun run stand:run --reason runtime-selection --timeout-ms 60000 -- \
  bun core/scripts/e2e/runners/run-e2e-parallel-isolated.ts \
  --all --strict-browser-health --shards=1 --workers-per-shard=1 \
  --max-mm-concurrency=1 --video=retain-on-failure --trace=retain-on-failure \
  --screenshot=only-on-failure --max-failures=1 \
  '--pw-files=tests/e2e/runtime/e2e-radapter-remote-part-1.spec.ts::context dropdown groups H1 H2 H3 remote runtimes'
```

This closes one current wallet switching boundary. Aggregate release, remaining
operator/browser cases, public-chain proofs and soak are still required.

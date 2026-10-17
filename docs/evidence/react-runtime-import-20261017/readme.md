# Current Runtime manifest reaches the React wallet

Base: `e8af4a80f86a3735ca6215aec0e069a552f638bb`.

The canonical orchestrator returned `/app#runtime-import-src=...`, which the
single wallet gateway forwarded to React. Gate ignored that field. The original
required switch test first failed on its removed Svelte consent selector
(44.285s). After porting only that setup, the real import summary stayed missing
and React remained at Welcome. The stand stopped the run at60s; total wrapper
cleanup62.172s. Exact descendants were gone and the stand free before continuing.

React now consumes the same-origin current source link, strips it from history,
and asks the user to load the list. Endpoints are shown before a separate
Validate & attach action opens authenticated, read-only validation connections.
Selecting a validated Runtime pre-fills the current single-endpoint consent form;
Connect and Entity selection remain explicit. Capabilities live in that consent
screen's memory. Saved React wallets contain endpoint/Entity metadata only.

The shared batch validator retains bounded concurrency4, positional results,
per-entry failures and authenticated Runtime/Entity reads. Its one-shot reads use
the actual connected adapter directly, without loading Svelte's observer-global
query cache. The existing recovery helpers moved unchanged into their own module;
current callers were updated, with no compatibility re-export. Recovery still
uses its existing query client and current protocol.

Retired: inline/base64 Runtime-import URL reader and E2E alternate-origin/inline
fallback. Both shells use the current source-link decoder. Current server
manifest version1 is explicit and mandatory; missing/other versions fail loudly.
Manual operator text entry remains a distinct current input surface. No old
profile/frame reader, wallet rescue path or migration is introduced.

## Evidence

- Real H1 -> manifest -> H2 switching1/1,45.705s. Five authenticated results,
  key-free saved metadata, correct H2 Entity/signer/profile, read-only projection,
  and zero RuntimeInput sends; no sockets before endpoint validation consent.
- Real H1/H2/H3/MM/Custody import1/1,44.755s; final formatted UI/decoder1/1,
  45.399s. Own Entity labels/ids, MM/Custody not H3, current Runtime activation,
  funded mesh and MM books all remain asserted.
- Final browser records0 console/page/network/HTTP issues. Desktop and390px
  screenshots were inspected; mobile has no horizontal overflow.
- Shared link/import/recovery/query guards119/119,1035assertions,0.337s.
  Earlier115/118 failed solely on three moved-source/cache-owner assertions;
  their current owner checks are retained, not skipped.
- Current admin/history plus observer browser1/1,51.930s, zero browser issues.
- First integrated check38+3 gates,26.440s. Final
  final check, clean committed browsers and installed pre-push verifier are
  required as `import-observer-regression`, `import-final-check`,
  `import-switch-clean-head`, `import-bulk-clean-head`, `import-publish`.

Exact commands, exits, hashes, screenshots and timeout evidence are under
`/Users/zigota/agent-jobs/xln-mainnet-autonomy-20261017/` in `import*` and
`bulk-runtime-*` artifacts. Runs hold the capacity-one stand with60s budgets.
No timeout is green. No contracts, frozen hashes, financial transitions, Rust,
current checkpoint/WAL format or mainnet admission scope changed.

After `bun run stand:status`, reproduce each real browser target separately:

```sh
bun run stand:run --reason runtime-import --timeout-ms 60000 -- \
  bun core/scripts/e2e/runners/run-e2e-parallel-isolated.ts \
  --all --strict-browser-health --shards=1 --workers-per-shard=1 \
  --max-mm-concurrency=1 --video=retain-on-failure --trace=retain-on-failure \
  --screenshot=only-on-failure --max-failures=1 \
  '--pw-files=tests/e2e/runtime/e2e-radapter-remote-part-2.spec.ts::runtime dropdown switches app-imported remote runtimes without manager route'
```

The second title in the same file is `bulk remote runtime import link validates
mesh, custody, and market maker runtimes in browser`. Inspection of existing
Custody/MM runtimes does not admit deferred custody or cross-J products to the
mainnet launch. Aggregate release, public operator/chain/rollback, soak and
MacBook synchronization remain separate incomplete gates.

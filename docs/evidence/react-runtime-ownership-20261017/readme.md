# React Runtime ownership drains before takeover

Base: `b5c229b579e8453de6226ee745cc4de3dcbd922b`.

The old active-tab browser test passed only the Svelte observer's `locktest`
mode. React did not hold that origin-wide Runtime lease. A real second password
unlock opened the same Runtime while the first still ran; the relay rejected it
with `DUPLICATE_RUNTIME_CONNECTION`. Exact failing browser evidence:
`react-runtime-ownership-red`, exit1,32.966s. No transport/auth rejection was
suppressed or made permissive.

React now uses the existing shared Web Lock/BroadcastChannel ownership controller.
Password validation precedes acquisition. On takeover the existing Runtime session
shutdown drains accepted work, closes database/transport handles, removes the
in-memory seed and only then releases the lease. A failed close retains both the
lease and rejected close promise until reload. A takeover during asynchronous
main bootstrap waits until that Runtime is available to close. Failed bootstrap
cleanup is explicit; neither error is swallowed if cleanup also fails. The shared
controller's boundary import is relative so both actual app owners can import it;
its coordination algorithm and Svelte observer behavior are unchanged.

## Evidence

- Actual React handoff after fix1/1,42.291s, strict browser health. The first
  intermediate attempt completed handoff but failed strict health on a transient
  retained-output warning; it is preserved as a failed run, not waived.
- Expanded actual authority regression1/1,43.386s: a read-only `/address` observer
  cannot evict the wallet; wrong password cannot take ownership; correct unlock
  restores the same Entity only after old Runtime pause, loop stop and seed removal.
  No warnings/errors were allowed for this scenario.
- Existing shared ownership/lease guards54/54,603assertions,0.209s. An obsolete
  positive `UserModePanel.svelte` assertion first failed ENOENT; it now requires
  current React Gate/seed removal while preserving all prior signer-lease guards.
- Current schema rejection, explicit isolated reset and password-authenticated
  regeneration1/1,42.785s after the ownership change. Normal current-format
  checkpoint/WAL restore remains the sole recovery path.
- Prior unchanged browser storage-writer gate1/1,17.106s on the base proves
  serialized restores and stale-writer fencing; it is not evidence of React
  lifetime ownership, which required the new real regression above.

Reproduce after `bun run stand:status`, under
`bun run stand:run --reason react-runtime-ownership --timeout-ms 60000 --`:

```sh
bun core/scripts/e2e/runners/run-e2e-parallel-isolated.ts \
  --all --strict-browser-health --shards=1 --workers-per-shard=1 \
  --max-mm-concurrency=1 --video=retain-on-failure --trace=retain-on-failure \
  --screenshot=only-on-failure --max-failures=1 \
  '--pw-files=tests/e2e/runtime/e2e-active-tab-lock.spec.ts::React wallet transfers ownership only after the previous Runtime drains'
```

Full check, clean committed browser and local verifier/publication results are
recorded before publication under
`/Users/zigota/agent-jobs/xln-mainnet-autonomy-20261017/evidence/react-runtime-ownership-*`
and the corresponding `*-boundary/` folders. No financial formula, contract,
WAL format, frozen hash, compatibility reader or alternate lock implementation.
No aggregate release, public-chain, soak or mainnet readiness claim.

# Reject obsolete browser storage without a rescue reader

Base: `2e10c0165cd14046ea892e2b915ce55145210e36`.

The full browser suite still required the removed Svelte vault API and schema
backup-rescue screen. Its immutable baseline failed before touching storage
(exit1,15.161s). After current React onboarding/unlock replaced that setup, the
actual wallet correctly rejected schema5 at `storage-head`, kept the old bytes
and showed the exact error. The stale Svelte selector then failed (53.681s).
No production recovery defect or missing compatibility reader was inferred.

The test now requires that canonical behavior. It creates a real password wallet,
locks its Runtime through Settings, closes the realm, and changes only the real
isolated IndexedDB head from current6 to obsolete5. Unlock must show the exact
schema mismatch, expose no Home or retired rescue UI, and leave stored5 intact.
The two expected fail-stop log events are required and narrowly classified;
other browser errors remain failures. Wide/laptop/mobile screenshots are retained.

Regeneration is an explicit testnet operator operation, not a wallet reset UI
claim: after closing the failed realm, native IndexedDB deletion targets only
an enumerated exact Runtime namespace and known current store suffixes. Unknown
stores or blocked handles fail the test. Other IndexedDB stores and every
localStorage value, including the encrypted password vault, must remain identical.
The same wallet rejects a wrong password and opens the same Entity with the
correct password and newly generated schema6. No obsolete data is replayed or
migrated. Normal current checkpoint plus ordered WAL recovery is unchanged.

## Evidence

- Final browser1/1,30.004s, strict health and real isolated stack, stand60.
  Two required schema-rejection diagnostics; zero unexpected browser issues.
- Related schema boundary and actual current Account/WAL restore tests8/8,
  27assertions,12.830s. These include three pinned hub Accounts and sparse
  reliable Entity-input replay.
- Full check and clean committed browser/verifier results are retained beside
  the logs before publication. This slice changes tests/docs only; no runtime,
  contract, frozen hash, durable format or recovery implementation change.

After `bun run stand:status`, reproduce under
`bun run stand:run --reason storage-schema-rejection --timeout-ms 60000 --`:

```sh
bun core/scripts/e2e/runners/run-e2e-parallel-isolated.ts \
  --all --strict-browser-health --shards=1 --workers-per-shard=1 \
  --max-mm-concurrency=1 --video=retain-on-failure --trace=retain-on-failure \
  --screenshot=only-on-failure --max-failures=1 \
  '--pw-files=tests/e2e/recovery/e2e-storage-schema-recovery.spec.ts::rejects obsolete storage and regenerates current data only after explicit testnet reset'
```

Artifacts: `/Users/zigota/agent-jobs/xln-mainnet-autonomy-20261017/evidence/storage-schema-*`,
`evidence/schema-current-recovery-l1l2.*` and corresponding `*-boundary/` folders.
The original exact failed target was rerun green before its obsolete title was
updated; no failure-ledger entry was deleted or bypassed. No aggregate release,
public-chain, soak or mainnet-readiness claim.

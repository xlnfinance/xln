# Current remote Runtime links open the React consent flow

Base: `89881e572795095322a244d75aa958134ce7a9d0`.

The original release browser failed in32.982s: the advertised single-Hub
`/app#runtime=remote&ws=...&token=...` link reached React, but Gate ignored it.
No remote connection occurred. The archived failure names the missing retired
Svelte consent screen; the current React connection form already existed.

Gate now populates that form through one framework-free decoder shared with the
observer Runtime connection owner. It removes capability-bearing URL fields,
displays the actual endpoint and waits for an explicit Connect. The existing
RemoteRuntimeAdapter/server authenticate the capability; parsing its envelope
does not grant authority. It never imports a seed or creates a local Runtime.
The saved observer credential registry remains supported for current sessions.
Malformed supplied capabilities are rejected, never replaced by saved keys.

The shared decoder rejects ambiguous/duplicate fields, old URL aliases, query
capabilities, non-WebSocket endpoints and hidden endpoint credentials/query/hash.
Current invoice fragments belong to the invoice router and are unchanged. An
adversarial L1 caught an intermediate decoder treating an invoice's asset token
as a capability when query order differed; the same vector now passes.

## Evidence

- Pure link rejection/cleanup vectors and existing observer/query/import guards:
  116/116,1014 assertions,0.346s. Five initial static failures named relocated or
  retired APIs; assertions now follow the actual React owner while retaining
  observer restrictions, current-session credential reuse and receipt singleton
  checks. No financial assertion or gate is skipped.
- Final actual remote browser1/1,33.969s: no adapter or stored capability before
  consent; scrubbed URL; explicit H1 choice; admin authentication; same Runtime
  and Entity; Accounts H2/H3; real activity rows; no embedded Runtime. Actual
  native/ERC20 balances, allowances and block hashes are checked at pinned RPC
  heights on both existing jurisdiction domains. Zero browser issues.
- Actual invoice payment regression1/1,37.066s on the same source candidate.
  Existing exact5USDC receive/payment and authenticated deep-link assertions
  remain. No invoice implementation changed.
- Final full source check, clean committed remote browser and mandatory clean
  pre-push verifier are recorded as `remote-link-final-check`,
  `remote-link-clean-head`, `remote-link-publish` before publication is accepted.

All commands, exit codes, timings, browser manifests, event reports and asset
hashes are under `/Users/zigota/agent-jobs/xln-mainnet-autonomy-20261017/` in the
`remote-*` evidence and boundary folders. Original failures are preserved.
Each heavy command uses the capacity-one stand and60s wall budget.

After `bun run stand:status`, reproduce the current behavioral regression:

```sh
bun run stand:run --reason remote-hub --timeout-ms 60000 -- \
  bun core/scripts/e2e/runners/run-e2e-parallel-isolated.ts \
  --all --strict-browser-health --shards=1 --workers-per-shard=1 \
  --max-mm-concurrency=1 --video=retain-on-failure --trace=retain-on-failure \
  --screenshot=only-on-failure --max-failures=1 \
  '--pw-files=tests/e2e/runtime/e2e-radapter-remote-part-1.spec.ts::remote /app opens an existing hub runtime through radapter'
```

No financial transition, server permission, current storage format, contract or
frozen hash changed. Bulk import and other remote operator cases are separate
remaining gates. No aggregate release, soak or mainnet-readiness claim.

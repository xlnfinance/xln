# XLN Ops Runbook

This runbook covers the production orchestrator surface exposed by `core/orchestrator/orchestrator.ts`.

## Health Endpoints

- `GET /api/health`: JSON readiness. Local loopback callers receive full diagnostics; public callers receive redacted status.
- `GET /api/metrics`: Prometheus text metrics derived from the same health object, with the same redaction. Per-child, hub restart, tracked-storage, `xln_disk_free_bytes` and external-client metrics are operator-only: scrape them from loopback on the host or with the daemon bearer.

Quick checks:

```bash
curl -fsS https://xln.finance/api/health | jq '{coreOk, systemOk, degraded, disk, storage, hubMesh, marketMaker, custody}'
curl -fsS https://xln.finance/api/metrics | grep -E 'xln_(core_ok|system_ok|disk_used_pct|process_rss_bytes|hub_online)'
bun run prod:health
```

For remote operator health, supply the existing node capability through an owner-only file:

```bash
bun run prod:health --operator-token-file=/absolute/private/operator-token
```

`XLN_PROD_HEALTH_OPERATOR_TOKEN_FILE` supplies the same option for release/preflight scripts.
The client reads the file without creating or rotating credentials. Obtain it through the existing
operator access procedure; never put its contents in command arguments, logs or evidence.
Only API incidents, health and metrics receive the capability. Authenticated requests require HTTPS
(or loopback HTTP) and reject redirects; separate tower URLs and the wallet request receive no token.
A missing/wrong capability remains an authorization failure, not permission to skip incident checks.

## Orchestrator shutdown ownership

Start `xln-server` with PM2 `--no-treekill --kill-timeout 60000`, as the canonical
platform deploy does. The orchestrator owns child quiesce and termination; PM2's
default tree signal races that sequence and its default1.6s grace preempts it.
The current normal shutdown hierarchy requires up to50.15s. Existing parent-liveness
watches still close managed children when their exact parent disappears.

[Actual normal and parent-crash drills](../evidence/pm2-runtime-shutdown-20261017/readme.md)
record supervision before/after, old process identities, current-WAL financial-state
comparisons and unchanged unrelated owners. Preserve the current stores on restart.

## Pinned runtime executable

`package.json` owns the exact Bun version. Startup and deployment reject a different
version before opening stores, creating keys, killing listeners or deleting fresh
state. Configure each XLN service's PATH with the verified app-scoped Bun directory
first; server, custody and watchtower execute the selected checked binary. Do not
replace another application's global runtime to satisfy this requirement.

Record archive/binary hashes and verify the selected executable with `bun --version`
in the actual service environment. Preserve its current checkpoint/WAL before a
controlled restart. A successful short crypto/worker test does not prove a previously
observed shutdown crash fixed; capture old/new process ownership, exit logs and exact
financial state after the actual restart. See
[pinned runtime and recovery evidence](../evidence/pinned-bun-startup-20261017/readme.md).
The [actual public pinned-runtime deployment](../evidence/public-pinned-runtime-20261017/readme.md)
records executable provenance, current-store backups, bounded restart, exact financial
comparisons and HTTPS verification. Its retained shutdown warnings and release limits
are part of the result.

## Regenerating obsolete testnet stores

The owner-authorized October17 recovery is recorded in
[public testnet evidence](../evidence/public-testnet-regeneration-20261017/readme.md).
Its archived commands identify the exact namespaces and preservation guards; do not
reuse a reset list against a different host without resolving its current owners.

1. Build and hash the current canonical web artifact before stopping services.
2. Record exact PM2 owners, protected seed/key hashes and modes, unrelated process
   identities, and current source. Stop only the owning XLN services; verify zero
   open handles and reject symlinked/unknown reset roots.
3. Use `scripts/deployment/prepare-remote-main.sh` for a guarded fast-forward.
   Delete only confirmed obsolete testnet stores; preserve current credentials,
   job evidence and the sibling debug-incident journal. Install through
   `scripts/deployment/web-artifacts.sh` and verify every installed file hash.
4. Start existing canonical chain/runtime owners. Observe their bootstrap through
   bounded checks without restarting a still-progressing managed service. Preserve
   timeout results separately from later readiness observations.
5. Snapshot incidents and health before resolving any historical incident. Require
   its last occurrence to predate the replacement deployment and concrete evidence
   its condition is gone. Resolve individually through the authenticated operator
   API; never clear the journal to satisfy release health. Recurrence reopens it.
6. Run exact-source `prod:health` with three hubs/self-relay and one tower, then
   actual public HTTPS wallet/runtime/worker verification. Preserve all failures.

These steps regenerate obsolete testnet data. They are not the current-format
checkpoint/WAL recovery drill or a rollback proof, and do not authorize a mainnet reset.

## Alert Rules

- Page immediately when `xln_core_ok == 0` for 2 minutes.
- Page when `xln_system_ok == 0` for 5 minutes, unless a planned deploy is active.
- Page when `xln_disk_free_bytes < 10GiB` or `xln_storage_ok == 0`.
- Page when any `xln_child_online{name=...} == 0` for 2 minutes.
- Page when `xln_hub_mesh_ok == 0` for 5 minutes.
- Warn when `xln_process_rss_bytes` grows by more than 25% in 30 minutes.
- Warn when any `xln_storage_scan_truncated == 1`; increase scan budget before trusting tracked byte deltas.

## Triage

1. Snapshot current health and metrics:

   ```bash
   curl -fsS https://xln.finance/api/health > /tmp/xln-health.json
   curl -fsS https://xln.finance/api/metrics > /tmp/xln-metrics.prom
   ```

2. Check child process state:

   ```bash
   jq '.process.children[] | {role, name, online, pid, restartCount, lastErrorLine}' /tmp/xln-health.json
   pm2 status
   pm2 logs --lines 200
   ```

3. Check storage pressure:

   ```bash
   bun run debug:disk
   jq '.disk, .storage.tracked[] | {name, kind, currentBytes, bytesPerHour, scanTruncated}' /tmp/xln-health.json
   df -h /
   du -sh logs .logs playwright-report test-results db 2>/dev/null || true
   ```

   Test runners clean old generated artifacts by default before new runs.
   Use `XLN_KEEP_TEST_ARTIFACTS=1` only when preserving traces/videos/logs is
   intentional. Generated test artifacts are budgeted at 50 GiB by default via
   `XLN_TEST_WORKSPACE_MAX_BYTES`.

4. If a hub is down but the orchestrator is healthy, prefer an orchestrator-managed restart over killing child PIDs manually:

   ```bash
   pm2 restart xln
   sleep 10
   curl -fsS https://xln.finance/api/health | jq '{coreOk, systemOk, degraded, hubs}'
   ```

## Storage Recovery

- The `*-wal` Runtime WAL is authoritative for replay. The `*-history-views`
  database is a rebuildable inspection/UI index, never a commit authority.
- On startup, current state and history views reconcile from the WAL if either
  lagged after a crash. A secondary-database failure must not roll Runtime back.
- `storage.epochMaxBytes` is the byte trigger for a full storage epoch rotation.
  The normal runtime default is 16 GiB; small values belong only in explicit
  rotation tests and smoke drills. The Runtime writes a full snapshot to the
  WAL, prunes replay diffs covered by the retained snapshot, seeds a fresh
  `*-storage-current` DB from live rows plus Merkle rows, and leaves the
  replaced DB at `*-storage-previous`.
- Treat `*-wal` as the recovery source of truth. Preserve both `*-wal` and
  `*-history-views` during incident investigation; the latter can be rebuilt,
  but contains useful evidence about materialization progress.
- For high-load hub drills, use the rotation benchmarks:

  ```bash
  bun run bench:radapter:hub10k:rotation
  bun run bench:radapter:hub1m:rotation
  ```

  The 1M drill should show `rotationProbe.snapshotDocs == rotationProbe.liveDocs`, `rotationProbe.nextRetainedHistoryBytes == 0`, read p99 under the script cap, durable-write p99 under the script cap, and peak RSS under the configured cap.
- If health reports storage verification failure, keep the DB directories intact and collect:

  ```bash
  tar -czf /tmp/xln-storage-incident.tgz db data/storage-health-history.json logs .logs 2>/dev/null || true
  ```

- Do not delete `db/` or `.logs/e2e-*` during incident capture unless the release owner explicitly approves it.

## Release Check

Before declaring a deploy healthy:

```bash
bun run gate:ci
bun run soundcheck runtime frontend/src package.json .github/workflows
bun run test:e2e:fast
bun run test:rpc-settlement
bun run security:audit-pack
bun run prod:health
```

Use `bun run deploy:prod` for the canonical production rollout. It always resets
the public testnet chain, runtime, mesh, and custody state before bootstrapping.
Hub and market-maker WAL is not a deployment input. `bun run deploy:prod:fresh`
is an explicit alias for the same clean deployment policy.

Before a public-net release candidate, also run:

```bash
bun run gate:release
bun run soak:release
```

For the public-testnet launch envelope in the current `AGENTS.md` scope,
with one tower and three hubs, use the existing operator gate below. The owner
removed the global monetary cap on 2026-10-11; these historical command names
do not restrict participation or imply guaranteed unsecured recovery.

```bash
export XLN_CAPPED_TESTNET_TOWER_URLS=https://tower.example.com
bun run gate:capped-testnet:preflight
bun run gate:capped-testnet
```

`gate:capped-testnet` writes a JSON report under `.logs/gates/` and runs the
one-hour capped soak. If any step fails, fix the root cause, commit the fix,
and start the capped gate again from a fresh release-candidate commit.

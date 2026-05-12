# XLN Ops Runbook

This runbook covers the production orchestrator surface exposed by `runtime/orchestrator/orchestrator.ts`.

## Health Endpoints

- `GET /api/health`: JSON readiness. Local loopback callers receive full diagnostics; public callers receive redacted status.
- `GET /api/metrics`: Prometheus text metrics derived from the same health object.

Quick checks:

```bash
curl -fsS https://xln.finance/api/health | jq '{coreOk, systemOk, degraded, disk, storage, hubMesh, marketMaker, custody}'
curl -fsS https://xln.finance/api/metrics | grep -E 'xln_(core_ok|system_ok|disk_free_bytes|process_rss_bytes|hub_online)'
```

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
   jq '.disk, .storage.tracked[] | {name, kind, currentBytes, bytesPerHour, scanTruncated}' /tmp/xln-health.json
   df -h /
   du -sh logs .logs playwright-report test-results db 2>/dev/null || true
   ```

4. If a hub is down but the orchestrator is healthy, prefer an orchestrator-managed restart over killing child PIDs manually:

   ```bash
   pm2 restart xln
   sleep 10
   curl -fsS https://xln.finance/api/health | jq '{coreOk, systemOk, degraded, hubs}'
   ```

## Storage Recovery

- The history frame DB is authoritative for runtime replay.
- On startup and before durable writes, the current materialized DB is reconciled from history if it lagged after a crash.
- `storage.epochMaxBytes` is the byte trigger for a full storage epoch rotation. When retained replay bytes cross the limit, the runtime writes a full snapshot into the history frame DB, prunes replay diffs covered by the retained snapshot, seeds a fresh `*-storage-current` DB from live rows plus Merkle rows, and leaves the replaced DB at `*-storage-previous`.
- Treat `*-frames` as the recovery source of truth. `*-storage-previous` is an archive/debug candidate after the new `*-storage-current` opens and `/api/health` is green; do not delete or move `*-frames` while investigating storage incidents.
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
bun run soundcheck runtime frontend/src package.json .github/workflows
bun run test:e2e:fast
curl -fsS https://xln.finance/api/health | jq -e '.coreOk == true and .systemOk == true'
curl -fsS https://xln.finance/api/metrics | grep -q '^xln_system_ok 1'
```

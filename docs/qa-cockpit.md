# qa cockpit

The QA cockpit is a read-only dashboard for browsing e2e test evidence: run history, per-run artifacts (screenshots, videos, traces, logs), curated UI screenshots, performance/benchmark stats, and failure triage. Heavy artifacts (videos) are generated on a dev machine and published to prod — **the server never runs e2e itself**.

## Where

- Cockpit UI: `https://xln.finance/qa` (route `frontend/src/routes/qa/+page.svelte`)
- Run drill-down: `https://xln.finance/runs` (route `frontend/src/routes/runs/+page.svelte`)
- API client: `frontend/src/lib/qa/apiClient.ts`
- Backend: `runtime/qa/api.ts` (HTTP routes) + `runtime/qa/report.ts` (data model, history DB, scanners)

## Storage layout

Defined in `runtime/qa/report.ts`. Roots derive from `QA_EVIDENCE_ROOT` (default `./.logs`; prod = `/root/xln-qa-evidence`, set by `scripts/start-server.sh` via checkout-path detection so it lives **outside** the git checkout that `deploy.sh` hard-resets):

- `QA_LOGS_ROOT` = `$QA_EVIDENCE_ROOT/e2e-parallel/<runId>/` — per-run artifacts (videos, traces, shard logs, screenshots)
- `QA_HISTORY_DB_PATH` = `$QA_EVIDENCE_ROOT/qa-history.sqlite` — the run index behind the runs list
- `QA_STORY_SCREENSHOTS_ROOT` = `tests/e2e/screenshots/` — curated UI gallery, **tracked in git**, ships with the code deploy (not via the evidence upload)

## API surface (`/api/qa/*`)

`runs` (history list) · `run` + `run/perf` (one run detail + perf) · `artifact?runId=&path=` (serves a file from a run dir; videos/traces/logs) · `stories` + `story-image?source=&path=` (gallery: `e2e-screenshots` from the tracked root, `qa-run` from run dirs) · `catalog` · `history` (+ `history/backfill`) · `retention` · `restart` / `restart/abort` / `restart-audit` (admin). The API reads files at request time, so an uploaded DB/run appears with **no server restart**.

All read-only QA routes are public. Only mutating maintenance actions require `XLN_QA_ADMIN_TOKEN`; supplying an invalid token fails instead of silently downgrading access.

## UI sections

Evidence Summary · Evidence Playlist + Artifacts Below Playback · Application Screens (curated gallery) · All Test Surfaces · Deterministic Scenarios · Canonical Ledger · Failure Inbox (triage by failure class) · Browser Health · Benchmarks · Maintenance (backfill / retention / restart).

## Generate + publish evidence

1. Run e2e locally to produce artifacts under `.logs/e2e-parallel/<runId>/` and append to the history DB:
   - `bun run test:e2e:full` (full suite, `video=retain-on-failure`)
   - `bun run test:e2e:release` (release gate)
   - For green-pass videos use `--video=on` (passing tests retain no video under `retain-on-failure`).
2. Publish to prod, decoupled from code deploy:
   - `bun run deploy:qa` (latest run + history DB), or `deploy:qa --run <id>` / `--latest N` / `--db-only` / `--dry-run`
   - Script: `scripts/deploy-qa-evidence.sh` (rsync over ssh to `/root/xln-qa-evidence`).

## Notes

- Evidence survives `deploy.sh --fresh` because the prod root is outside the `/root/xln` checkout.
- Curated screenshots deploy with code; videos/run artifacts deploy with `deploy:qa`.
- Videos exist only for **failed** runs under `retain-on-failure`.

# qa cockpit

QA tooling browses development evidence: run history, per-run artifacts, screenshots,
performance measurements and failure triage. All execution belongs to the development
stand. The financial production servers do not mount `/api/qa/*`.

Health links to revision-specific repository evidence and the statically generated
`/qa/quorum` review history. The retained `/qa`, `/qa/hlt` and `/runs` interfaces still
require the separate QA API; direct visits on the public financial host currently fail.
Their fixture-backed browser tests establish UI behavior, not public API availability.
Uploading files with `deploy:qa` does not install an API or make those interfaces live.

## Where

- Cockpit route: `frontend/src/routes/qa/+page.svelte` (QA API required)
- Run drill-down: `frontend/src/routes/runs/+page.svelte` (QA API required)
- API client: `frontend/src/lib/qa/apiClient.ts`
- Backend: `core/qa/api.ts` (HTTP routes) + `core/qa/report.ts` (data model, history DB, scanners)

## Storage layout

Defined in `core/qa/report.ts`. Roots derive from `QA_EVIDENCE_ROOT` (default `./.logs`; prod = `/root/xln-qa-evidence`, set by `scripts/operations/start-server.sh` via checkout-path detection so it lives **outside** the git checkout that `bun run deploy` hard-resets):

- `QA_LOGS_ROOT` = `$QA_EVIDENCE_ROOT/e2e-parallel/<runId>/` — per-run artifacts (videos, traces, shard logs, screenshots)
- `QA_HISTORY_DB_PATH` = `$QA_EVIDENCE_ROOT/qa-history.sqlite` — the run index behind the runs list
- `QA_STORY_SCREENSHOTS_ROOT` = `tests/e2e/screenshots/` — curated UI gallery, **tracked in git**, ships with the code deploy (not via the evidence upload)

## API surface (`/api/qa/*`)

`runs` (history list) · `run` + `run/perf` (one run detail + perf) · `artifact?runId=&path=` (serves a file from a run dir; videos/traces/logs) · `stories` + `story-image?source=&path=` (gallery: `e2e-screenshots` from the tracked root, `qa-run` from run dirs) · `catalog` · `history` (+ `history/backfill`) · `retention` · `restart` / `restart/abort` / `restart-audit` (admin). These describe the standalone tooling handler, not endpoints on the financial host.

When a dedicated QA handler is hosted, read-only routes and authenticated maintenance
follow `core/qa/api.ts`. It is intentionally absent from financial production startup.
Only mutating maintenance actions require `XLN_QA_ADMIN_TOKEN`; supplying an invalid
token fails instead of silently downgrading access.

## UI sections

Evidence Summary · Evidence Playlist + Artifacts Below Playback · Application Screens (curated gallery) · All Test Surfaces · Deterministic Scenarios · Canonical Ledger · Failure Inbox (triage by failure class) · Browser Health · Benchmarks · Maintenance (backfill / retention / restart).

## Generate + publish evidence

1. Run e2e locally to produce artifacts under `.logs/e2e-parallel/<runId>/` and append to the history DB:
   - `bun run test:e2e:full` (full suite, `video=retain-on-failure`)
   - `bun run test:e2e:release` (release gate)
   - For green-pass videos use `--video=on` (passing tests retain no video under `retain-on-failure`).
2. Publish to prod, decoupled from code deploy:
   - `bun run deploy:qa` (latest run + history DB), or `deploy:qa --run <id>` / `--latest N` / `--db-only` / `--dry-run`
   - Script: `scripts/deployment/deploy-qa-evidence.sh` (rsync over ssh to `/root/xln-qa-evidence`).

## Notes

- Evidence survives `bun run deploy:fresh` because the prod root is outside the `/root/xln` checkout.
- Curated screenshots deploy with code; videos/run artifacts deploy with `deploy:qa`.
- Videos exist only for **failed** runs under `retain-on-failure`.

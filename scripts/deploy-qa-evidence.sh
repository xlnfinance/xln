#!/usr/bin/env bash
# Publish local QA run evidence (per-run artifacts + the history DB) to the prod
# persistent QA evidence root. This is DECOUPLED from the code deploy: heavy videos are
# generated on the local Mac and rsynced up, so the server never runs e2e itself.
#
# Curated story screenshots (tests/e2e/screenshots) are tracked in git and ship via
# deploy.sh — they are intentionally NOT handled here.
#
# The prod runtime reads this root via QA_EVIDENCE_ROOT (see scripts/start-server.sh),
# so uploaded runs/videos appear at https://xln.finance/qa without restarting anything.
#
# Usage:
#   ./scripts/deploy-qa-evidence.sh [--remote host] [--evidence-root path]
#                                   [--run ID]... [--latest N] [--db-only] [--dry-run]
#
# Defaults: --remote root@xln.finance, --evidence-root /root/xln-qa-evidence.
# With no --run/--latest, the single most recent local run is published.
set -euo pipefail

REMOTE_HOST="root@xln.finance"
REMOTE_ROOT="/root/xln-qa-evidence"
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LOCAL_ROOT="${QA_EVIDENCE_ROOT:-$REPO_ROOT/.logs}"
RUNS=()
LATEST=0
DB_ONLY=0
DRY_RUN=0

while [ $# -gt 0 ]; do
  case "$1" in
    --remote) REMOTE_HOST="${2:?--remote needs a value}"; shift 2;;
    --evidence-root) REMOTE_ROOT="${2:?--evidence-root needs a value}"; shift 2;;
    --local-root) LOCAL_ROOT="${2:?--local-root needs a value}"; shift 2;;
    --run) RUNS+=("${2:?--run needs an id}"); shift 2;;
    --latest) LATEST="${2:?--latest needs a count}"; shift 2;;
    --db-only) DB_ONLY=1; shift;;
    --dry-run) DRY_RUN=1; shift;;
    -h|--help) sed -n '2,18p' "$0"; exit 0;;
    *) echo "[qa-evidence] unknown arg: $1" >&2; exit 2;;
  esac
done

SRC_RUNS="$LOCAL_ROOT/e2e-parallel"
DB_PATH="$LOCAL_ROOT/qa-history.sqlite"

if [ "$DB_ONLY" = "0" ]; then
  if [ "$LATEST" -gt 0 ]; then
    while IFS= read -r d; do [ -n "$d" ] && RUNS+=("$d"); done < <(ls -1t "$SRC_RUNS" 2>/dev/null | head -n "$LATEST")
  fi
  if [ "${#RUNS[@]}" -eq 0 ]; then
    latest="$(ls -1t "$SRC_RUNS" 2>/dev/null | head -n1)"
    [ -n "$latest" ] && RUNS+=("$latest")
  fi
fi

rsync_opts=(-az --partial --progress)
[ "$DRY_RUN" = "1" ] && rsync_opts+=(--dry-run)

echo "[qa-evidence] remote=$REMOTE_HOST root=$REMOTE_ROOT"
echo "[qa-evidence] local=$LOCAL_ROOT runs=[${RUNS[*]:-}] db_only=$DB_ONLY dry_run=$DRY_RUN"

ssh "$REMOTE_HOST" "mkdir -p '$REMOTE_ROOT/e2e-parallel'"

# History DB (+ WAL/SHM sidecars if present) — this is the index behind /api/qa/runs.
if [ -f "$DB_PATH" ]; then
  echo "[qa-evidence] uploading history DB ($(du -h "$DB_PATH" | cut -f1))"
  for f in "$DB_PATH" "$DB_PATH-wal" "$DB_PATH-shm"; do
    [ -f "$f" ] && rsync "${rsync_opts[@]}" "$f" "$REMOTE_HOST:$REMOTE_ROOT/$(basename "$f")"
  done
else
  echo "[qa-evidence] WARN: no history DB at $DB_PATH (runs list will stay empty)" >&2
fi

# Per-run artifact dirs (logs, screenshots, traces, videos).
for r in "${RUNS[@]:-}"; do
  [ -z "$r" ] && continue
  if [ ! -d "$SRC_RUNS/$r" ]; then
    echo "[qa-evidence] WARN: missing local run $r" >&2
    continue
  fi
  echo "[qa-evidence] uploading run $r ($(du -sh "$SRC_RUNS/$r" | cut -f1))"
  rsync "${rsync_opts[@]}" "$SRC_RUNS/$r" "$REMOTE_HOST:$REMOTE_ROOT/e2e-parallel/"
done

echo "[qa-evidence] done."
echo "[qa-evidence] verify: curl -s 'https://xln.finance/api/qa/runs?limit=5'"

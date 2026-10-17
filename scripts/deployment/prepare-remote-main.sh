#!/usr/bin/env bash
# Inlined by deploy-platform.sh before installing artifacts or restarting services.
# Never discard local source or replace the operator's configured Git remote.
set -eu

: "${EXPECTED_DEPLOY_SHA:?REMOTE_DEPLOY_HEAD_REQUIRED}"
case "$EXPECTED_DEPLOY_SHA" in
  *[!0-9a-f]*|'') echo 'REMOTE_DEPLOY_HEAD_INVALID' >&2; exit 1 ;;
esac
[ "${#EXPECTED_DEPLOY_SHA}" = 40 ] || { echo 'REMOTE_DEPLOY_HEAD_INVALID' >&2; exit 1; }

assert_remote_main_clean() {
  [ "$(git rev-parse --show-toplevel)" = "$(pwd -P)" ] || {
    echo 'REMOTE_DEPLOY_REPOSITORY_ROOT_INVALID' >&2; exit 1;
  }
  [ "$(git symbolic-ref --quiet --short HEAD)" = main ] || {
    echo 'REMOTE_DEPLOY_REQUIRES_MAIN' >&2; exit 1;
  }
  remote_index_entries="$(git ls-files -v)" || {
    echo 'REMOTE_DEPLOY_INDEX_UNREADABLE' >&2; exit 1;
  }
  if printf '%s\n' "$remote_index_entries" | LC_ALL=C grep -Eq '^[a-zS] '; then
    echo 'REMOTE_DEPLOY_HIDDEN_INDEX_PATHS' >&2; exit 1
  fi
  remote_worktree_status="$(git status --porcelain=v1 --untracked-files=all)" || {
    echo 'REMOTE_DEPLOY_STATUS_UNREADABLE' >&2; exit 1;
  }
  [ -z "$remote_worktree_status" ] || {
    echo 'REMOTE_DEPLOY_DIRTY_SOURCE' >&2; exit 1;
  }
}

assert_remote_main_clean
git fetch --no-tags origin main
git cat-file -e "$EXPECTED_DEPLOY_SHA^{commit}"
git merge-base --is-ancestor "$EXPECTED_DEPLOY_SHA" FETCH_HEAD || {
  echo 'REMOTE_DEPLOY_HEAD_NOT_PUBLISHED' >&2; exit 1;
}
git merge-base --is-ancestor HEAD "$EXPECTED_DEPLOY_SHA" || {
  echo 'REMOTE_DEPLOY_NON_FAST_FORWARD' >&2; exit 1;
}
assert_remote_main_clean
# Ignored credentials can collide with a newly tracked path. Git's default merge
# overwrites ignored files; explicitly refuse that collision without moving HEAD.
git -c merge.autostash=false merge --ff-only --no-overwrite-ignore "$EXPECTED_DEPLOY_SHA"
assert_remote_main_clean
[ "$(git rev-parse HEAD)" = "$EXPECTED_DEPLOY_SHA" ] || {
  echo 'REMOTE_DEPLOY_HEAD_CHANGED' >&2; exit 1;
}

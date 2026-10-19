#!/usr/bin/env bash
# One current web artifact: landing/observer plus the canonical hosted React wallet.
set -euo pipefail

mode="${1:?WEB_ARTIFACT_MODE_REQUIRED}"
archive="${2:?WEB_ARTIFACT_ARCHIVE_REQUIRED}"

validate_web_builds() {
  local root="$1" file bundle links
  for file in frontend/build/index.html ui/dist/index.html \
    frontend/build/runtime.js frontend/build/account-worker.js \
    ui/dist/runtime.js ui/dist/account-worker.js; do
    [ -s "$root/$file" ] || { echo "WEB_ARTIFACT_MISSING:$file" >&2; return 1; }
  done
  for bundle in runtime.js account-worker.js; do
    cmp -s "$root/frontend/build/$bundle" "$root/ui/dist/$bundle" || {
      echo "WEB_ARTIFACT_RUNTIME_MISMATCH:$bundle" >&2; return 1;
    }
  done
  links="$(find "$root/frontend/build" "$root/ui/dist" -type l -print -quit)" || return 1
  [ -z "$links" ] || {
    echo 'WEB_ARTIFACT_SYMLINK_FORBIDDEN' >&2; return 1;
  }
}

validate_archive_paths() {
  tar -tzf "$archive" | while IFS= read -r file; do
    case "/$file/" in
      *'/../'*|*'/./'*|*'\'*) echo "WEB_ARTIFACT_PATH_INVALID:$file" >&2; exit 1 ;;
    esac
    case "$file" in
      frontend/build|frontend/build/*|ui/dist|ui/dist/*) ;;
      *) echo "WEB_ARTIFACT_PATH_INVALID:$file" >&2; exit 1 ;;
    esac
  done
  tar -tvzf "$archive" | while IFS= read -r entry; do
    case "$entry" in
      [-d]*) ;;
      *) echo 'WEB_ARTIFACT_LINK_OR_SPECIAL_FILE_FORBIDDEN' >&2; exit 1 ;;
    esac
  done
}

case "$mode" in
  pack)
    validate_web_builds "$PWD"
    COPYFILE_DISABLE=1 tar -czf "$archive" frontend/build ui/dist
    ;;
  install)
    validate_archive_paths
    stage="$(mktemp -d "$PWD/.xln-web-install.XXXXXX")"
    trap 'rm -rf "$stage"' EXIT
    tar -xzf "$archive" -C "$stage"
    validate_web_builds "$stage"
    # These validated trees contain public assets only. A private build umask
    # must not make the installed site unreadable to the web server.
    find "$stage/frontend/build" "$stage/ui/dist" -type d -exec chmod 755 {} +
    find "$stage/frontend/build" "$stage/ui/dist" -type f -exec chmod 644 {} +
    # Reject incomplete/old artifacts before replacing either generated build.
    mkdir -p frontend ui
    rm -rf frontend/build ui/dist
    mv "$stage/frontend/build" frontend/build
    mv "$stage/ui/dist" ui/dist
    ;;
  *) echo "WEB_ARTIFACT_MODE_INVALID:$mode" >&2; exit 1 ;;
esac

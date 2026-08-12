#!/usr/bin/env bash

set -euo pipefail

readonly FORGE_STD_REPOSITORY='https://github.com/foundry-rs/forge-std.git'
readonly FORGE_STD_COMMIT='8e40513d678f392f398620b3ef2b418648b33e89'
readonly SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
readonly JURISDICTIONS_DIR="$(cd -- "$SCRIPT_DIR/.." && pwd -P)"
readonly FORGE_STD_DIR="$JURISDICTIONS_DIR/lib/forge-std"

fail() {
  printf '%s\n' "$1" >&2
  exit 1
}

verify_forge_std_checkout() {
  local checkout_dir="$1"
  [ -d "$checkout_dir" ] || fail "FORGE_STD_CHECKOUT_MISSING:$checkout_dir"
  [ ! -L "$checkout_dir" ] || fail "FORGE_STD_CHECKOUT_SYMLINK_FORBIDDEN:$checkout_dir"
  [ -e "$checkout_dir/.git" ] || fail "FORGE_STD_CHECKOUT_UNVERIFIABLE:$checkout_dir"
  git -C "$checkout_dir" rev-parse --is-inside-work-tree >/dev/null 2>&1 ||
    fail "FORGE_STD_CHECKOUT_UNVERIFIABLE:$checkout_dir"

  local checkout_root
  checkout_root="$(git -C "$checkout_dir" rev-parse --show-toplevel 2>/dev/null)" ||
    fail "FORGE_STD_CHECKOUT_UNVERIFIABLE:$checkout_dir"
  [ "$checkout_root" = "$checkout_dir" ] || fail "FORGE_STD_CHECKOUT_ROOT_MISMATCH:$checkout_dir:$checkout_root"

  local origin_url
  origin_url="$(git -C "$checkout_dir" remote get-url origin 2>/dev/null)" ||
    fail "FORGE_STD_ORIGIN_UNVERIFIABLE:$checkout_dir"
  [ "$origin_url" = "$FORGE_STD_REPOSITORY" ] ||
    fail "FORGE_STD_ORIGIN_MISMATCH:expected=$FORGE_STD_REPOSITORY actual=$origin_url"

  local head
  head="$(git -C "$checkout_dir" rev-parse --verify 'HEAD^{commit}' 2>/dev/null)" ||
    fail "FORGE_STD_HEAD_UNVERIFIABLE:$checkout_dir"
  [ "$head" = "$FORGE_STD_COMMIT" ] ||
    fail "FORGE_STD_HEAD_MISMATCH:expected=$FORGE_STD_COMMIT actual=$head"

  git -C "$checkout_dir" diff --quiet --ignore-submodules -- ||
    fail "FORGE_STD_TRACKED_WORKTREE_DIRTY:$checkout_dir"
  git -C "$checkout_dir" diff --cached --quiet --ignore-submodules -- ||
    fail "FORGE_STD_TRACKED_INDEX_DIRTY:$checkout_dir"
  local untracked
  untracked="$(git -C "$checkout_dir" ls-files --others --exclude-standard)"
  [ -z "$untracked" ] || fail "FORGE_STD_UNTRACKED_FILES:$checkout_dir"
}

install_forge_std_checkout() {
  local parent_dir temporary_dir
  parent_dir="$(dirname -- "$FORGE_STD_DIR")"
  mkdir -p "$parent_dir"
  temporary_dir="$(mktemp -d "$parent_dir/.forge-std.XXXXXXXX")"
  trap 'rm -rf -- "$temporary_dir"' EXIT

  git -C "$temporary_dir" init --quiet
  git -C "$temporary_dir" remote add origin "$FORGE_STD_REPOSITORY"
  git -C "$temporary_dir" fetch --quiet --depth 1 origin "$FORGE_STD_COMMIT"
  git -C "$temporary_dir" checkout --quiet --detach "$FORGE_STD_COMMIT"
  verify_forge_std_checkout "$temporary_dir"
  [ ! -e "$FORGE_STD_DIR" ] || fail "FORGE_STD_INSTALL_TARGET_APPEARED:$FORGE_STD_DIR"
  mv -- "$temporary_dir" "$FORGE_STD_DIR"
  trap - EXIT
}

main() {
  if [ -e "$FORGE_STD_DIR" ] || [ -L "$FORGE_STD_DIR" ]; then
    verify_forge_std_checkout "$FORGE_STD_DIR"
  else
    install_forge_std_checkout
  fi
  printf 'FORGE_STD_READY:%s\n' "$FORGE_STD_COMMIT"
}

main "$@"

#!/usr/bin/env bash
# Put uv and ast-grep on PATH for the gate (rules/ calls `ast-grep`; style/check.ts runs the same version through uvx).
#   bash .github/scripts/setup-ast-grep.sh uv==0.8.17 ast-grep-cli==0.45.3
# The workflow restores ~/.local, ~/.cache/uv and pipx's venvs from the CI cache first. What the cache restored is used when it
# runs (uvx finds the pinned ast-grep without the network); otherwise each install is retried, because PyPI timing out once
# must not turn a lane red.
set -euo pipefail
readonly UV_SPEC="${1:?usage: setup-ast-grep.sh uv==<version> ast-grep-cli==<version>}"
readonly AST_GREP_SPEC="${2:?usage: setup-ast-grep.sh uv==<version> ast-grep-cli==<version>}"
readonly RETRY="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)/retry.sh"

works() {
  command -v ast-grep >/dev/null 2>&1 && uvx --offline --from "$AST_GREP_SPEC" ast-grep --version >/dev/null 2>&1
}

if works; then
  echo "setup-ast-grep.sh: $AST_GREP_SPEC already in place (cache)"
  exit 0
fi
bash "$RETRY" pipx install --force "$UV_SPEC"
bash "$RETRY" uv tool install --force "$AST_GREP_SPEC"
uvx --from "$AST_GREP_SPEC" ast-grep --version

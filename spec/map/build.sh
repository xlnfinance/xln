#!/bin/sh
# Build the Scheme parser ast-grep loads from spec/map/sgconfig.yml.
# The pin is 6cdh/tree-sitter-scheme. It parses lists and symbols, not bindings.
# A name search reports spellings. It does not say two defines are the same variable.
set -eu
pin=1b112d9571e4f62fb3d095d52a51f1da7756fb94
dest=$(CDPATH= cd -- "$(dirname "$0")" && pwd)
src=$(mktemp -d)
trap 'rm -rf "$src"' EXIT
git -C "$src" init -q
git -C "$src" remote add origin https://github.com/6cdh/tree-sitter-scheme.git
git -C "$src" fetch -q --depth 1 origin "$pin"
git -C "$src" checkout -q FETCH_HEAD
got=$(git -C "$src" rev-parse HEAD)
if [ "$got" != "$pin" ]; then
  echo "grammar pin mismatch: $got" >&2
  exit 1
fi
cc -dynamiclib -O2 -I "$src/src" -o "$dest/libtree-sitter-scheme.dylib" "$src/src/parser.c"
echo "$dest/libtree-sitter-scheme.dylib"

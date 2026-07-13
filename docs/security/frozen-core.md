# Frozen Core Integrity

**Status:** Normative for release `0.1.7` and later.

The frozen core is an explicitly selected set of files whose exact bytes and
executable modes must remain stable. It is separate from the general codebase
snapshot and intentionally starts with only `runtime/runtime.ts`.

## Hashing

- File content uses SHA-256 over raw bytes without newline normalization.
- A leaf commits to its normalized repository path, Git-compatible executable
  mode, and content hash under domain `xln:frozen-core:leaf:v1`.
- Directory hashes commit to sorted child names, types, and hashes under domain
  `xln:frozen-core:directory:v1`.
- Symlinks and paths outside the repository are rejected.

## Gate

`bun run frozen-core:check` is part of source checks and runs again at the end
of every release-gate profile. A mismatch fails closed with the expected and
actual hashes. Dependency-boundary findings are warnings: they identify mutable
imports that can alter behavior without changing a frozen file.

## Approval

Only the project owner may run `bun run frozen-core:approve`. The command has no
non-interactive mode. Approval records preserve old/new hashes, release,
timestamp, and comment. Release history renders either `UNCHANGED` or
`APPROVED CHANGE`.

The owner can temporarily change the boundary with
`bun run frozen-core:remove -- <path>` and restore it with
`bun run frozen-core:add -- <path>`. Both commands require an interactive TTY
and an explicit confirmation. The manifest retains each policy change with the
file hash, release, timestamp, and reason; removing a file never erases its
approval history.

When the manifest contains exactly one frozen file,
`bun run frozen-core:remove` selects it automatically.

## Foundation Release Hanko

Signed releases use the exact `EntityProvider.HankoBytes` ABI: placeholders,
packed secp256k1 R/S values with V bits, and a board claim. The release envelope
commits to version, Git commit, complete code snapshot root, frozen-core root,
and generation time under domain `xln:foundation-release:v1`.

The initial board is a temporary random 2-of-3 lazy entity. Private keys remain
outside the repository. A future registered xln Foundation entity can replace
the temporary board without changing the envelope or Hanko format.

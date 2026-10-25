# Git finalization 2026-10-25: historical drafts

HISTORICAL, NON-EXECUTABLE EVIDENCE. Nothing in this folder is applied, imported or
tested. These drafts predate the current canonical implementation on `main`; do not
apply them over it. They exist so that clearing the local stash list and retiring the
last task worktree/branch loses no source bytes.

## What is here

- One `stash-NN-<commit>.patch` per non-empty stash entry: tracked worktree diff against
  the stash base, then the untracked files of that entry as new files.
- `retired-perf-1000tps-commits.patch`: the 8 commits of the retired
  `perf/1000tps` branch that never reached `main` (base of `stash@{6}`), as a mail series.
- `retired-phase064-split-worktree.patch`: the retired detached split worktree at
  `4e1c9a60`: an ABI-independent split experiment that measured no gain (35.8 s vs
  36.3 s, n=1) and was not integrated by design, plus its untracked test as a new file.
- `manifest.json`: commits, parents, dates, SHA-256 of every published patch and of
  every privately retained excluded file.

## Verification

Each stash patch was applied with a temporary index to its exact base commit in a private
bare archive; the written tree equals the stash tree (or its untracked tree) except the
explicitly excluded paths below. The split-worktree patch applies cleanly to `4e1c9a60`.

## Excluded from publication (kept private, referenced by hash)

Generated bundles/artifacts (`ui/public/runtime.js`, `frontend/static/account-worker.js`,
`frontend/static/contracts/Depository.json`) and local editor state
(`.obsidian/workspace.json`). The complete stash commits, byte-exact, are retained in the
private bundle `xln-claude-e2e-20261023/opus-mainnet-closure-sequence-20261024/phase-105/stash-preserve/all-stashes.bundle` (SHA-256
`89f34532f43cfc6bdc397d77e6259523eb37679427870411dee58b4b8745c4a4`) under the agent job directory.

## Entries

| Stash | Commit | Date | Subject | Published file | Excluded |
|---|---|---|---|---|---|
| `stash@{0}` | `399fd47cf11b` | 2026-10-14 | On main: preserve old-main protected files already present on a57f633e9 | stash-00-399fd47cf11b.patch | - |
| `stash@{1}` | `724e33c3c543` | 2026-10-12 | On main: pending P6 preserved during modal regression fix 20261012 | stash-01-724e33c3c543.patch | - |
| `stash@{2}` | `0ab9323b363a` | 2026-10-12 | On main: unfinished React file recovery UI pending E2E 20261012 | stash-02-0ab9323b363a.patch | - |
| `stash@{3}` | `2f29e3383e69` | 2026-10-12 | On main: pending P6 watchtower decoder OS protection approval 20261012 | stash-03-2f29e3383e69.patch | - |
| `stash@{4}` | `438bf1a6ddd8` | 2026-10-12 | On main: park: owner-frozen Rust and lending parity changes 2026-10-12 | stash-04-438bf1a6ddd8.patch | - |
| `stash@{5}` | `014283aade42` | 2026-10-08 | On main: xln owner-requested origin-main integration 2026-10-08 | stash-05-014283aade42.patch | frontend/static/account-worker.js |
| `stash@{6}` | `6de7e55cfec4` | 2026-08-20 | On perf/1000tps: wip-cancel-failfast | stash-06-6de7e55cfec4.patch | - |
| `stash@{7}` | `27ac56281b4f` | 2026-08-04 | On cursor/ws-direct-handshake-hello-71e9: temp-unrelated | stash-07-27ac56281b4f.patch | ui/public/runtime.js |
| `stash@{8}` | `f7d566c21283` | 2026-07-30 | On main: preserve-claude-graph-before-runtime-merge-20260730 | stash-08-f7d566c21283.patch | frontend/static/contracts/Depository.json |
| `stash@{9}` | `d971ee852f80` | 2026-07-25 | On main: user deploy-contracts confirmations before v0.1.28 fast-forward | stash-09-d971ee852f80.patch | - |
| `stash@{10}` | `ff1354747127` | 2026-07-19 | On main: pre-merge dependency updates included in xln 0.1.10 | stash-10-ff1354747127.patch | - |
| `stash@{11}` | `932d28fffa31` | 2026-06-19 | On main: deploy-untracked-ai-cookbook | (empty, nothing to publish) | - |
| `stash@{12}` | `bbb422bb6077` | 2026-06-19 | On main: deploy-timestamp-jurisdictions | stash-12-bbb422bb6077.patch | - |
| `stash@{13}` | `a1adb3fba623` | 2025-12-10 | WIP on main: 710dcc1 debug(graph3d): add comprehensive entity click logging | stash-13-a1adb3fba623.patch | .obsidian/workspace.json |

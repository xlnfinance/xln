---
reviewer: codex
date: 2026-02-12
branch_reviewed: codex/remove-insurance-fix
status: approved_with_notes
---

# Codex Review - Remove Insurance

## Verdict
Ready for multi-agent review after applying Codex fix commits.

## Completed by Codex
- Removed remaining runtime insurance API surface from adapters and batch plumbing.
- Renamed BrowserVM method `settleWithInsurance` -> `settle` and updated callsites.
- Removed stale insurance ABI/events from `runtime/evm.ts`.
- Removed obsolete insurance debug helper usage in `runtime/scripts/test-hanko-debug.ts`.
- Cleaned remaining frontend mock insurance fields in `StorageInspector.svelte`.
- Fixed Solidity parser error in `jurisdictions/contracts/Account.sol` (trailing comma in settlement message encoding).

## Verification
- `rg` sweep over `jurisdictions/contracts`, `runtime`, and `frontend/src/lib` (excluding generated `runtime/typechain`) found **0** insurance references.
- `bun run check:src` passes.
- `cd jurisdictions && bun run compile` passes.

## Notes
- Generated files in `runtime/typechain/*` still contain historical insurance types/events and were not regenerated in this pass.
- Codex fix branch pushed: `origin/codex/remove-insurance-fix`
- Commits:
  - `47143418` `fix: finish insurance cleanup across runtime adapters`
  - `b8a59754` `fix: repair account settle encoding after insurance removal`

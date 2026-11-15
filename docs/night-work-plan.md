# Current xln execution handoff

## Current SHA

- Verification base: `33412633535326c29d72168f6c0acc5848f77419`, owner-approved `testnets_deploy`. The cleanup candidate was checked with a dirty tree; the report retains that original identity. Resolve a later scoped commit with `git rev-parse HEAD`.
- `main`: `019d45beb5954e77fe806d643845f6a4dca4fa82`, unchanged. Apply the [owner-approved execution exceptions](deployment/ignition-stack-design.md#owner-approved-execution-exceptions).
- All 588 covered source/configuration hashes remained identical throughout the final profile. Documentation-only finalization followed; no clean-tree release is claimed.
- Both earlier public reserve roundtrips remain complete. Their original execution identities and public receipts are unchanged; see the [operator guide](deployment/usdc-reserve-roundtrip.md). No new public financial operation occurred.

## Last green command

```sh
bun run check:deployment
```

**6/6 gates passed**: artifact parity, strict deployment types, scoped lint,
**274 Hardhat tests**, **64 Foundry checks / 7 suites**, and **146 Bun tests /
3,731 assertions / 30 files**. All native interruption cuts passed. The native
gate took **1,050.045 s**; the six measured gates totalled **1,145.804 s**.
All 588 source/configuration hashes were stable, all 181 compiler artifact
hashes matched the baseline, and approved lint debt stayed unchanged.

Before the profile, owning filesystem/child-process regressions passed
**21 tests / 86 assertions**. The exact report-parent substitution probe
preserved the foreign result. Two existing local Anvil scenarios then passed
**153 assertions in 27.94 s**, proving both allocator families use the owned
run directory and cleanup removes it after success.

## First red command/error

None in the selected cleanup scope. The final profile exited zero with
`passed: true`, `failure: null`, `fixtureEvidence.status: removed`.
Direct focused tests retain their previous lifetime; broader product gates
remain separate.

## Artifact path

- [Final profile result](evidence/deployment-check/2026-11-15T17-06-34.478Z-89550-xQMyi9/result.json): seven compact result/log files, **360,978 bytes**. Its `fixtures/` subtree is absent.
- [Representative local result](evidence/deployment-check/cleanup-representative-20261115-CTjJwz/result.json): both `case-*` and `fresh-*` observed, then removed; the old shared fixture parent was not created.
- Owning implementation: `tools/deployment/test-evidence.ts`; [retention policy](deployment/ignition-stack-design.md#local-fixture-retention).
- All **1,293** baseline evidence/owner files are unchanged, including public deployment journals, USDC receipts, existing tracked reports, `todo.md` and unrelated owner work. The stand is free.

## Next single command

```sh
git status --short
```

Inspect remaining generated evidence and unrelated owner edits after the
owner-selected scoped commit. Its six code/configuration/test files match the
checked candidate; two documentation files describe the completed work.
Generated local/public evidence remains excluded from source commits. No push
or additional financial operation is requested.

## Remaining final gates

- None outstanding for this deployment-profile cleanup candidate. Keep its executable/configuration/test contents unchanged when preparing a commit; changed executable contents require owning checks and the applicable profile again.
- Explicit keep, failed/interrupted/timed-out outcomes and foreign-directory protection are covered by owning regressions. Existing evidence is never swept retrospectively.
- Direct focused runs, shared runner changes, `verify`/pre-push profile selection, Cross-J, browser/UI and whole-product/mainnet acceptance remain separate work.

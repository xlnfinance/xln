# Current xln execution handoff

## Current SHA

- Verified parent: `10a46045b797bcc1ea67bc83737fa5c326ee85c0`, owner-approved `testnets_deploy`. This handoff accompanies the checked folder-layout commit; resolve its resulting SHA with `git rev-parse HEAD`.
- `main`: `019d45beb5954e77fe806d643845f6a4dca4fa82`, unchanged. Apply the [owner-approved execution exceptions](deployment/ignition-stack-design.md#owner-approved-execution-exceptions).
- The five previously over-wide directories now satisfy the unchanged limit of ten direct source files. No debt allowance or gate was weakened. The local hook remains installed. No real push, public deployment, financial operation or dependency update occurred.

## Last green command

```sh
bun run check:deployment
```

**6/6 gates passed** under one stand lock: artifacts, strict types, lint, Hardhat, Foundry invariants and native scenarios. The native stage passed **148 tests / 3739 assertions / 31 files** in 1062.56 s. Its 22 interruption and 8 writing cases passed; the profile removed its own successful fixtures and retained its compact report/logs.

All 21 standalone test files and five verification test files are retained. Recursive discovery preserves the previous basename sequence. Independent read-only review checked 193 relative imports and unchanged financial assertions, deadlines, payloads and Future IDs. The existing artifact-publication test was aligned with the current bracket-form environment access and still checks private output plus atomic publication; its exact rerun passed 2 tests / 16 assertions.

`check:folder-width` and `frozen-core:check` passed. Strict deployment and verification typechecking and lint passed; canonical ESLint debt is unchanged. No Solidity, ABI, bytecode or TypeChain content changed.

## First red command/error

The preceding full verification at the parent failed on five folder-width violations. Those violations are corrected. Full `verify` on the resulting clean commit is the next publication gate; no whole-repository green result is claimed here. The separate UI issue remains open.

## Artifact path

- [Deployment profile result](evidence/deployment-check/2026-11-15T22-22-24.950Z-65377-5MYXjb/result.json): original verification-time parent SHA and dirty status remain unchanged. All 590 covered source/configuration hashes were stable before/after; its 181 artifact hashes match the preserved baseline. Match covered contents when relating this result to the layout commit.
- [Prior full verification failure](evidence/deployment-check/pre-publication-20261116-3ksbhcb2/result.json).
- Move map, frozen candidate, focused logs and review metadata: `/private/tmp/xln-folder-layout-20261116-d9kebupy/`.
- Existing public deployment journals, sealed artifacts, original receipts and unrelated owner files remain untouched. Historical source inventories still resolve using their original SHA.

## Next single command

```sh
bun run verify
```

Run on the clean layout commit before publication. This branch contains broader changes, so its publication verification uses the full profile. A source-clean admission alone is not a passing suite.

## Remaining final gates

- Repeat full verification on the clean layout commit. Diagnose its first remaining failure without automatically expanding this deployment task into UI or unrelated repairs.
- Actual publication still requires the owner's instruction. Whole-product/mainnet acceptance, Cross-J, separate UI work and optional manual-CI profile selection retain their own gates.

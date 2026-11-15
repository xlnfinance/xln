# Current xln execution handoff

## Current SHA

- Verified parent: `514ddbd5f86173d332bfb87998db9e5930f5f006`, owner-approved `testnets_deploy`. This handoff accompanies the approved verification-profile commit; resolve its resulting SHA with `git rev-parse HEAD`. All eight executable source/test hashes match the checked candidate.
- `main`: `019d45beb5954e77fe806d643845f6a4dca4fa82`, unchanged. Apply the [owner-approved execution exceptions](deployment/ignition-stack-design.md#owner-approved-execution-exceptions).
- The local hook is installed as `core.hooksPath=.githooks`. No real project push, PR or public financial operation occurred in this step.

## Last green command

```sh
bun run stand:run --reason verification-profiles-types-regression --timeout-ms 60000 -- \
  bun test ./scripts/verification/profile.test.ts \
  ./scripts/verification/profile-push.test.ts \
  ./scripts/verification/verification.test.ts \
  ./scripts/verification/source-scope.test.ts \
  ./scripts/verification/process.test.ts \
  ./tools/checks/check-environment.test.ts
```

**83 tests / 291 assertions / 6 files / 10.68 s**, zero failures. Actual hooks and
Git pushes ran only against temporary local bare remotes. These tests exercise
selection/control using real fixture commands; they do not rerun the financial
suites or establish public-network readiness.
Strict scoped typechecking and ESLint passed for all twelve verification
source/test files, with zero lint findings or approved debt rows. The shared-schema
regression requires full verification even when generated artifacts change
alongside it. Independent read-only review confirmed this boundary. Existing
process timeout/cleanup tests retain their deadlines and assertions. The initial
sandbox run could not invoke `ps`; its exact orphan group was stopped, then the
same checks passed with process inspection permitted.

## First red command/error

The installed hook correctly rejects the current checkout with
`VERIFY_DIRTY_SOURCE` before launching suites. After committing the owned paths,
the unrelated `public-proof-smoke.ts` edit and Svelte tracker file remain.
No source exception was added. A read-only comparison of the 165 committed paths
against `main` selects full verification; the branch includes broader changes.
The inherited `AGENTS.md` formatting finding remains outside this change.

## Artifact path

- [Profile selection and budgets](../scripts/verification/profile.ts); [operator documentation](deployment/ignition-stack-design.md#focused-verification).
- Owning test/type/lint logs and installed-hook result pointer: `/private/tmp/xln-verification-profiles-20261116-B7q1AL/`.
- Installed-hook refusal: `.git/xln-verification/514ddbd5f86173d332bfb87998db9e5930f5f006/2026-11-15T21-11-37.303Z-aa304ed4-910a-4e38-a444-58ea19c2910a/result.json`.
- The previous [deployment profile](evidence/deployment-check/2026-11-15T17-06-34.478Z-89550-xQMyi9/result.json) stays 6/6 green for its unchanged 588 source/configuration files and 181 contract artifacts. It does not cover this new verification policy; its owning checks are recorded above.
- Existing public deployment/USDC records and unrelated owner files remain protected. Generated output exclusions are unchanged.

## Next single command

```sh
git show --stat --oneline HEAD
```

Review the approved ten-path verification-profile commit. Existing public
records and unrelated edits are excluded. Actual publication remains a separate
owner instruction.

## Remaining final gates

- Profile selection, owning type/lint/regression checks and local hook installation are complete; preserve the checked candidate when preparing commits.
- The real checkout is not release-clean. Resolve unrelated owner source/tracker edits explicitly before a successful verification or push; do not hide or discard them.
- Full repository and deployment suites were not rerun in this step. Whole-product/mainnet acceptance, public financial flows, Cross-J, UI and optional manual-CI profile selection remain separate work.

# Current xln execution handoff

## Current SHA

- Verification parent: `fed0cc97659f5c02312fe3c6457eba1274851917`, owner-approved `testnets_deploy`. This handoff accompanies the native-CLI analysis fix; resolve its resulting SHA with `git rev-parse HEAD`.
- Local `main` remains `019d45beb5954e77fe806d643845f6a4dca4fa82`; fetched `origin/main` is `bdc53c7b48b8d55216c7c2801e015988332befde`. No main changes were merged. Apply the [execution exceptions](deployment/ignition-stack-design.md#owner-approved-execution-exceptions).
- Owner decision, 2026-11-16: aggregate `check` excludes `check:frontend` and `check:ui-types`; each remains required for owning changes, and both for whole-product/mainnet acceptance. The [frontend task](../.scratch/svelte-dockview-build-health/issues/01-active-panel-event.md) is deferred. Profile-selection and exact-SHA push guards remain unchanged.
- Knip now includes native Hardhat/USDC CLI consumers. Two helpers used only inside their files are private; their function bodies are unchanged. No frontend source/dependency or production Solidity change occurred. The PR body remains an untracked working document.

## Last green command

```sh
bun run stand:run --reason native-deployment-surface-readonly-rerun --timeout-ms 240000 -- bun /private/tmp/xln-svelte-scope-20261116-91kkjxau/run-readonly-check.ts
```

**21 tests / 113 assertions / 3 files passed** in 44.31 s: the existing unused-surface unit vectors, Stack Manager validation and real Anvil readonly CLI/tamper scenario. The profile-owned successful fixtures were removed. The first temporary wrapper run failed after all tests passed because it read a void cleanup return; the corrected exact rerun exited zero.

`check:unused-surface`, `check:dead-code`, strict deployment types and full ESLint passed. Runtime/non-runtime unused debt is zero; ESLint retains exactly 315 approved rows and its original hash. The prior 73 verification tests / 273 assertions remain applicable to unchanged verification source/tests. The historical deployment profile is not a fresh run of this changed source candidate.

## First red command/error

The preceding clean `fed0cc976` push failed on three unused Stack Manager exports. The analyzer omitted their native CLI consumers; the corrected graph and two truly internal helper exports are now checked. Full pre-push on the resulting committed candidate is pending. Deferred frontend failures remain unverified product constraints.

## Artifact path

- [Readonly scenario result](evidence/deployment-check/native-surface-20261116-n82nNM/result.json) and its adjacent source proof.
- [Previous rejected publication](evidence/deployment-check/pr-publication-20261116-7hmru6i8/verification-result.json).
- Static/type/lint/focused-test logs: `/private/tmp/xln-svelte-scope-20261116-91kkjxau/`.
- [Historical deployment profile](evidence/deployment-check/2026-11-15T22-22-24.950Z-65377-5MYXjb/result.json).

## Next single command

```sh
bun run stand:run --reason testnets-deploy-publication --timeout-ms 660000 -- git push --set-upstream origin testnets_deploy:refs/heads/testnets_deploy
```

Run on the committed candidate with a clean source tree. Preserve the working PR body outside that tree during the hook, then restore it. The owner authorized push and PR creation; create the PR only after the hook accepts the push.

## Remaining final gates

- Full pre-push on the clean committed candidate, including aggregate `check` and Hardhat; fix only an observed remaining failure.
- Verify the remote head, then create the requested PR. This authorizes no merge or new public financial operation.
- Frontend restoration, whole-product/mainnet acceptance and Cross-J retain their separate gates.

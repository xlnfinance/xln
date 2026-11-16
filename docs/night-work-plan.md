# Current xln execution handoff

## Current SHA

- Verification parent: `3ec2309be09df916458d3e6e103590a065515873`, owner-approved `testnets_deploy`. This handoff accompanies the Svelte-deferral commit; resolve its resulting SHA with `git rev-parse HEAD`.
- Local `main` remains `019d45beb5954e77fe806d643845f6a4dca4fa82`. The fetched `origin/main` is `bdc53c7b48b8d55216c7c2801e015988332befde`; no main changes were merged. Apply the [execution exceptions](deployment/ignition-stack-design.md#owner-approved-execution-exceptions).
- Owner decision, 2026-11-16: aggregate `check` omits `check:frontend`; the standalone frontend gate remains required for Svelte changes and whole-product/mainnet acceptance. The [frontend task](../.scratch/svelte-dockview-build-health/issues/01-active-panel-event.md) is deferred. Source/contract/adapter/tooling obligations and profile-selection guards remain unchanged.
- No frontend source, dependency, lockfile or production contract changes belong to this step. The PR body remains an untracked working document.

## Last green command

```sh
bun run stand:run --reason svelte-deferral-verification-tests --timeout-ms 60000 -- bun test scripts/verification/tests
```

**73 tests / 273 assertions / 5 files passed**, including real local pre-push and remote-preservation cases. The package diff changes only `scripts.check:long`, retaining `check:src`, React types and standalone `check:frontend`. Compared with the prior deployment profile, only the root package script differs among 590 covered paths; all 181 artifact hashes and 185 public deployment files remain unchanged.

The preceding deployment profile remains 6/6 green for its original invocation (274 Hardhat, 64 Foundry, 148 Bun tests / 3739 assertions). It does not certify a fresh run of the changed aggregate command.

## First red command/error

The preceding publication attempt on clean `3ec2309be` failed at `DockRoot.svelte:474` and updated no remote ref. That frontend gate is now explicitly deferred by the owner; the updated full pre-push result is pending. No whole-product acceptance is claimed.

## Artifact path

- [Scope-change result](evidence/deployment-check/svelte-deferral-20261116-91kkjxau/result.json).
- [Previous rejected publication](evidence/deployment-check/pr-publication-20261116-32_38s39/verification-result.json).
- [Historical deployment profile](evidence/deployment-check/2026-11-15T22-22-24.950Z-65377-5MYXjb/result.json).
- Original focused-test log: `/private/tmp/xln-svelte-scope-20261116-91kkjxau/verification-tests.log`.

## Next single command

```sh
bun run stand:run --reason testnets-deploy-publication --timeout-ms 660000 -- git push --set-upstream origin testnets_deploy:refs/heads/testnets_deploy
```

Run on the committed candidate with a clean source tree. Preserve the working PR body outside that tree during the hook, then restore it. The owner authorized push and PR creation; create the PR only after the hook accepts the push.

## Remaining final gates

- Full pre-push on the clean committed candidate, including aggregate `check` and Hardhat. Diagnose only an observed remaining failure.
- Verify the remote head, then create the requested PR using the prepared body. This authorizes no merge or new public financial operation.
- The separate frontend task, whole-product/mainnet acceptance and Cross-J retain their owning gates.

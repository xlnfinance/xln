# Current xln execution handoff

## Current SHA

- Verification parent: `589d7ca3dc16729c8b56cd5400ff42fe455fd1aa`, owner-approved `testnets_deploy`. This handoff accompanies the scanner-fix commit; resolve its resulting SHA with `git rev-parse HEAD`. The recorded checks ran before committing; their source hashes must match the committed files.
- `main`: `019d45beb5954e77fe806d643845f6a4dca4fa82`, unchanged. Apply the [owner-approved execution exceptions](deployment/ignition-stack-design.md#owner-approved-execution-exceptions).
- This commit contains only the reviewed scanner, CLI regression and handoff. No push, public transaction, dependency update or frontend change occurred in this step.

## Last green command

```sh
bun run stand:run --reason no-legacy-final-exact --timeout-ms 60000 -- bun tools/run-parallel-checks.ts check:no-legacy check:folder-width frozen-core:check
```

All three gates passed. The vocabulary scan checked 4725 files with eight exact allowances. It excludes only the root Ignition deployment-evidence tree; current modules and deployment scripts remain checked. Two exact provider-owned RPC fixture URLs are permitted in the existing credential-rejection test. No protocol pattern was removed.

Focused CLI regressions and existing Stack Manager validation passed **26 tests / 72 assertions**, including rejection in adjacent and similarly nested source paths. Strict scoped typechecking, focused ESLint, test formatting and `git diff --check` passed.

The preceding deployment profile remains **6/6 green** for its original invocation: all **590** covered source/configuration hashes and **181** artifact hashes still match. It was not rerun or relabelled as clean-commit evidence for this candidate. All **185** preserved public deployment files remain unchanged.

## First red command/error

`bun run check` under the stand with host access exited 1 at `frontend/src/lib/view/DockRoot.svelte:474:64`: `Property 'panel' does not exist on type 'IDockviewPanel | undefined'`. Svelte reported one error and one warning. Other unfinished checks do not establish additional defects. The cancelled vocabulary check subsequently passed in the exact isolated rerun above.

An earlier sandboxed attempt was stopped by denied GPG-agent access in temporary test commits and denied process-group signalling. Host-access repetition preserved test and GPG settings. The stand is free.

## Artifact path

- [Current result](evidence/deployment-check/no-legacy-20261116-ilbss944/result.json), with focused and exact-check logs beside it.
- [Unchanged deployment profile](evidence/deployment-check/2026-11-15T22-22-24.950Z-65377-5MYXjb/result.json).
- Original full-check log and scoped type/lint logs: `/private/tmp/xln-no-legacy-20261116-ilbss944/`.
- [Separate Svelte build-health issue](../.scratch/svelte-dockview-build-health/issues/01-active-panel-event.md).

## Next single command

```sh
git show --stat --oneline HEAD
```

Review the committed fix and [CLI regression](../core/__tests__/testing/tooling/policy/source-vocabulary.test.ts). Local evidence remains excluded from Git; no publication is implied.

## Remaining final gates

- Resolve the separately tracked Svelte build-health failure within its own scope. This deployment step does not modify frontend or dependencies.
- After the separate blocker is resolved, repeat full `bun run verify` on the resulting clean SHA before publishing this broader branch. No global-green or publication-ready result is claimed.
- Whole-product/mainnet acceptance, Cross-J and financial/recovery authority retain their separate gates.

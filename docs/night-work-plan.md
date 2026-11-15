# Current xln execution handoff

## Current SHA

- Verified parent: `acb66be38f9896b58be36b08257f1d3b5afdf81c`, owner-approved `testnets_deploy`. This handoff accompanies the approved Git-exclusion commit; resolve its resulting SHA with `git rev-parse HEAD`. Executable source, tests and contract artifacts are unchanged.
- `main`: `019d45beb5954e77fe806d643845f6a4dca4fa82`, unchanged. Apply the [owner-approved execution and Git route exceptions](deployment/ignition-stack-design.md#owner-approved-execution-exceptions).
- Allowed code-update routes are branch-matched `main -> main` and `testnets_deploy -> testnets_deploy`; `HEAD` aliases only the checked-out branch's own target. SHA and branch stability are checked across verification and against push-start identity.
- Full verification commands, BrainVault scope, tracked-source and hidden-index checks, deletion semantics and budgets remain unchanged. No actual project push, PR, hook installation or public financial operation occurred in this step.

## Last green command

```sh
bun run stand:run --reason generated-output-ignore-boundary --timeout-ms 30000 -- \
  bun /private/tmp/xln-ignore-boundary-20261115.ts
```

**8/8 boundary checks passed**, using the actual `.gitignore`, production
`sourceState`/`sourceProblem`, a real temporary Git repository and the unchanged
owner checkout. Exactly 200 existing untracked output paths are excluded.
Unknown source, tracked source changes, changes to already tracked reports and
hidden index flags still reject. Neighboring and nested paths stay visible.
All 219 existing evidence, journal and owner files checked before the change
remain byte-identical. No permanent test source was added for this Git-only change.

## First red command/error

None in the selected Git-exclusion scope. After committing the three owned
paths, the real checkout still correctly returns `VERIFY_DIRTY_SOURCE` for the
unrelated `public-proof-smoke.ts` edit and the untracked Svelte tracker file.
The three output roots no longer contribute untracked paths.
The inherited `AGENTS.md` formatting finding remains outside this change.

## Artifact path

- Implementation: root `.gitignore`; [retention and Git policy](deployment/ignition-stack-design.md#local-fixture-retention). Journal preservation and deployment input-integrity checks remain mandatory.
- Boundary probe and compact result: `/private/tmp/xln-ignore-boundary-20261115.ts`, `/private/var/folders/z0/tl1lmzfs49df8y9b6k411m0c0000gq/T/xln-git-ignore-5fdNdU/boundary-result.json`.
- The unchanged Git-route/lint candidate passed 41 tests / 175 assertions, strict scoped types and zero-finding lint before commit `acb66be38`. Those earlier checks are not reruns of this Git-exclusion change.
- Previous [deployment profile](evidence/deployment-check/2026-11-15T17-06-34.478Z-89550-xQMyi9/result.json) stays **6/6 green** for byte-identical 588 covered source/configuration files. It does not cover the changed Git-policy scripts; their focused checks are recorded separately.
- All existing public deployment/USDC evidence and unrelated owner files remain protected. The real hook is still uninstalled.

## Next single command

```sh
git show --stat --oneline HEAD
```

Review the approved three-path Git-exclusion commit. Existing public records
and unrelated edits remain untouched. The owner authorized this commit;
no actual push or hook installation is requested.

## Remaining final gates

- The approved generated-output exclusions are implemented and passed their owning Git boundary checks. Preserve existing tracked-source and unknown-path rejection; do not broaden these exclusions silently.
- Verification profile selection, disposition of the unrelated dirty source/tracker and actual hook activation remain separate steps. Global and deployment suites were not rerun for this Git-only change.
- Actual publication requires the owner's instruction. Whole-product/mainnet acceptance, browser/UI and Cross-J remain separate work; this change runs none of those flows.

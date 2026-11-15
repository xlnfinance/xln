# Current xln execution handoff

## Current SHA

- Verified parent: `5bc71c46f737723d0bd44fc15ccbe46ec3318637`, owner-approved `testnets_deploy`. This handoff accompanies the approved Git-route/lint commit; resolve its resulting SHA with `git rev-parse HEAD`. All six executable source/test hashes match the checked candidate.
- `main`: `019d45beb5954e77fe806d643845f6a4dca4fa82`, unchanged. Apply the [owner-approved execution and Git route exceptions](deployment/ignition-stack-design.md#owner-approved-execution-exceptions).
- Allowed code-update routes are branch-matched `main -> main` and `testnets_deploy -> testnets_deploy`; `HEAD` aliases only the checked-out branch's own target. SHA and branch stability are checked across verification and against push-start identity.
- Full verification commands, dirty/unknown-untracked/BrainVault/hidden-index rules, deletion semantics and budgets remain unchanged. No actual project push, PR, hook installation or public financial operation occurred.

## Last green command

```sh
bun run stand:run --reason git-lint-fix-regressions --timeout-ms 60000 -- \
  bun test ./scripts/verification/verification.test.ts \
  ./scripts/verification/source-scope.test.ts ./scripts/verification/process.test.ts \
  ./tools/checks/check-environment.test.ts
```

**41 tests / 175 assertions in 7.19 s**, using real temporary Git repositories,
local bare remotes and the actual copied hook. Both named routes work; wrong
OID, crossed routes, tags, mixed updates, unknown/detached branches, same-SHA
branch switching, dirty source and hidden index flags are rejected.
Strict scoped typechecking inherited the root TypeScript safety options and passed
for all six owning source/test files. Scoped ESLint passed with **zero findings
and zero approved debt rows**, without weakening rules or the debt baseline.
Git metadata uses the existing safe serializer; the copied hook includes its
three unchanged dependencies. Process cleanup preserves assertion and cleanup
failures in one aggregate while attempting every cleanup step. Independent
read-only review found no material issue in the frozen candidate.

## First red command/error

None in the selected Git-route/lint scope. Functional tests, strict types,
scoped lint and formatting passed.

An expanded Markdown formatting check reports pre-existing `AGENTS.md` formatting
also present in HEAD; none of its formatting-only differences touch the task's
added route-policy link. Owning source, guide and handoff formatting are green.

Live source-policy inspection accepts the task branch, then correctly returns
`VERIFY_DIRTY_SOURCE`: unrelated tracked owner edits and existing untracked evidence
remain. Profile selection and generated-output handling have not changed.

## Artifact path

- Implementation: `scripts/verification/git.ts`, `pre-push.ts`, `verify.ts`; owning regression commands above, including `process.test.ts`.
- [Owner-approved route policy](deployment/ignition-stack-design.md#owner-approved-execution-exceptions); [canonical Git instructions](../AGENTS.md#git-and-shared-workspace).
- Bounded test/type/lint/baseline logs: `/private/tmp/xln-git-route-20261115-op2vczdy/`.
- Previous [deployment profile](evidence/deployment-check/2026-11-15T17-06-34.478Z-89550-xQMyi9/result.json) stays **6/6 green** for byte-identical 588 covered source/configuration files. It does not cover the changed Git-policy scripts; their focused checks are recorded separately.
- All existing public deployment/USDC evidence and unrelated owner files remain protected. The real hook is still uninstalled.

## Next single command

```sh
git show --stat --oneline HEAD
```

Review the approved route/lint commit. Existing public evidence and unrelated
edits are excluded. The owner authorized this commit; no actual push or hook
installation is requested.

## Remaining final gates

- None outstanding for the owned Git-route/lint candidate. Preserve its checked source/test contents and original verification provenance when preparing commits; changed executable contents require owning checks again.
- Verification profile selection and exact handling of generated outputs/dirty source remain separate owner decisions; do not silently ignore changes or install a hook that cannot pass its own policy.
- Actual publication requires the owner's instruction. Whole-product/mainnet acceptance, browser/UI and Cross-J remain separate work; this change runs none of those flows.

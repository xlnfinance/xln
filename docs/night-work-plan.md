# Current xln execution handoff

## Current SHA

- Cleanup parent: `fb23ed1988a0165c7363f4352ad977d8685379b2`, owner-approved `testnets_deploy`. This handoff accompanies the evidence-exclusion commit; resolve its resulting SHA with `git rev-parse HEAD`.
- `main`: `019d45beb5954e77fe806d643845f6a4dca4fa82`, unchanged. Apply the [owner-approved execution exceptions](deployment/ignition-stack-design.md#owner-approved-execution-exceptions).
- Eight generated evidence files (309,467 bytes) are removed from tracking and retained locally. The Rust report has an exact directory ignore rule; the seven deployment-profile files already fall under an existing rule. Earlier commits retain their history.
- The [PR body draft](deployment/pull-request-draft.md) remains a separate untracked working document. No push, public transaction, frontend, dependency or executable-source change occurred in this cleanup.

## Last green command

```sh
git diff --cached --check
```

The prospective source diff against `main` contains zero evidence paths. All eight local files and 185 public deployment files retain their original hashes. The prior deployment profile's 590 covered source/configuration hashes and 181 artifact hashes remain unchanged; no financial or global suite was repeated for this packaging change.

Prior owning results remain recorded under their actual invocation identities: deployment profile **6/6 green**, with 274 Hardhat, 64 Foundry and 148 Bun tests / 3739 assertions; scanner/Stack Manager regressions **26 tests / 72 assertions**. These are not fresh clean-commit executions of this cleanup candidate.

## First red command/error

The preceding `bun run check` exited 1 at `frontend/src/lib/view/DockRoot.svelte:474:64`: `Property 'panel' does not exist on type 'IDockviewPanel | undefined'`. The separate UI issue remains open; unfinished checks remain unproven. No full verification or publication readiness is claimed.

## Artifact path

- [Cleanup result](evidence/deployment-check/evidence-untrack-20261116-z9su3niq/result.json): file inventory, preserved hashes and source-diff checks. This local report is ignored.
- [Unchanged deployment profile](evidence/deployment-check/2026-11-15T22-22-24.950Z-65377-5MYXjb/result.json).
- [Scanner result](evidence/deployment-check/no-legacy-20261116-ilbss944/result.json) and its adjacent commit proof.
- [Separate Svelte build-health issue](../.scratch/svelte-dockview-build-health/issues/01-active-panel-event.md).

## Next single command

```sh
git status --short
```

Review the remaining PR draft before deciding whether to commit or remove that working document. It is not hidden by an ignore rule or an index flag.

## Remaining final gates

- Resolve the separately tracked Svelte build-health failure within its own scope.
- Handle the untracked PR draft, then run full `bun run verify` on the resulting clean SHA before publishing this broader branch. Actual publication still requires the owner's instruction.
- Whole-product/mainnet acceptance, Cross-J and application/UI integration retain their separate scope and authority.

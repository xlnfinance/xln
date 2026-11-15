# Current xln execution handoff

## Current SHA

- Verified parent: `994a5f6d3729050cf66d21801fac78058be36524`, owner-approved `testnets_deploy`. This handoff accompanies the approved documentation commit for the separate open Svelte task; resolve its resulting SHA with `git rev-parse HEAD`.
- `main`: `019d45beb5954e77fe806d643845f6a4dca4fa82`, unchanged. Apply the [owner-approved execution exceptions](deployment/ignition-stack-design.md#owner-approved-execution-exceptions).
- The owner explicitly selected cancellation of the uncommitted `public-proof-smoke.ts` diagnostic patch. That file matches the verified parent's committed bytes. No UI code, dependencies, contract artifacts or public records changed.
- The local hook remains installed as `core.hooksPath=.githooks`. No actual project push, PR or financial operation occurred.

## Last green command

```sh
git diff --check
```

The restored script was compared byte-for-byte with `git show HEAD:jurisdictions/scripts/public-proof-smoke.ts`. This confirms cancellation of the diagnostic patch; it is not a financial proof run. Documentation formatting and local links were checked. No executable changes are included in this documentation commit.

The unchanged verification implementation at the parent passed 83 tests / 291 assertions, strict scoped types and zero-finding lint. Those checks were not repeated for this documentation-only step.

## First red command/error

No new failing command was observed. The separate Svelte ticket records a historical checker failure and a current static source/type mismatch. Installed frontend Dockview packages are `4.13.1`, while the manifest requests `^8.6.0`; intended dependency resolution must be established before a UI fix. Typechecker, browser and full repository checks were not run in this step.

## Artifact path

- [Open Svelte build-health ticket](../.scratch/svelte-dockview-build-health/issues/01-active-panel-event.md): not completed; the stale dependency of deployment readiness on global UI checks is removed.
- Cleanup baseline, byte hashes and commit manifest: `/private/tmp/xln-leftover-cleanup-20261116-d0be_3sc/`.
- The previous [deployment profile](evidence/deployment-check/2026-11-15T17-06-34.478Z-89550-xQMyi9/result.json) retains its original source/check provenance. The source restore does not create new financial evidence.
- Existing public deployment journals, sealed artifacts and USDC receipts remain untouched. Generated-output Git exclusions are unchanged.

## Next single command

```sh
git status --short
```

After this documentation commit, the two previously pending leftovers are resolved as Git work: the diagnostic patch is cancelled and the Svelte task is recorded separately. The UI task itself remains open.

## Remaining final gates

- This documentation step does not authorize UI implementation or waive the UI task's full-check/browser gates.
- The real pre-push profile still requires the applicable suites on the final publication candidate. A clean working tree alone is not green verification or release authority.
- Actual publication needs the owner's instruction. Whole-product/mainnet acceptance, public financial flows, Cross-J and optional manual-CI profile selection remain separate work.

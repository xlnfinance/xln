# 01: Restore frontend installations and verify Svelte/React build health

Type: implementation
Category: bug
Completed: no
Status: ready-for-human
Blocked by: None

## Problem

The frontend manifest and both lockfiles require Dockview 8.6.0. The root installation contains 8.6.0, but `frontend/node_modules` contains Dockview and dockview-core 4.13.1. The nearer frontend installation shadows the root package.

The observed `DockRoot.svelte:474` error is `Property 'panel' does not exist on type 'IDockviewPanel | undefined'`. Dockview 4.13.1 passes the panel directly; 8.6.0 passes `{ panel, origin }`. The current `({ panel }) =>` callback matches the installed root 8.6.0 declarations. A source change to match 4.13.1 is not justified by this failure.

React has a second observed installation mismatch: `ui/package.json` requires TypeScript `^7.0.2`, while `ui/node_modules/typescript` is 5.9.3. The local `ui/node_modules/.bin/tsc` resolves to that old compiler and rejects the existing `--checkers 4` argument. The root compiler entry instead resolves to `@typescript/native` 7.0.2. Diagnose this installation before changing the UI check command or application code.

## Scope and authority

Owner decision, 2026-11-16: defer this frontend work and isolate it from the Sepolia deployment/publication effort. Aggregate `check` and pre-push omit `check:frontend` and `check:ui-types`; both standalone commands are retained. This task is not selected for implementation.

When frontend work resumes, restore each installation from its existing lockfile before diagnosing source behavior. Keep manifest/lockfile changes separate from installation repair. Only change the callback if the correctly resolved SDK still demonstrates a source defect. Preserve Graph3D activation and the no-active-panel case.

This task authorizes no dependency upgrade, wallet feature, compatibility adapter, suppression or type assertion. Deployment code, public journals, seals, receipts and unrelated owner work remain outside its scope.

## Acceptance criteria

- [ ] Frontend installation matches its manifest and existing lockfile; record actual resolved Dockview/dockview-core paths and versions.
- [ ] React installation and compiler resolution match its manifest and lockfile; record the exact `tsc` executable and version.
- [ ] Run `bun run check:frontend` and `bun run check:ui-types` against the consistent installations and retain their first remaining errors, or green results.
- [ ] Any necessary source fix follows the intended SDK contract and verifies Graph3D activation plus the no-active-panel case through an owning browser check under the stand lock.
- [ ] Run the applicable source/contract gates; full product acceptance also requires both standalone frontend gates.
- [ ] Record how frontend verification is invoked when frontend work resumes; keep each owning gate mandatory for its source/dependency changes.
- [ ] Preserve deployment changes, public evidence and unrelated owner work.

## Evidence and limits

Public-push verification on clean `3ec2309be09df916458d3e6e103590a065515873` reproduced the Svelte checker failure and rejected the push. Its local result is at `docs/evidence/deployment-check/pr-publication-20261116-32_38s39/verification-result.json`.

The next clean publication attempt at `f975e2f6e30dce3448edcd1eeb4673a7261ab22c` passed all three short checks, then React typechecking failed with `TS5025: Unknown compiler option --checkers`. Its local report is under `docs/evidence/deployment-check/pr-publication-20261116-y2d3sq05/`.

Static inspection confirmed both installed event signatures, both installation mismatches and the React compiler path. No frozen reinstall, checker run against a consistent frontend 8.6.0 installation or owning browser verification has been performed. This task remains deferred and incomplete.

## Comments

- The owner isolated UI work from deployment on 2026-11-11 and confirmed this deferral on 2026-11-16. Removing the aggregate frontend step does not waive source, contract, adapter or verification-tooling checks, or certify whole-product/mainnet acceptance. See [verification scope](../../../AGENTS.md#verification-scope).

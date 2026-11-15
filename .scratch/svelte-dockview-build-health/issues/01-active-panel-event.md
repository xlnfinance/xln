# 01: Fix the Svelte Dockview active-panel callback type

Type: implementation
Category: bug
Completed: no
Status: ready-for-agent
Blocked by: None

## Problem

The historical full repository check reported a callback mismatch at `frontend/src/lib/view/DockRoot.svelte:474`: the installed frontend Dockview SDK passes `IDockviewPanel | undefined` directly, while the callback destructures `{ panel }`. The source line is unchanged from commit `019d45beb5954e77fe806d643845f6a4dca4fa82`. No fresh typecheck, browser check or full repository check was run for this record.

Observed error: `Property 'panel' does not exist on type 'IDockviewPanel | undefined'`.

The owner explicitly chose to keep this UI build-health fix separate from the contract-deployment task on 2026-11-11. This record does not authorize starting UI implementation in that task.

## Scope

First establish the intended frontend dependency resolution against its own manifest and lockfile. Static inspection on 2026-11-16 found installed `dockview` and `dockview-core` at `4.13.1`, while `frontend/package.json` declares `dockview: ^8.6.0`. Do not choose a code fix solely to accommodate an inconsistent installation.

Adapt the callback to the intended SDK's actual signature, preserving optional `panel?.id` handling and Graph3D initialization. For the currently observed direct-panel signature, the change is from `({ panel }) =>` to `(panel) =>`. The installed declaration is `frontend/node_modules/dockview-core/dist/cjs/api/component.api.d.ts`; a different root SDK does not establish frontend compatibility.

Svelte is frozen except for build health under AGENTS.md. This record authorizes no wallet feature, dependency upgrade, cross-version adapter, suppression or type assertion.

## Acceptance criteria

- [ ] Frontend manifest, lockfile and resolved SDK consistency is established before choosing the callback fix.
- [ ] The frontend type checker accepts the callback against that dependency resolution.
- [ ] Existing Graph3D selection behavior and the undefined-panel case are verified with an appropriate owning browser check under the stand lock.
- [ ] `bun run check` passes on the final candidate; other unrun or unrelated gates are reported explicitly.
- [ ] Contract-deployment changes and the owner's unrelated work are preserved.

## Evidence

Current evidence is static source, declaration and package-metadata inspection only. It does not establish a fresh checker failure or a completed UI fix. The task remains open and requires its own verification.

Under [AGENTS.md verification scope](../../../AGENTS.md#verification-scope), contract/deployment-only readiness uses `check:deployment` plus owning checks; this separate Svelte issue does not reopen a completed deployment ticket. The full repository check remains required for the UI change and broader release scope. Do not mark this UI task complete from static inspection alone.

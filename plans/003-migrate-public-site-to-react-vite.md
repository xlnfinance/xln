# Plan 003 — Establish React/Vite and migrate the public site

> **Executor instructions:** Follow the steps and run every verification command.
> Continue only after Plans 001–002 are marked `DONE`. Update the Plan 003 index
> row when complete. This intermediate dual-framework candidate is never releasable.
>
> **Drift check (run first):**
> `git diff --stat 5749e283d..HEAD -- frontend/package.json frontend/bun.lock frontend/vite.config.ts frontend/tsconfig.json frontend/src/routes frontend/src/lib/components/site frontend/static tests`
> Expected drift from completed prerequisites must be reviewed. Any unrelated
> semantic mismatch in public routes/build ownership is a STOP condition.

## Status

- **Execution:** DONE — L1/L2/L3 green
- **Priority:** P1
- **Effort:** L
- **Risk:** HIGH
- **Depends on:** `plans/001-lock-frontend-migration-contracts.md`, `plans/002-make-frontend-rollout-atomic.md`
- **Category:** migration
- **Planned at:** commit `5749e283d`, 2026-08-03

## Executor instructions

Start or continue the single writer-owned `ai/react-frontend-migration` worktree. If HEAD differs from `5749e283d`, re-run the inventory and reconcile this plan with merged Plans 001–002. Use Bun for dependency and script changes. Use React 19, Vite 7, and strict TypeScript. Do not deploy or merge this intermediate dual-framework state; create a `wip:` checkpoint after evidence is green.

This plan must migrate the real public site. Do not create empty React shells, fake data, duplicate navigation, or route fallbacks that conceal unfinished work. Svelte remains the sole production canonical path until Plan 011.

## Why this is the first React slice

The public site is mostly isolated from vault/runtime state, so it can validate the build architecture, shared UI boundary, accessibility, visual fidelity, and output routing before the wallet’s higher-risk state migration. It also currently inherits global wallet/native responsibilities that the split should remove.

## Current evidence

- Public routes are `/`, `/install`, `/rcpan`, `/releases`, `/reviews`, and `/unicast`.
- `frontend/src/routes/+layout.svelte` applies top navigation, toast, mascot, styles, and native initialization globally.
- `frontend/src/app.html` mixes public analytics with Capacitor routing concerns.
- `frontend/package.json` already has `react` and `react-dom` 19.2.8 but has no `.tsx` files or React imports; it lacks `@vitejs/plugin-react` and React type packages.
- Vite 7 supports multiple HTML entry points through `build.rollupOptions.input` and separate programmatic/configured builds. Preserve the current client-only behavior; do not add SSR or prerendering in this migration.

## Target structure

```text
frontend/
  apps/
    site/
      entries/
      components/
      pages/
      styles/
  packages/
    build-contracts/
    client-core/
    ui/
  vite.config.ts
  package.json
```

Keep one package and lockfile initially. A typed config factory consumes the route ownership manifest. `XLN_FRONTEND_SURFACE=all|site|docs|wallet|ops` selects entry inputs and output root. The default dev command exposes all available surfaces on `127.0.0.1:8080`; the site-only production build emits `frontend/build/site`.

## Scope

In scope:

- React/Vite/TypeScript build foundation and public-site entry points.
- Actual migration of every public route, content, assets, metadata, analytics behavior, accessibility, and responsive design.
- Framework-neutral shared design tokens/primitives only where two or more real consumers already exist.
- Deterministic, surface-scoped asset/output generation.

Out of scope:

- Wallet, docs reader, and operator pages.
- Router framework, SSR, Next.js, new content management, or public redesign.
- Runtime state, replica startup, transport, wallet, vault, or native-shell imports
  into site code. The `/rcpan` and `/releases` pages may consume the existing
  pure canonical Account/Hanko helpers needed to preserve product behavior;
  those imports are an exact allowlist enforced by boundary tests.

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Drift | `git diff --stat 5749e283d..HEAD -- frontend/package.json frontend/bun.lock frontend/vite.config.ts frontend/tsconfig.json frontend/src/routes frontend/src/lib/components/site frontend/static tests` | Exit 0; prerequisite drift reconciled |
| Install | `cd frontend && bun install` | Exit 0; one React/React DOM version |
| L1 | `cd frontend && bun test tests/vite-surface-config.test.ts tests/site-import-boundaries.test.ts` | Exit 0; all tests pass |
| Frontend check | `cd frontend && bun run check` | Exit 0; no TS/build errors |
| Site browser | `bun scripts/testing/run-static-frontend-e2e.ts tests/landing-site.spec.ts` | Exit 0; clean browser health |
| Broad gate | `bun run check` | Exit 0; no frozen-core violation |

## Git workflow

- Branch: the long-lived `ai/react-frontend-migration`; exactly one writer owns its worktree.
- Make coherent `wip:` checkpoint commits, for example `wip: migrate public site to React`.
- Do not push for deployment, merge to `main`, open a release PR, or publish artifacts before Plan 011.

## Files to inspect and likely change

- `frontend/package.json`, `frontend/bun.lock`, `frontend/vite.config.*`, `frontend/tsconfig*.json`
- `frontend/src/app.html`, `frontend/src/routes/+layout.*`
- Current Svelte pages/components/assets for the six public routes
- `frontend/static/**` and site metadata/manifest inputs
- New `frontend/apps/site/**` and narrowly shared `frontend/packages/**`
- Landing/install/release/review/unicast Playwright specs

## Implementation steps

1. Add the minimum React build dependencies with Bun: `@vitejs/plugin-react`, `@types/react`, and `@types/react-dom`. Keep the existing React major versions aligned. Do not introduce React Router, state libraries, CSS frameworks, or component kits unless an observed requirement cannot be met by existing project code.

   Verify: dependency graph has one React/React DOM version and Vite resolves the plugin without peer warnings.

2. Build a pure Vite config factory from the Plan 001 surface manifest. Each configured entry maps a stable URL to a concrete HTML entry and output location. Use `build.rollupOptions.input`; normalize and validate paths. Ensure production assets use stable relative/absolute bases appropriate to same-origin path routing.

   Verify: a focused config test asserts exact inputs and output roots for `all` and `site`, and rejects an unknown surface.

3. Create a minimal framework-neutral `build-contracts` package containing route/output types and a `client-core` package for safe browser primitives. Create `ui` only for actual tokens/primitives reused by current migrated pages. Do not move business logic merely to make the tree look clean. Public product calculators/verifiers must reuse the existing pure canonical Account/Hanko implementation through an exact allowlist; they must not initialize or import runtime state.

   Verify: import-boundary tests prevent site from importing wallet/runtime/native modules and prevent shared packages from importing app-specific modules.

4. Create the React site root with `createRoot`, per-entry error boundary, semantic document structure, global error surfacing, and site-only analytics. The site entry must not initialize vaults, runtime workers, push wake, Capacitor, Electron, command journals, or wallet stores.

   Verify: browser network and console prove `/` makes no wallet/runtime initialization requests and raises no hidden errors.

5. Port `/`, `/install`, `/rcpan`, `/releases`, `/reviews`, and `/unicast` one at a time. Preserve content, canonical links, titles/descriptions, test IDs that express product behavior, downloadable assets, and current outbound URLs. Replace Svelte-only mechanics with idiomatic React composition; do not transliterate component syntax line-by-line.

   Verify after each page: its targeted Playwright spec passes, keyboard navigation works, and screenshots match or intentionally improve the current baseline at iPhone, laptop, and wide desktop sizes.

6. Split public navigation from wallet/ops navigation. The public top bar may link to `/app` and `/docs`, but must not render operator tools or import their code. Remove any remaining public dependency on `DeltaVisualizer` as guaranteed by Plan 001.

   Verify: bundle analysis and import tests show no wallet/runtime/native chunks in the site output.

7. Add a deterministic site build command and integrate the output into the Plan 002 release manifest without activating it. Keep the existing Svelte build command available only as the current production implementation until final cutover; label the React artifact non-release in scripts/docs.

   Verify: two site builds from unchanged inputs have the same route and asset inventory; the release validator recognizes but does not activate the artifact.

## Test plan

L1 narrow:

```bash
cd frontend
bun test tests/vite-surface-config.test.ts
bun test tests/site-import-boundaries.test.ts
bun run check
```

Use the frontend check for the React TypeScript/build slice first; the root gate remains L3.

L2 targeted browser:

```bash
bun scripts/testing/run-static-frontend-e2e.ts tests/landing-site.spec.ts
bun scripts/testing/run-static-frontend-e2e.ts tests/install-site.spec.ts
```

Add equally focused specs for uncovered public routes. Inspect all key-state screenshots and F12 console/network at iPhone, laptop, and wide desktop viewports.

L3 broad gate:

```bash
bun run check
```

Run once on the unchanged checkpoint candidate. Record build sizes for each site entry and confirm no runtime/vault chunk appears.

## Done criteria

- [x] Every public route has a complete React implementation with clean-console visual evidence.
- [x] The site builds independently to `frontend/build/site` and under the default same-origin dev server.
- [x] Site code cannot import wallet, runtime state/startup, native, docs, or ops implementation modules; the exact pure canonical Account/Hanko helper allowlist is boundary-tested.
- [x] No SSR/router/state-library scope was introduced.
- [x] The React artifact is manifest-valid but remains release-blocked.
- [x] `bun run check` passes; checkpoint only with `wip:`.
- [x] `git status --short` is reviewed and the Plan 003 index row is updated.

## Execution evidence

- L1: 9 focused Vite-surface/import-boundary tests and 5 static-runner contract tests pass.
- L2: 18 clean-console screenshots pass across six routes at iPhone, laptop, and wide-desktop viewports; all screenshots were visually inspected.
- Determinism: two unchanged site builds produced digest `fc0fd847b97b993ade580edf78d65264f7bbf254dba3f8dc4488c63d3d9a0270`.
- Isolation: the candidate contains no runtime worker, vault, native-shell, push-service-worker, manifest, or contract artifact; activation is rejected with `FRONTEND_REACT_CANDIDATE_ACTIVATION_BLOCKED:site`.
- Largest entry: isolated Releases verifier chunk 392.99 kB (135.24 kB gzip); shared shell 198.55 kB (62.88 kB gzip).
- L3: `bun run check` passes with frozen core unchanged and Svelte/React type/build checks green.

## Stop conditions

- If stable paths cannot be emitted with Vite MPA inputs under the existing server contract, stop and demonstrate the failing path before changing routing architecture.
- If a public page needs authenticated wallet state, stop: the boundary inventory is wrong and requires owner review.
- Any proposal to ship the dual-framework state is a stop until Plan 011 removes Svelte atomically.

## Suggested toolkit

- [Vite 7 build guide](https://github.com/vitejs/vite/blob/v7.3.1/docs/guide/build.md)
- [Add React to an existing project](https://react.dev/learn/add-react-to-an-existing-project)
- Use the `vercel-react-best-practices` skill if available while reviewing bundle and render behavior.

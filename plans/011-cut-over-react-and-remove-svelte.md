# Plan 011 — Atomically cut over to React and remove Svelte

> **Executor instructions:** Do not begin until Plans 001–010 are `DONE`. Follow
> every step and verification command on one unchanged release candidate, then
> update Plan 011 in `plans/README.md`. Production activation still needs explicit
> owner authority. A parity or frozen-core failure is a release-blocking STOP.
>
> **Drift check (run first):**
> `git diff --stat 5749e283d..HEAD -- frontend package.json bun.lock scripts/deployment scripts/native tests docs`
> Extensive prerequisite drift is expected; reconcile it against the completed
> plan evidence. Any unexplained production-path or persistence difference is a STOP.

## Status

- **Priority:** P1
- **Effort:** L
- **Risk:** HIGH
- **Status:** IN PROGRESS — canonical React cutover implemented; final unchanged-candidate browser/native/CI/release gates pending
- **Depends on:** Plans 001–010
- **Category:** migration, release engineering
- **Planned at:** commit `5749e283d`, 2026-08-03

## Executor instructions

Continue in the same writer-owned `ai/react-frontend-migration` worktree after every prior plan is green at current HEAD. This is the only plan allowed to make React the canonical production frontend. It must replace the frontend atomically and delete the retired Svelte/SvelteKit path in the same candidate—no route-by-route production switch, compatibility alias, fallback reader, or parallel framework build.

Before destructive deletion, resolve exact tracked targets and prove their replacements/reachability. Never use broad/unresolved removal paths. Do not run `bun run frozen-core:approve`; any frozen-core violation is a hard stop.

## Why this is one indivisible plan

Intermediate migration commits intentionally contain two UI frameworks but are release-blocked. Repository policy allows only one canonical production path. The final candidate must build all surfaces from one commit, switch native/server tooling to the React release manifest, remove Svelte implementation and dependencies, pass full parity/gates, and activate all surfaces together.

## Preconditions

- Plan 001 route/persistence/visual contract is green.
- Plan 002 atomic staging/activation/rollback has passed local failure injection.
- Site, docs, wallet, and ops React artifacts are complete and manifest-valid.
- Framework-neutral stores are canonical; every Svelte adapter is now unused by React.
- All wallet financial flows have real integration evidence; all key visual states have inspected screenshots at iPhone, laptop, and wide desktop.
- The worktree is clean except the intended cutover candidate, and exact `git diff --stat`/`git status` scope is reviewed.

## Scope

In scope:

- Make React/Vite outputs canonical for server, dev, tests, release packaging, PWA, Capacitor, Electron, extension, and local launcher.
- Delete all retired Svelte/SvelteKit source, configuration, adapters, dependencies, tests tied only to Svelte/compiler internals, and compatibility scripts.
- One unified manifest/release candidate, exhaustive parity evidence, native/browser gates, atomic deployment procedure, and rollback rehearsal.

Out of scope:

- New features, visual redesign, SSR/prerender, route renames, origin changes, storage migrations, protocol changes, or independent surface versions.

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Drift | `git diff --stat 5749e283d..HEAD -- frontend package.json bun.lock scripts/deployment scripts/native tests docs` | Exit 0; all prerequisite changes reconciled |
| Retired source | `rg --files frontend -g '*.svelte'` | No output |
| Retired dependencies | `rg -n "svelte|SvelteKit|@sveltejs|\\.svelte" frontend/package.json frontend/bun.lock frontend/apps frontend/packages frontend/scripts tests package.json` | No active-code/config/test matches |
| Payment smoke | `bun run test:e2e:payment:smoke` | Exit 0 |
| User flows | `bun run test:e2e:flows` | Exit 0 |
| Native mobile | `bun run native:mobile` | Exit 0; candidate identity matches manifest |
| Native desktop | `bun run native:desktop:smoke` | Exit 0; candidate identity matches manifest |
| Check | `bun run check` | Exit 0; no frozen-core violation |
| CI gate | `bun run gate:ci` | Exit 0 on unchanged candidate |
| Release gate | `bun run gate:release` | Exit 0 on unchanged candidate |

## Git workflow

- Branch: finish the sole `ai/react-frontend-migration` writer worktree.
- Review exact deletions with `git status --short` and `git diff --stat`; commit the atomic replacement as one coherent non-WIP candidate only after all gates pass.
- Do not push, open a PR, merge, tag, or activate production unless explicitly instructed.

## Files to inspect and likely change

- `frontend/package.json`, lockfile, Vite/TypeScript configs, all scripts and build inputs
- Retired `frontend/src/routes/**`, Svelte components, Svelte store adapters, `app.html`, and SvelteKit config
- Root package scripts and check/release gates
- `scripts/native/build-platforms.ts`, Capacitor/Electron/extension configs and launchers
- Deployment/Nginx/release manifest tooling from Plan 002
- All frontend unit/Playwright/native tests and distribution docs

## Implementation steps

1. Run a final drift/parity inventory before deletion. Compare the Plan 001 contract report from the current Svelte production build with the completed React build: routes, persistent identifiers, PWA/native entry behavior, public metadata, catalog URLs, runtime assets, command/vault formats, test IDs, and release assets. Resolve every unexplained difference first.

   Verify: machine-readable comparison is empty except explicitly approved implementation-only file changes.

2. Flip package scripts/config to make the Vite surface build canonical. Default `bun run dev` must serve the full same-origin route contract at `localhost:8080`; production builds produce `site`, `docs`, `wallet`, and `ops`; release packaging always requires all four and one manifest. Remove “legacy”, “old”, “v2”, framework-selection flags, and Svelte fallback commands.

   Verify: searching scripts/config/docs finds no selectable production implementation or compatibility route.

3. Switch native packaging and configs to the manifest-declared wallet/shared artifacts. Update Capacitor `webDir`, Electron, extension, launcher, service worker, and any copy steps to the new canonical release layout. Preserve root-scoped PWA/push behavior and `/app` native entry.

   Verify: inspect mobile, desktop, and extension packages; each embeds the same commit/version as the web release and no Svelte artifact.

4. Update server/release routing to the React surface outputs and exercise Plan 002’s staged activation/health/rollback locally. Every route resolves to its manifest owner; edge endpoints remain proxies. Health confirms build identity for all surfaces.

   Verify: activate candidate B over fixture A, exercise URL matrix, rollback to A, then reactivate B; no mixed identity or downtime window is observed.

5. Delete retired Svelte/SvelteKit source and adapters only after exact import/route proof. Remove `.svelte` files, Svelte routes/layouts, Svelte store adapters, SvelteKit config/generated types, compiler-specific tests, and obsolete build/copy scripts. Do not retain aliases or commented copies.

   Verify:

   ```bash
   rg -n "svelte|SvelteKit|@sveltejs|\.svelte" frontend package.json bun.lock
   ```

   Remaining matches must be zero or explicitly proven non-production historical text outside active frontend/build/test code. `rg --files frontend -g '*.svelte'` must return nothing.

6. Remove Svelte/SvelteKit dependencies and add final strict dependency/import gates. Confirm one React/React DOM version, no unused migration packages, and no app imports across surface boundaries. Reinstall with Bun and review the lockfile deliberately.

   Verify: dependency graph/build logs contain no Svelte compiler/runtime; site/docs/wallet/ops bundles contain only their allowed feature chunks.

7. Update tests from Svelte/compiler internals to behavior/contracts. Preserve characterization tests for framework-neutral state and financial adapters. Run each affected L1 target, each visual/user L2 flow, then the related broad suites exactly once on the unchanged candidate.

   Verify: 0 tests reference `.svelte` source/compiler as their subject; deleted tests have equivalent or stronger behavioral coverage.

8. Run full browser parity with a fresh profile and a profile populated by the prior production build. Cover public pages, docs/deep links, create/import/unlock/recovery, runtime selection, accounts, pay/receive/move, credit/settlement, swap/history, ops, PWA/service worker/push open, reload/back/forward, and direct cold routes. Inspect F12 console/network/storage and every key screenshot at all required viewports.

   Verify: no data rewrite, loss, duplicate command, route fallback, console error, failed asset, visual defect, or hidden Svelte chunk.

9. Run native/extension parity using the same manifest candidate. Exercise onboarding/unlock/settings and a safe representative real command flow where the current release gate requires it. Confirm lifecycle/resume/deep-link behavior and build identity.

   Verify: native/mobile/desktop evidence is tied to the exact commit/manifest being proposed.

10. Run release gates on the unchanged final candidate, generate one tagged/versioned manifest, review diff/status, then hand off for owner-approved production activation. Do not push/merge/release if any gate or screenshot review is incomplete.

   Verify: retain raw outputs/hashes/screenshots required by `docs/platform-distribution-plan.md`.

## Test plan

L1 narrow examples:

```bash
bun test tests/frontend/route-surface-contract.test.ts
bun test tests/frontend/persistence-contract.test.ts
bun test tests/frontend/external-store.test.ts
bun test tests/frontend/runtime-command-transitions.test.ts
bun test tests/frontend/payment-input-adapter.test.ts
bun test tests/frontend/swap-request-identity.test.ts
```

Run all changed focused targets; do not use these examples as a substitute for the actual changed-file test map.

L2 targeted browser/native:

```bash
bun run test:e2e:payment:smoke
bun run test:e2e:flows
bun run native:mobile
bun run native:desktop:smoke
```

Run the isolated Playwright specs for site, docs, wallet shell/recovery, accounts/payments, swap/history, and ops. Use F12 console and screenshot inspection at iPhone, laptop, and wide desktop/Mac Studio.

L3 broad/release gates:

```bash
bun run check
bun run gate:ci
bun run gate:release
```

Run each broad gate once on the unchanged release candidate. If one fails, return to a focused L1/L2 test, change code, then rerun the affected broad gate on the new candidate.

## Done criteria

- [ ] React/Vite/TypeScript is the only active frontend implementation and build path.
- [ ] Site, docs, wallet, and ops ship from one commit/version/manifest and activate atomically on one origin.
- [ ] No `.svelte`, Svelte/SvelteKit dependency, adapter, fallback route, selector flag, or compiler-specific test remains.
- [ ] Existing persisted profiles open without migration/data loss; real financial flows preserve canonical command and completion semantics.
- [ ] Browser/native/PWA/extension route, visual, console, and build-identity evidence is complete.
- [ ] `bun run check`, `gate:ci`, and `gate:release` pass on the exact unchanged candidate.
- [ ] `git status --short` is reviewed and the Plan 011 index row is updated.

## Stop conditions

- Any parity discrepancy involving storage, financial intent/completion, Runtime/Entity/Account semantics, route ownership, PWA/native behavior, or artifact identity is a release blocker.
- Any desire to keep a temporary Svelte fallback conflicts with the single-canonical-path rule; stop and resolve the React defect.
- Any frozen-core violation is a hard stop with old/new hashes reported to the owner.
- Production activation requires explicit owner authority even after all repository work is complete.

## Rollback rule

Rollback is the atomic Plan 002 pointer switch to the complete previous frontend release. It must not restore selected Svelte files, mix surface versions, change persisted data, or run a compatibility reader. Investigate and fix forward on a new complete release candidate.

## Suggested toolkit

- [Vite 7 build guide](https://github.com/vitejs/vite/blob/v7.3.1/docs/guide/build.md)
- [React `useSyncExternalStore`](https://react.dev/reference/react/useSyncExternalStore)
- Use `vercel-react-best-practices`, `web-design-guidelines`, and browser automation skills if available.

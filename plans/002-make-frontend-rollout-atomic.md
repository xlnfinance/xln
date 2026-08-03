# Plan 002 — Make multi-surface rollout atomic

> **Executor instructions:** Follow the steps in order and run every verification
> command. Update Plan 002 in `plans/README.md` when complete. This plan authorizes
> repository changes and local fixtures only—not a live deployment.
>
> **Drift check (run first):**
> `git diff --stat 5749e283d..HEAD -- scripts/deployment scripts/native package.json frontend/package.json docs`
> Reconcile any changed deployment/native contract before editing; a semantic
> mismatch is a STOP condition.

## Status

- **Priority:** P1
- **Effort:** L
- **Risk:** HIGH
- **Depends on:** none
- **Category:** migration, release engineering
- **Planned at:** commit `5749e283d`, 2026-08-03

## Executor instructions

Use a clean `ai/atomic-frontend-rollout` branch and writer-owned worktree. Revalidate line locations if HEAD differs from `5749e283d`. This plan may change deployment scripts and repository-owned infrastructure examples, but it must not deploy to production or alter live infrastructure without a separate explicit owner instruction. Do not touch frozen core.

## Why this exists

The current deployment path removes `frontend/build` before extracting a replacement and verifies only `index.html`. Splitting the frontend into multiple artifacts increases both outage and mixed-version risk. The release needs one manifest, one staged version directory, one atomic activation, and one rollback operation before React can become canonical.

## Current evidence

- `scripts/deployment/deploy-platform.sh` removes the deployed build directory, extracts in place, then checks only `index.html`.
- The repository Nginx example serves one `frontend/build` root with a generic page fallback.
- `scripts/native/build-platforms.ts` discovers/copies the whole build for mobile, Electron, and extension targets.
- `docs/platform-distribution-plan.md` requires a single tagged commit/version, hashes, screenshots, and `bun run check` evidence.
- `docs/status.md` treats the platform as one coherent deployment surface.

## Target release layout

```text
releases/
  <version-or-commit>/
    release-manifest.json
    site/
    docs/
    wallet/
    ops/
current -> releases/<version-or-commit>
previous -> releases/<prior-version-or-commit>
```

The actual pointer mechanism may be a same-filesystem symlink or an equivalent atomic rename supported by the production host. Resolve exact host capabilities read-only before implementation. Never activate by copying files over the live tree.

## Scope

In scope:

- Deterministic release manifest with source commit, product version, surface hashes, route-contract hash, asset inventory, and required native inputs.
- Versioned upload/staging, complete validation, atomic activation, post-activation health checks, and one-command rollback.
- Nginx/static-host mapping from stable URL prefixes to the active release’s surface roots.
- Native builders consuming the same release manifest and refusing mixed/missing artifacts.

Out of scope:

- React source migration.
- Independent surface versions, partial activation, or compatibility fallbacks.
- A production deployment during implementation.

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Drift | `git diff --stat 5749e283d..HEAD -- scripts/deployment scripts/native package.json frontend/package.json docs` | Exit 0; relevant drift reviewed |
| L1 manifest/routing | `bun test tests/deployment/frontend-release-manifest.test.ts tests/deployment/frontend-route-map.test.ts` | Exit 0; invalid fixtures rejected |
| Atomic fixture | `bun test tests/deployment/atomic-frontend-rollout.test.ts` | Exit 0; activate/rollback cases pass |
| Native mobile | `bun run native:mobile` | Exit 0; manifest-bound package produced |
| Native desktop | `bun run native:desktop:smoke` | Exit 0; smoke passes |
| Broad gate | `bun run check` | Exit 0; no frozen-core violation |

## Git workflow

- Branch: `ai/atomic-frontend-rollout`; exactly one writer owns its worktree.
- Commit logical units, for example `feat(deploy): stage frontend releases atomically`.
- Do not push, open a PR, or touch live infrastructure unless explicitly instructed.

## Files to inspect and likely change

- `scripts/deployment/deploy-platform.sh`
- Repository-owned Nginx example/config and its tests
- `scripts/native/build-platforms.ts`
- Root and frontend package scripts that assemble distribution artifacts
- `docs/platform-distribution-plan.md` and relevant lowercase docs under `docs/`
- New pure manifest builder/validator under `scripts/deployment/` plus focused tests

## Implementation steps

1. Define one immutable release-manifest schema. It must reject unknown/missing surface entries, record SHA-256 hashes for every artifact, bind all surfaces to one git commit and product version, include route-contract and asset-list hashes, and state which surfaces each native target consumes.

   Verify: unit tests cover valid manifest, altered file, missing surface, version mismatch, path traversal, duplicate output, and a surface produced from a different commit.

2. Refactor build packaging so artifacts are assembled in a fresh staging directory named by the resolved version/commit. Validate paths before any cleanup. Generate the manifest only after all expected files exist, then validate the staged tree against it.

   Verify: packaging twice from unchanged inputs yields identical manifest content and hashes. An injected corrupt file causes a loud failure before activation.

3. Replace in-place deletion/extraction in `deploy-platform.sh` with upload to a fresh remote staging directory, remote checksum validation, manifest validation, and atomic pointer switch. Preserve at least the current and previous complete releases. Validate the resolved target is within the configured release root before pruning old versions.

   Verify: an integration fixture proves failed upload, corrupt manifest, failed validation, and interrupted staging leave the current pointer unchanged.

4. Add rollback that validates the previous release manifest, atomically moves the active pointer back, and performs the same health checks. Rollback must never assemble a hybrid release.

   Verify: local deployment fixture activates A, activates B, rolls back to A, and confirms all surface build identities move together.

5. Make URL mapping explicit. `/docs` and `/docs-catalog/**` resolve to docs; `/app`, `/address/**`, `/testnet`, root-scoped PWA/worker assets, and wallet runtime assets resolve to wallet; public paths resolve to site; operator paths resolve to ops; runtime endpoints remain proxied. Unknown page paths fail according to the route contract, not a universal cross-surface fallback.

   Verify: a routing test matrix checks every route owner from Plan 001 and prevents site fallback from swallowing wallet, docs, ops, or edge URLs.

6. Update native packaging to read and validate `release-manifest.json`, then copy the declared wallet plus shared native assets. Remove implicit “copy the entire build” discovery. Embed version/commit identity for diagnostics.

   Verify: mobile, Electron, and extension packaging reject absent/mismatched wallet artifacts and report the exact missing hash/path.

7. Expose a non-sensitive build identity endpoint or static JSON from the active release. Health verification must confirm the expected commit/version for every surface after activation, then run a minimal URL matrix. Never treat `index.html` alone as health.

   Verify: a fixture with site from A and wallet from B is rejected even when all entry HTML files exist.

## Test plan

L1 narrow:

```bash
bun test tests/deployment/frontend-release-manifest.test.ts
bun test tests/deployment/frontend-route-map.test.ts
```

L2 targeted flow:

```bash
bun test tests/deployment/atomic-frontend-rollout.test.ts
bun run native:mobile
bun run native:desktop:smoke
```

Use a temporary local release root; never point tests at the live host. Inspect the packaged native content and embedded build identity.

L3 broad gate:

```bash
bun run check
```

Run once on the unchanged candidate and provide output. Do not deploy merely to prove the plan.

## Done criteria

- [ ] Activation and rollback switch all surface artifacts as one release.
- [ ] Corrupt, incomplete, mixed-commit, or path-unsafe staging cannot affect the live pointer.
- [ ] Nginx/static routing has an exhaustive route-owner matrix.
- [ ] Native builders consume manifest-declared artifacts and fail loudly on drift.
- [ ] Documentation describes exact staging, activation, health, rollback, and retention commands.
- [ ] `bun run check` passes without a frozen-core violation.
- [ ] `git status --short` contains only reviewed in-scope changes, and the Plan 002 index row is updated.

## Stop conditions

- If the production filesystem cannot provide atomic rename/symlink semantics, stop and present supported atomic alternatives before choosing one.
- If rollback would mutate databases or persisted wallet state, stop; frontend artifact rollback must be stateless.
- Never execute a production deployment or destructive live cleanup without explicit authority and exact target validation.

## Maintenance note

The manifest schema is the release boundary, not a React-specific detail. Keep it independent of implementation framework and require it for every future surface build.

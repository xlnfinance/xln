# Plan 004 — Migrate docs to an independent React/Vite surface

> **Executor instructions:** Follow every step and verification command after
> Plan 003 is `DONE`. Update the Plan 004 row in `plans/README.md` when complete.
> Keep this artifact release-blocked until Plan 011.
>
> **Drift check (run first):**
> `git diff --stat 5749e283d..HEAD -- frontend/copy-static-files.js frontend/src/routes/docs frontend/src/lib/ai frontend/package.json docs tests/docs-site.spec.ts`
> Review prerequisite drift and re-characterize changed catalog behavior. A URL
> or schema mismatch is a STOP condition.

## Status

- **Priority:** P2
- **Effort:** L
- **Risk:** MED
- **Depends on:** `plans/003-migrate-public-site-to-react-vite.md`
- **Category:** migration, docs
- **Planned at:** commit `5749e283d`, 2026-08-03

## Executor instructions

Continue in the same writer-owned `ai/react-frontend-migration` worktree. Reconcile against completed Plans 001–003 and current HEAD before editing. Do not publish, merge, or deploy the intermediate React docs artifact. Do not create placeholder documentation or copy generated content into source by hand.

## Why this exists

The visible docs route is separable, but its data pipeline is not: `frontend/copy-static-files.js` currently generates/copies the docs catalog alongside contracts, BrainVault worker assets, scenarios, `llms` outputs, and other release inputs. The wallet guide also reads `/docs-catalog`. Splitting only the page would leave a hidden monolith and risk incomplete releases.

## Current evidence

- Docs are served at `/docs`; catalog data is served below `/docs-catalog/**`.
- `frontend/copy-static-files.js` copies all docs and creates the catalog manifest while also handling unrelated contracts, worker, scenario, and AI outputs.
- `frontend/src/lib/ai/xln-guide-context.ts` fetches `/docs-catalog`, so the catalog remains a same-origin shared artifact even after UI separation.
- `tests/docs-site.spec.ts` covers desktop and iPhone but needs the repository-required laptop/wide matrix from Plan 001.
- The global Svelte layout currently gives docs public chrome plus wallet/native initialization responsibilities.

## Target boundary

The docs producer is a pure/deterministic script with explicit inputs and outputs. It writes a docs artifact containing the React reader, catalog manifest/content, `llms` files, and build identity. The wallet may fetch the catalog through its stable URL contract but may not import the docs React application.

## Scope

In scope:

- Extracted docs-catalog generator with validated paths, deterministic sorting, content hashes, and loud failures.
- React implementation of `/docs` and its document-selection/search/navigation states.
- Stable `/docs-catalog/**` and `llms*` URLs for browser and wallet consumers.
- Docs-only build, import boundaries, accessibility, search/navigation, deep links, and visual coverage.

Out of scope:

- Rewriting documentation content.
- Embedding docs into the wallet bundle.
- Search service/backend, SSR, or independent docs release/version.

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Drift | `git diff --stat 5749e283d..HEAD -- frontend/copy-static-files.js frontend/src/routes/docs frontend/src/lib/ai frontend/package.json docs tests/docs-site.spec.ts` | Exit 0; catalog drift reviewed |
| L1 | `bun test tests/frontend/docs-catalog-generator.test.ts tests/frontend/docs-catalog-contract.test.ts tests/frontend/docs-import-boundaries.test.ts` | Exit 0; deterministic/error cases pass |
| Docs browser | `bun scripts/testing/run-static-frontend-e2e.ts tests/docs-site.spec.ts` | Exit 0; clean browser health |
| Broad gate | `bun run check` | Exit 0; no frozen-core violation |

## Git workflow

- Branch: continue `ai/react-frontend-migration`; do not create another writer worktree.
- Use a coherent checkpoint such as `wip: migrate docs surface to React`.
- Do not push for deployment, merge, or release before Plan 011.

## Files to inspect and likely change

- `frontend/copy-static-files.js`
- Current docs route/components under `frontend/src/routes/docs` and `frontend/src/lib/**`
- `frontend/src/lib/ai/xln-guide-context.ts`
- Docs source tree under `docs/`
- New `frontend/apps/docs/**` and a narrowly scoped docs generator under `frontend/scripts/`
- `tests/docs-site.spec.ts` and focused generator/consumer tests

## Implementation steps

1. Characterize the current docs artifact exactly: source roots, exclusions, URL encoding, order, title/path metadata, manifest shape, `llms` outputs, symlink policy, and missing-file behavior. Add fixture tests before extraction.

   Verify: the characterization test snapshots metadata and hashes, not volatile filesystem timestamps.

2. Split `copy-static-files.js` into explicit pure producers. The docs producer must accept input/output roots as arguments, validate both roots, sort deterministically, reject path traversal and duplicate URLs, and fail loudly on malformed/unreadable content. Unrelated contract/worker/scenario producers remain separate commands with their existing ownership.

   Verify: unchanged fixtures produce byte-identical catalog/manifests; malformed frontmatter, duplicate normalized paths, and missing source roots fail with actionable messages.

3. Define a framework-neutral catalog schema and parser in `frontend/packages/client-core` or a dedicated docs-contract module. Both the React docs app and wallet guide client consume the same validated schema. Do not duplicate the fetch/parse rules.

   Verify: contract tests exercise current catalog plus corrupt, partial, and unsupported-version documents. Validation occurs at ingestion; consumers do not add defensive optional chains around invalid data.

4. Build the React docs root and port the complete reader: document tree, selection/deep linking, headings/table of contents, search/filter if currently present, Markdown rendering, code blocks, keyboard focus, loading, and explicit errors. Preserve safe rendering/sanitization behavior and external-link policy.

   Verify: direct navigation to representative nested documents works from a cold browser load, back/forward behavior is stable, and invalid document IDs visibly fail rather than silently showing the first page.

5. Keep public/docs chrome local to the docs app. It may use stable shared site UI primitives but must not initialize vault, runtime, push, native shell, command journal, or wallet stores.

   Verify: import-boundary and browser network tests show no wallet/runtime/native modules or initialization calls in docs output.

6. Emit `frontend/build/docs`, add it to the unified release manifest, and guarantee `/docs-catalog/**` remains readable from `/app` on the same origin. Do not copy docs into wallet output; release routing owns the shared URL.

   Verify: a wallet-guide integration test fetches a representative catalog document through the real dev-server route, and release validation rejects a docs catalog hash mismatch.

7. Expand docs Playwright coverage to iPhone, laptop, and wide desktop for index, nested article, search/filter, code block, and error state. Check browser console/network and inspect every screenshot.

   Verify: no horizontal overflow, clipped navigation, inaccessible mobile drawer, layout shift, broken anchor, or console exception.

## Test plan

L1 narrow:

```bash
bun test tests/frontend/docs-catalog-generator.test.ts
bun test tests/frontend/docs-catalog-contract.test.ts
bun test tests/frontend/docs-import-boundaries.test.ts
```

L2 targeted browser:

```bash
bun scripts/testing/run-static-frontend-e2e.ts tests/docs-site.spec.ts
```

Also run the focused wallet-guide/catalog integration spec created or updated by this plan. Inspect F12 console/network and all key-state screenshots.

L3 broad gate:

```bash
bun run check
```

Run once on the unchanged checkpoint candidate.

## Done criteria

- [ ] Docs generation is an independently callable deterministic producer.
- [ ] `/docs` is fully implemented in React with stable deep links and validated catalog ingestion.
- [ ] `/docs-catalog/**` and `llms*` URLs remain compatible for the wallet and release consumers.
- [ ] Docs output contains no wallet/runtime/native application code.
- [ ] Artifact is release-manifest valid but remains release-blocked.
- [ ] `bun run check` passes; record only a `wip:` checkpoint.
- [ ] `git status --short` is reviewed and the Plan 004 index row is updated.

## Stop conditions

- If the wallet depends on undocumented catalog behavior, stop and add that behavior to the shared contract before migration.
- If extraction changes generated URLs or document identity, stop and present an explicit offline/URL migration; do not add alias readers.
- Do not ship an independently versioned docs artifact.

## Suggested toolkit

- [Vite 7 build guide](https://github.com/vitejs/vite/blob/v7.3.1/docs/guide/build.md)
- Use `vercel-react-best-practices` if available for chunk and render review.

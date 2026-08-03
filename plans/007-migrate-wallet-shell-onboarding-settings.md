# Plan 007 — Migrate the wallet shell, onboarding, recovery, and settings

> **Executor instructions:** Follow all steps after Plan 006 is `DONE`; update the
> Plan 007 index row when complete. Use only the canonical external-store/controller
> adapters. Do not activate this partial wallet or proxy unfinished views to Svelte.
>
> **Drift check (run first):**
> `git diff --stat 5749e283d..HEAD -- frontend/src/routes/app frontend/src/lib/components frontend/src/lib/stores frontend/src/app.html frontend/static frontend/capacitor.config.ts tests`
> Rebuild the boot-state inventory for any changed lifecycle code. A missing state
> or native/PWA contract mismatch is a STOP condition.

## Status

- **Priority:** P1
- **Effort:** L
- **Risk:** HIGH
- **Depends on:** `plans/006-extract-vault-command-external-stores.md`
- **Category:** migration
- **Planned at:** commit `5749e283d`, 2026-08-03
- **Execution:** IN PROGRESS — boot, shell, onboarding, build, and candidate browser checkpoint implemented

## Executor instructions

Continue the single writer-owned `ai/react-frontend-migration` worktree. Verify Plans 005–006 left one canonical external-store/controller implementation and use only its React adapters. Do not port Svelte stores into components, create parallel boot logic, or activate the React wallet in production. Preserve current test IDs where they identify user behavior.

This plan must implement complete user flows with real store/runtime integrations. No mock vaults, fake registration, skipped errors, or placeholder panels.

## Why this slice comes first

The current `/app` layout owns a large boot sequence: environment/native detection, runtime loading, vault state, active-tab coordination, recovery, settings, navigation, and error UI. All later account/payment/swap panels require this lifecycle to be correct under browser reload, React Strict Mode, mobile shells, and multi-tab use.

## Current evidence

- The current app layout imports Svelte lifecycle, SvelteKit navigation/stores, and multiple boot-state modules.
- Global `app.html` redirects Capacitor root loads to `/app`, while the root Svelte layout initializes native behavior for every route.
- Vault and runtime store extraction from Plans 005–006 preserves origin-bound localStorage/IndexedDB and real controller semantics.
- `frontend/src/lib/components/RuntimeCreation.svelte` is about 2,371 LOC, indicating this is not a simple component translation.
- PWA `start_url`/`scope`, push service worker, native bridge, and active-tab behavior are part of wallet entry correctness.

## Scope

In scope:

- React `/app` entry, boot coordinator, global error boundary, loading/error/offline states, wallet navigation shell, native initialization, active-tab ownership.
- Create/import/unlock/lock/recover wallet flows, runtime creation/selection, settings, and first-run onboarding.
- PWA and native-shell entry behavior needed to reach these flows.
- Visual/accessibility/console coverage at iPhone, laptop, and wide desktop.

Out of scope:

- Account/payment, swap/history, and operator panel bodies; Plans 008–010 own them.
- Redesign of vault format, runtime protocol, or product navigation information architecture.
- Production activation.

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Drift | `git diff --stat 5749e283d..HEAD -- frontend/src/routes/app frontend/src/lib/components frontend/src/lib/stores frontend/src/app.html frontend/static frontend/capacitor.config.ts tests` | Exit 0; lifecycle drift reconciled |
| L1 | `bun test tests/frontend/wallet-boot-machine.test.ts tests/frontend/wallet-shell.test.tsx tests/frontend/wallet-onboarding.test.tsx tests/frontend/wallet-native-entry.test.ts` | Exit 0; state/lifecycle cases pass |
| Shell browser | `bun runtime/scripts/run-e2e-parallel-isolated.ts --strict-browser-health --shards=1 --workers-per-shard=1 --pw-project=chromium --pw-files=tests/wallet-shell-onboarding.spec.ts` | Exit 0; clean browser health |
| Recovery browser | `bun runtime/scripts/run-e2e-parallel-isolated.ts --strict-browser-health --shards=1 --workers-per-shard=1 --pw-project=chromium --pw-files=tests/vault-reload-and-recovery.spec.ts` | Exit 0; persistence/recovery pass |
| Native | `bun run native:mobile && bun run native:desktop:smoke` | Both exit 0 |
| Broad gate | `bun run check` | Exit 0; no frozen-core violation |

## Git workflow

- Branch: continue the sole `ai/react-frontend-migration` writer worktree.
- Use a coherent checkpoint such as `wip: migrate wallet shell to React`.
- Do not push for deployment, merge, or release before Plan 011.

## Files to inspect and likely change

- Current `/app` route layout/page and wallet shell components
- `RuntimeCreation.svelte`, onboarding, recovery, settings, navigation, error/toast, modal components
- Native/Capacitor initialization and active-tab modules
- PWA manifest/push registration consumers
- New `frontend/apps/wallet/**` React entries/components
- Wallet shell/onboarding/recovery Playwright specs

## Implementation steps

1. Characterize the current wallet boot state machine from cold load through usable wallet. Enumerate environment detection, native readiness, vault status, runtime/controller readiness, active-tab acquisition, persisted navigation, and fatal/retryable errors. Express it as pure states/events backed by Plans 005–006, not component-local booleans.

   Verify: table-driven tests cover browser, Capacitor, Electron, locked vault, missing runtime, restored runtime, inactive tab, corrupt persisted data, controller failure, and reload during initialization.

2. Create the React wallet entry and root error boundary. Initialize the canonical boot controller exactly once outside render, subscribe with `useSyncExternalStore`, and render explicit states. Error boundaries must show actionable failure details and allow only safe, explicit retry operations; never swallow or auto-reset state.

   Verify: React Strict Mode does not duplicate controller, storage, service-worker, native bridge, or runtime initialization.

3. Port the responsive wallet shell: navigation, top-level status, modal/dialog layer, toast/error surface, offline/connecting state, and active-tab warning. Replace Svelte transitions with minimal CSS/React behavior that preserves accessibility and focus. Do not import the public site or ops application.

   Verify: keyboard-only navigation, focus return, escape behavior, reduced motion, screen-reader labels, and all viewport screenshots are correct.

4. Port wallet create/import/unlock/lock/recovery flows using Plan 006 controller commands. Inputs are validated at form boundaries; secret fields are never logged or persisted outside existing protected storage. Each command has visible pending, success-evidence, and loud error states.

   Verify: real browser flows cover create → reload → unlock → lock, import → reload, failed unlock, interrupted recovery, and successful recovery without exposing secrets in traces/screenshots.

5. Decompose and port runtime creation/selection from `RuntimeCreation.svelte` into small React components around pure state and controller commands. Preserve exact validation and real registration behavior. Never return fake entity/runtime identifiers for UI progress.

   Verify: real runtime creation/selection integration proves persisted selection, reload behavior, failure detail, and no duplicate registration under repeat clicks or remount.

6. Port settings, including theme/display/network preferences and any native-specific toggles, through the Plan 005 settings external store. Apply settings synchronously from the canonical snapshot where needed to avoid theme/layout flash; do not create another browser-storage writer.

   Verify: settings survive reload and update one store exactly once across React and remaining Svelte test consumers.

7. Move Capacitor/Electron/extension/PWA entry initialization into the wallet entry only. Preserve root-to-`/app` native behavior, PWA start/scope, push service-worker scope, and push-open `/app` URL. Web public/docs entries must remain free of this code.

   Verify: browser bundle/import tests and native smoke fixtures prove environment-specific initialization occurs once only in wallet output.

8. Add temporary honest navigation states for panels not yet migrated only in the non-release React artifact: either keep them inaccessible until their owning plan lands or route tests directly to completed shell flows. Do not render “coming soon” production UI and do not proxy users back into Svelte.

   Verify: artifact/release validation still marks the React wallet incomplete and Plan 002 cannot activate it.

## Test plan

L1 narrow:

```bash
bun test tests/frontend/wallet-boot-machine.test.ts
bun test tests/frontend/wallet-shell.test.tsx
bun test tests/frontend/wallet-onboarding.test.tsx
bun test tests/frontend/wallet-native-entry.test.ts
```

L2 targeted browser/native:

```bash
bun runtime/scripts/run-e2e-parallel-isolated.ts --strict-browser-health --shards=1 --workers-per-shard=1 --pw-project=chromium --pw-files=tests/wallet-shell-onboarding.spec.ts
bun runtime/scripts/run-e2e-parallel-isolated.ts --strict-browser-health --shards=1 --workers-per-shard=1 --pw-project=chromium --pw-files=tests/vault-reload-and-recovery.spec.ts
bun run native:mobile
bun run native:desktop:smoke
```

Inspect F12 console/storage/service-worker state and screenshots at iPhone, laptop, and wide desktop.

L3 broad gate:

```bash
bun run check
```

Run once on the unchanged checkpoint candidate.

## Done criteria

- [ ] React wallet boot is an explicit tested state machine over the canonical external stores.
- [ ] Create/import/unlock/lock/recover, runtime creation/selection, and settings work with real integrations.
- [ ] Strict Mode and multi-tab behavior do not duplicate initialization or commands.
- [ ] Native/PWA initialization belongs only to wallet and preserves current same-origin behavior.
- [ ] Every key state has clean-console, inspected screenshots at all required viewports.
- [ ] Artifact remains release-blocked; `bun run check` passes; commit only as `wip:`.
- [ ] `git status --short` is reviewed and the Plan 007 index row is updated.

## Current checkpoint evidence

- Pure boot states and an injected controller now cover browser, Capacitor, Electron, inactive-tab takeover, empty/locked/connecting/ready vaults, failure classification, Strict Mode duplicate starts, and reload disposal fencing.
- The release-blocked React wallet candidate builds `/app`, `/address/**`, and `/testnet`, owns its native/PWA entry assets, and keeps public site/docs bundles free of native initialization.
- Real canonical vault commands back create/import/unlock/lock/recovery/runtime selection; React components receive typed commands and a secret-redacted wallet projection instead of storage or protection ports.
- L1 plus adjacent boundary evidence: 41 tests / 140 assertions pass. Candidate-only Playwright: 2 flows pass in 4.2 seconds with clean console/network health and inspected iPhone, laptop, and wide screenshots.
- Remaining before Plan 007 `DONE`: real create → reload → unlock/lock/recover integration on the React artifact, ready/locked/recovery viewport evidence, native mobile/desktop smoke, and the unchanged-commit broad gate.

## Stop conditions

- Any unclear vault, active-tab, recovery, or runtime initialization semantic requires owner clarification.
- Any need for a fake backend/runtime response is a hard stop.
- Do not add compatibility redirects to Svelte or ship a partial React wallet.

## Suggested toolkit

- [React `useSyncExternalStore`](https://react.dev/reference/react/useSyncExternalStore)
- Use `vercel-react-best-practices` for lifecycle, Strict Mode, and bundle review.
- Use `web-design-guidelines` for the final accessibility/UI review if available.

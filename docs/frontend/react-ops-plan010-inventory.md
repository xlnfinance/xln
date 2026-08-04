# React ops Plan 010 route, capability, and resource inventory

This inventory is the parity and ownership contract for the independently built React operator/developer surface. It records only UI ownership; Runtime, QA, edge, and AI services retain their existing endpoint and authority rules.

## Route and capability ownership

| Route | Audience | Capability and data owner | Mobile policy | Failure behavior |
|---|---|---|---|---|
| `/health` | Production operator | Read-only `/api/health`, RPC reachability, and the existing Runtime adapter projection | Supported | Malformed fields fail visibly; pre-bootstrap Hubs are labeled `pending:<name>` and never reported ready |
| `/qa` | Production operator | `/api/qa/runs`, catalog, history, restart audit, stories, and run detail; server-projected admin authority | Supported | Read failures remain visible; plan/restart, purge, backfill, and abort stay disabled unless server authority allows them and the operator confirms |
| `/runs` | Production operator | Read-only `/api/qa/runs` ledger and existing QA token storage | Supported as labeled evidence cards | Unknown/malformed run evidence fails visibly; status, duration, artifacts, browser health, and commit evidence are never inferred |
| `/scenarios` | Developer | Browser `runtime.js` scenario registry with persistence disabled | 2D controls supported; Dockview shows a tested laptop-width message | Real scenarios only; empty history, missing runners, module mismatch, or teardown failure is explicit |
| `/ai` and `/ai/:chatId` | Developer | Existing local AI service at `localhost:3031`: models, chats, streaming chat, council, stats, and `/api/xln/**` tools | Supported | Service or schema errors are shown; tools require the exact `EXECUTE <tool>` phrase before the existing execute endpoint is called |
| `/embed` | Runtime-free integration audience | Recorded URL-hash trail, or an explicitly selected browser Runtime scenario | Supported | Unknown scenario, malformed trail, invalid speed, wrong-origin messages, and malformed versioned commands are rejected |

`/admin` remains the edge redirect to `/health`. `/radapter` remains the query-rejecting edge redirect. `/rpc`, `/rpc2`, and `/resetdb` are not React manifest entries. The ops shell does not inherit site or wallet navigation and imports no vault-secret controller.

## Panel and serialized-layout ownership

| Panel ID | Component | State source | Resource owner |
|---|---|---|---|
| `graph` | Lazy `Graph3DPanel` | Pure projection of the selected immutable Runtime frame | Owns one Three.js renderer, RAF, ResizeObserver, geometry, material, and canvas while active; disposes all on hide or root unmount |
| `inspector` | `InspectorPanel` | Scenario graph projection | Read-only React root; no ambient resource |
| `architect` | `ArchitectPanel` | Exact Runtime input/output/log evidence serialized with `safeStringify` | Read-only React root; no mutation path |

The layout key is `xln-ops-dock-layout-v1`. Vanilla `DockviewComponent` is retained. Each live panel ID owns one `createRoot`; duplicate roots/panels fail loudly, and panel/workspace disposal calls `root.unmount()`. Invalid saved layout is reported and reset to the canonical graph/inspector/architect workspace. The graph is the deterministic initial active panel; restored layouts preserve their active panel.

## Controller and teardown inventory

- Health polling is a ref-counted external-store controller with a four-second UI timer and delayed Strict Mode-safe teardown.
- Scenario loading has request-version cancellation, disables persistence, stops jurisdiction watchers and the Runtime loop, and owns playback timers outside deterministic Runtime state.
- AI requests own an `AbortController`; navigation, replacement requests, and unmount abort in-flight reads/streams.
- Embed playback owns one interval and one `message` listener. Only exact version-1 same-origin parent commands are accepted; both resources are removed on unmount.
- No ops web worker is created. Dockview resize observation and subscriptions are disposed with the workspace.

## Canonical financial boundary

`ops-delta-adapter.ts` is the only ops source allowed to import `@xln/runtime/account/utils`. It validates mandatory bilateral fields and delegates exclusively to canonical `deriveDelta`; graph, inspector, and view code contain no parallel delta, credit, collateral, or capacity formula.

## Independent artifact and lazy-load evidence

The release-blocked artifact is `frontend/build/ops`, with six HTML entries and its own candidate manifest. The final Plan 010 build transformed 1,426 modules:

| Chunk | Minified | Gzip | Load boundary |
|---|---:|---:|---|
| Shared ops root | 199.21 kB | 62.96 kB | Every ops entry |
| `ScenariosPage` | 218.62 kB | 50.11 kB | `/scenarios` only |
| `Graph3DPanel` | 472.51 kB | 119.09 kB | Lazy, only when the Dockview graph panel mounts |
| `HealthPage` | 776.22 kB | 223.80 kB | `/health` only; includes the existing Runtime adapter projection |
| `AiPage` | 11.51 kB | 3.90 kB | `/ai/**` only |
| CSS | 53.35 kB | 8.14 kB | Ops artifact only |

Source/import boundary tests prove Three.js has one lazy owner and site/docs/wallet applications do not import the ops application. The artifact remains activation-blocked until Plan 011 composes the atomic release.

## Verification evidence

- React TypeScript: `tsc -p frontend/tsconfig.react.json --noEmit` passed.
- L1 contract/lifecycle/import/delta suite: 11 tests and 63 assertions passed before final broad-gate execution.
- Health/QA/runs: strict Chromium browser health passed in 13.1 seconds with nine inspected wide, laptop, and iPhone screenshots; evidence run `20260804-193114-180`.
- Scenario/Dockview/embed: strict Chromium checks passed in 19.4 seconds. They cover a real 27-frame dispute scenario, graph focus, one active canvas, suspended hidden rendering, layout restoration, and exact same-origin embed commands; evidence run `20260804-193417-430`.
- AI service ownership remains external to the isolated browser stack. The React route preserves the existing `localhost:3031` contract and fails visibly when that separately operated service is absent; no fallback or fake model/chat/tool data was added.

## Retired migration candidates

The React ops artifact replaces the reachable Svelte route implementations only at the atomic Plan 011 cutover. No old panel is deleted in Plan 010 because the canonical Svelte application is still active. Plan 011 must remove those route and panel owners in the same activation commit, not retain compatibility aliases.

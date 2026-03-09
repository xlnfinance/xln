# Done Log

## 2026-03-09

- Unified WebSocket transport serialization with the canonical tagged JSON codec in [ws-protocol.ts](/Users/egor/xln/runtime/networking/ws-protocol.ts).
  - Removed the separate `_type: 'BigInt'/'Map'` WS codec.
  - WS now uses the same `serializeTaggedJson` / `deserializeTaggedJson` path as runtime persistence and server RPC.
  - This fixed strict gossip profile ingestion where `baseFee` was arriving in a different wire shape than the runtime parser expected.
- Hardened strict gossip profile parsing in:
  - [gossip.ts](/Users/egor/xln/runtime/networking/gossip.ts)
  - [gossip-helper.ts](/Users/egor/xln/runtime/networking/gossip-helper.ts)
  - [p2p.ts](/Users/egor/xln/runtime/networking/p2p.ts)
  - [profile-signing.ts](/Users/egor/xln/runtime/networking/profile-signing.ts)
  - [relay-store.ts](/Users/egor/xln/runtime/relay-store.ts)
  - [profile-batch.ts](/Users/egor/xln/runtime/relay/profile-batch.ts)
  - [htlc-payment.ts](/Users/egor/xln/runtime/entity-tx/handlers/htlc-payment.ts)
  - profiles now use required top-level `name/avatar/bio/website/lastUpdated`
  - required `publicAccounts/hubs/endpoints/relays/accounts`
  - required encryption keys in metadata, with fail-fast parsing/normalization
- Fixed the E2E mesh debug API in [e2e-mesh-control.ts](/Users/egor/xln/runtime/scripts/e2e-mesh-control.ts) to return BigInt-safe JSON via the shared serializer instead of raw `JSON.stringify(...)`.
  - This unblocked custody bootstrap discovery during isolated test runs.
- Re-verified custody after the transport/profile fixes:
  - [/Users/egor/xln/.logs/e2e-parallel/20260309-194110-534/e2e-shard-00.log](/Users/egor/xln/.logs/e2e-parallel/20260309-194110-534/e2e-shard-00.log)
- Re-ran the full isolated E2E stack and it passed on the current worktree:
  - [/Users/egor/xln/.logs/e2e-parallel/20260309-194237-730/e2e-shard-00.log](/Users/egor/xln/.logs/e2e-parallel/20260309-194237-730/e2e-shard-00.log)

### Prod Custody / Deploy

- Added a dedicated prod custody supervisor in [start-custody-prod.ts](/Users/egor/xln/runtime/scripts/start-custody-prod.ts).
  - It waits for the main stack (`runtime + relay + 3 hubs + MM`), starts a separate custody daemon on `:8088`, initializes custody only on first boot, restores the same custody entity on restart, and then starts the custody dashboard on `:8087`.
  - The custody daemon remains a plain separate runtime with `BOOTSTRAP_LOCAL_HUBS=0`; routing stays entity-level, not daemon-level.
- Added a production wrapper [start-custody.sh](/Users/egor/xln/scripts/start-custody.sh).
- Updated [deploy.sh](/Users/egor/xln/deploy.sh) so remote prod deploys run in explicit `--production` mode and directly manage the two real PM2 processes:
  - `xln-server`
  - `xln-custody`
- Added `bun run custody:prod` in [package.json](/Users/egor/xln/package.json).

### Canonical Jurisdictions / Shards

- Fixed [jurisdictions-path.ts](/Users/egor/xln/runtime/jurisdictions-path.ts) to resolve the canonical `jurisdictions/jurisdictions.json` from module location instead of `process.cwd()`.
- Fixed isolated mesh bootstrap in [e2e-mesh-control.ts](/Users/egor/xln/runtime/scripts/e2e-mesh-control.ts):
  - each shard now seeds its own `jurisdictions.json` copy before `H1` starts
  - shard processes use `XLN_JURISDICTIONS_PATH` to read only their shard copy
- Fixed [e2e-hub-node.ts](/Users/egor/xln/runtime/scripts/e2e-hub-node.ts) so shard nodes update canonical `arrakis` inside the shard file instead of inventing `arrakis_<port>` entries.
- Hardened [server.ts](/Users/egor/xln/runtime/server.ts) so runtime updates purge stale `arrakis_*` entries from the canonical file and keep one canonical `arrakis` record.

### Consensus / Rebalance

- Removed the incorrect `RIGHT j_event_claim must wait for LEFT` proposal gate from [account-consensus.ts](/Users/egor/xln/runtime/account-consensus.ts).
  - Added an inline comment there explaining why this is wrong: both sides must be allowed to record their own `j_event_claim`, and only `tryFinalizeAccountJEvents()` may require bilateral agreement.
- Fixed the conflict visualization model in [account-consensus-state.ts](/Users/egor/xln/runtime/account-consensus-state.ts) to match the real deterministic rule:
  - `LEFT wins`
  - `RIGHT rolls back`
- Added explicit rebalance/finalization emits in:
  - [account-tx/apply.ts](/Users/egor/xln/runtime/account-tx/apply.ts)
  - [j-event-claim.ts](/Users/egor/xln/runtime/account-tx/handlers/j-event-claim.ts)

### E2E

- Added isolated two-user swap coverage in [tests/e2e-swap-isolated.spec.ts](/Users/egor/xln/tests/e2e-swap-isolated.spec.ts).
- The test uses separate browser contexts and separate wallet storage, disables market-maker liquidity, and proves:
  - Alice and Bob trade against each other directly through one hub.
  - capacities move on both sides after `swap_resolve`
  - the resolved state survives page reload on both wallets
- Verified pass log:
  - [/Users/egor/xln/.logs/e2e-parallel/20260309-034300-652/e2e-shard-00.log](/Users/egor/xln/.logs/e2e-parallel/20260309-034300-652/e2e-shard-00.log)

### Deploy / Ops

- Restored a tracked root deploy entrypoint in [deploy.sh](/Users/egor/xln/deploy.sh).
- Fixed package scripts in [package.json](/Users/egor/xln/package.json) so `bun run deploy*` points to the same root deploy wrapper.
- Removed `deploy.sh` from `.gitignore` so the deployment entrypoint lives in the repo instead of silently drifting locally.
- Hardened remote deploy so it now:
  - pulls `origin/main` on the server before rebuilding
  - stashes known generated artifacts (`frontend/static/contracts`, `jurisdictions/jurisdictions.json`) before the pull so deploy is not blocked by server-local generated state
  - runs the same local deploy flow on the remote after the fast-forward
- Verified live remote deploy on `root@xln.finance`:
  - remote fast-forward succeeded
  - runtime bundle build succeeded
  - frontend production build succeeded
  - PM2 restarted `xln-server` successfully
- Recovered `xln.finance` after a `502` outage on 2026-03-09:
  - root cause 1: PM2 logs had filled `/` to `100%`
  - root cause 2: prod server startup was still trying to bootstrap local hubs and crashed in reserve funding
  - hotfix applied on the server: `BOOTSTRAP_LOCAL_HUBS=0`
  - repo startup wrapper now defaults to plain-daemon mode too in [scripts/start-server.sh](/Users/egor/xln/scripts/start-server.sh)
  - verified `https://xln.finance/api/health` returned `200` after restart
  - installed `pm2-logrotate` on the server with `50M` max file size, `7` retained archives, compression enabled
- Verified prod again on commit `7d27c848`:
  - `https://xln.finance/api/health` returned `200`
  - direct `mintToReserveBatch` against the live Arrakis depository succeeded with the full 12-mint bootstrap payload
  - installed explicit hourly PM2 log truncation on the server:
    `0 * * * * find /root/.pm2/logs -type f -name '*.log' -exec truncate -s 0 {} +`
- Hardened reserve bootstrap debugging in:
  - [runtime/server.ts](/Users/egor/xln/runtime/server.ts)
  - [runtime/jadapter/rpc.ts](/Users/egor/xln/runtime/jadapter/rpc.ts)
  - failures now log `chainId`, `depository`, `signer`, `admin`, `nonces`, mint count, and first mint payload sample

### Dead Code Removed

- Deleted unused helper [tests/utils/playwright-helpers.ts](/Users/egor/xln/tests/utils/playwright-helpers.ts) after confirming there were no references.

### Runtime / Frontend Readability

- Added a runtime folder map in [runtime/README.md](/Users/egor/xln/runtime/README.md).
- Added a frontend lib folder map in [frontend/src/lib/README.md](/Users/egor/xln/frontend/src/lib/README.md).
- Added a strict cleanup plan in [docs/code-cleanup-plan.md](/Users/egor/xln/docs/code-cleanup-plan.md) that separates:
  - proven removals
  - high-confidence candidates that still need one more proof pass
  - structural moves that should wait until the dirty runtime consensus files are settled

### Jurisdictions / Typechain

- Removed runtime and frontend reads of legacy root `/jurisdictions.json`; browser code now uses `/api/jurisdictions`, and Node code resolves one canonical file path with shard override support via [jurisdictions-path.ts](/Users/egor/xln/runtime/jurisdictions-path.ts).
- Stopped mirroring `jurisdictions.json` into multiple disk locations from [server.ts](/Users/egor/xln/runtime/server.ts); canonical source stays in `jurisdictions/jurisdictions.json` unless a shard explicitly overrides it with `XLN_JURISDICTIONS_PATH`.
- Added explicit contract sync in [sync-contract-artifacts.sh](/Users/egor/xln/scripts/sync-contract-artifacts.sh) plus [generate-typechain.cjs](/Users/egor/xln/jurisdictions/scripts/generate-typechain.cjs) so `bun run dev`, `serve:dev`, deploy, and prod startup rebuild contracts and regenerate TypeChain deterministically.
- Switched runtime imports to the canonical generated TypeChain barrel in `jurisdictions/typechain-types`, matching the new generated layout.
- Verified:
  - `./scripts/sync-contract-artifacts.sh`
  - `bun build runtime/server.ts --target=bun --outfile=/tmp/xln-server-check.js`
  - `bun build runtime/runtime.ts --target=browser --outfile=/tmp/runtime-browser-check.js`
  - `bun build runtime/scripts/e2e-hub-node.ts --target=bun --outfile=/tmp/e2e-hub-node-check.js`
## 2026-03-09

- Fixed prod hub bootstrap hard failure in [runtime/server.ts](/Users/egor/xln/runtime/server.ts): reserve bootstrap was calling non-existent `globalJAdapter.getDepositoryAddress()`. The canonical address source is `globalJAdapter.addresses.depository`.
- Verified the full prod bootstrap path on the real server with `USE_ANVIL=true BOOTSTRAP_LOCAL_HUBS=1`: 3 hubs, mutual credit mesh, reserve funding, market maker liquidity, relay attach, and server startup all complete successfully.
- Restored fail-fast prod startup in [scripts/start-server.sh](/Users/egor/xln/scripts/start-server.sh): `BOOTSTRAP_LOCAL_HUBS` now defaults back to `1`, so prod no longer comes up in an empty relay/no-hubs state.
- Made prod custody startup restart-safe:
  - [runtime/scripts/start-custody-prod.ts](/Users/egor/xln/runtime/scripts/start-custody-prod.ts) now reuses an already-live custody daemon/service on `:8088/:8087` when they match the deterministic custody identity.
  - [scripts/start-custody.sh](/Users/egor/xln/scripts/start-custody.sh) now kills stale orphan listeners on `:8087/:8088` before launching, so PM2 restarts cannot leave LevelDB locks behind.
- Fixed strict WS gossip serialization in [runtime/networking/ws-protocol.ts](/Users/egor/xln/runtime/networking/ws-protocol.ts): websocket messages now use the same canonical tagged JSON codec as runtime persistence, so gossip payloads with `bigint`/`Map` survive round-trip without custom `_type` drift.
- Fixed E2E mesh debug endpoints in [runtime/scripts/e2e-mesh-control.ts](/Users/egor/xln/runtime/scripts/e2e-mesh-control.ts) to use `safeStringify(...)`, preventing debug API crashes on `bigint` payloads during custody bootstrap and mesh inspection.
- Removed brittle bare-directory TypeChain imports across runtime entry points; all runtime/J-adapter/server/e2e node imports now resolve the explicit `jurisdictions/typechain-types/index` barrel. This fixes Bun module resolution failures that were crashing `xln-custody` on prod restart.
- Propagated explicit `profileName` through runtime entity creation/import paths:
  - [runtime/types.ts](/Users/egor/xln/runtime/types.ts)
  - [runtime/runtime.ts](/Users/egor/xln/runtime/runtime.ts)
  - [runtime/server.ts](/Users/egor/xln/runtime/server.ts)
  - [runtime/orchestrator/daemon-control.ts](/Users/egor/xln/runtime/orchestrator/daemon-control.ts)
  - [frontend/src/lib/stores/vaultStore.ts](/Users/egor/xln/frontend/src/lib/stores/vaultStore.ts)
  - [frontend/src/lib/utils/entityFactory.ts](/Users/egor/xln/frontend/src/lib/utils/entityFactory.ts)
  - [frontend/src/lib/components/Entity/FormationPanel.svelte](/Users/egor/xln/frontend/src/lib/components/Entity/FormationPanel.svelte)
  New entities now seed their public profile name from the creation source instead of falling back to anonymous/derived placeholders.
- Fixed the real cause of recent fresh-spec E2E flakiness in [tests/utils/e2e-baseline.ts](/Users/egor/xln/tests/utils/e2e-baseline.ts): `ensureE2EBaseline(...)` now supports `forceReset: true`, so specs that require a clean mesh cannot accidentally reuse shard state left by an earlier spec. Applied to:
  - [tests/e2e-payment.spec.ts](/Users/egor/xln/tests/e2e-payment.spec.ts)
  - [tests/e2e-custody.spec.ts](/Users/egor/xln/tests/e2e-custody.spec.ts)
  - [tests/e2e-swap.spec.ts](/Users/egor/xln/tests/e2e-swap.spec.ts)
  - [tests/e2e-swap-isolated.spec.ts](/Users/egor/xln/tests/e2e-swap-isolated.spec.ts)
- Verified the current worktree on isolated Playwright stacks:
  - targeted `e2e-payment + e2e-custody` passed
  - full isolated suite passed: `17 passed, 6 skipped`
- Fixed prod custody bootstrap to use daemon control state instead of the relay/debug directory read model:
  - [runtime/server.ts](/Users/egor/xln/runtime/server.ts) `ControlEntitySummary` now includes local `accountCount` and `publicAccountCount`
  - [runtime/orchestrator/daemon-control.ts](/Users/egor/xln/runtime/orchestrator/daemon-control.ts) exposes the same typed fields through `DaemonControlClient`
  - [runtime/scripts/start-custody-prod.ts](/Users/egor/xln/runtime/scripts/start-custody-prod.ts) now waits on `/api/control/entities` instead of `/api/debug/entities`, so prod custody startup no longer depends on relay gossip convergence to detect its own entity/accounts
- Made runtime TypeChain imports fully explicit with the `.ts` extension across the runtime/J-adapter/server entry points. This removed the remaining Bun/Rollup module resolution ambiguity during prod deploys.
- Hardened [generate-typechain.cjs](/Users/egor/xln/jurisdictions/scripts/generate-typechain.cjs) to pre-create the mirrored `typechain-types/**` and `typechain-types/factories/**` directory tree before generation, fixing remote deploy failures on fresh rebuilds with `ENOENT` while writing generated files.
- Deployed `main` to prod and verified live:
  - [xln.finance](https://xln.finance) main app/API healthy
  - [custody.xln.finance](https://custody.xln.finance) now serves the custody app and `/api/me`
  - custody daemon/runtime is isolated and healthy on `127.0.0.1:8088`
  - custody HTTP service is isolated and healthy on `127.0.0.1:8087`
  - daemon control reports the deterministic `Custody` entity with `accountCount=3`
- Unified public profile creation around entity state:
  - [runtime/networking/gossip-helper.ts](/Users/egor/xln/runtime/networking/gossip-helper.ts) is now the single builder path for local entity profiles.
  - [runtime/entity-tx/apply.ts](/Users/egor/xln/runtime/entity-tx/apply.ts), [runtime/runtime.ts](/Users/egor/xln/runtime/runtime.ts), and [scripts/bootstrap-hub.ts](/Users/egor/xln/scripts/bootstrap-hub.ts) now announce profiles through the shared helper instead of ad hoc builders.
  - `profileName` was removed from P2P/runtime-network config paths; names now come only from `entityState.profile.name` at replica creation time.
- Hardened relay gossip schema at the real ingress point:
  - [runtime/networking/gossip.ts](/Users/egor/xln/runtime/networking/gossip.ts) now rejects legacy profile fields both in `parseProfile(...)` and `canonicalizeProfile(...)`.
  - [runtime/relay-router.ts](/Users/egor/xln/runtime/relay-router.ts) now drops malformed `gossip_announce` payloads with explicit debug events instead of admitting them into relay state.
  This closes the prod class of bugs where old clients could still inject `metadata.name`, `metadata.lastUpdated`, `expiresAt`, or non-canonical bigint tags into the relay directory.
- Unified bigint transport on the live runtime/custody path:
  - [runtime/networking/profile-signing.ts](/Users/egor/xln/runtime/networking/profile-signing.ts) now hashes profiles through the canonical tagged JSON serializer.
  - [custody/daemon-client.ts](/Users/egor/xln/custody/daemon-client.ts) now uses tagged JSON over daemon WS RPC.
  - [custody/server.ts](/Users/egor/xln/custody/server.ts) now serves JSON and persists withdrawal routes with the same tagged serializer.
- Fixed hub bootstrap name seeding in [scripts/bootstrap-hub.ts](/Users/egor/xln/scripts/bootstrap-hub.ts): hub replicas now set `profileName` at `importReplica` time, so `H1/H2/H3` become part of entity state immediately instead of falling back to `Entity xxxx` placeholders.
- Verified after these changes:
  - `bun build runtime/runtime.ts --target=browser --outfile=/tmp/runtime-check.js`
  - `bun build runtime/server.ts --target=bun --outfile=/tmp/runtime-server-check.js`
  - `bun build custody/server.ts --target=bun --outfile=/tmp/custody-check.js`
  - `bun build scripts/bootstrap-hub.ts --target=bun --outfile=/tmp/bootstrap-hub-check.js`
  - isolated [tests/e2e-payment.spec.ts](/Users/egor/xln/tests/e2e-payment.spec.ts) passed
  - isolated [tests/e2e-custody.spec.ts](/Users/egor/xln/tests/e2e-custody.spec.ts) passed

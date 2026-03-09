# Done Log

## 2026-03-09

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

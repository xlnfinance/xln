# Changelog

All notable XLN changes are documented here.

The project is still pre-mainnet. Version `0.1.5` marks the current state of the
production demo network, recovery/watchtower stack, channel runtime, and test
gates.

## [0.1.5] - 2026-05-29

### Watchtower and Recovery

- Added the official same-origin production watchtower endpoint at
  `https://xln.finance/api/tower/*`.
- Added a standalone watchtower daemon with encrypted backup restore and delayed
  last-resort counter-dispute support.
- Added automatic watchtower sweep scheduling for delayed last-resort remedies.
- Closed public access to `/api/watchtower/*`; public clients use
  `/api/tower/*`, while sweep remains internal.
- Hardened watchtower RPC handling with an allowlist to prevent SSRF through
  appointment-provided RPC URLs.
- Required encrypted last-resort remedies for last-resort appointments; plaintext
  last-resort payloads are rejected.
- Bound last-resort remedy encryption to the tower action public key.
- Added body-size caps, disabled the unauthenticated complaint sink by default,
  and added pruning/stat caching for watchtower storage.
- Made watchtower health constant-time by avoiding full action-receipt scans on
  every health check.
- Raised the official tower backup quota for realistic runtime recovery bundles.
- Added recovery runtime creation UX with explicit modes:
  official tower, backup only, and local only.

### State Channels and Account Consensus

- Hardened account frame proposer binding and entity commit catch-up so restored
  state cannot apply unsigned proposed mutations.
- Preserved outbound ACK state so restored runtimes can bundle the next frame
  after relay loss.
- Added duplicate-frame re-ACK handling for lost ACK recovery.
- Tightened dispute, j-event, and finalization handling to avoid resurrecting
  stale sent batches.
- Hardened HTLC, payment, swap, cross-jurisdiction, and pull-cancel invariants.
- Added last-resort watchtower authority checks: tower cannot start disputes,
  cannot cooperative-finalize, and can only submit owner-authorized newer proofs
  in the final window.

### Durable Storage and Network Send Ordering

- Enforced durable storage before network side effects on the runtime process
  path.
- Added a fail-closed guard for direct remote sends when a recovery backup
  barrier is configured.
- Kept LevelDB batch writes sync-by-default unless explicitly disabled by a
  local non-production override.
- Hardened storage restore against missing history DBs, torn snapshot heads,
  missing replay diffs, and canonical hash mismatches.
- Removed legacy storage restore bypasses and production-unsafe storage flags.
- Added WAL smoke coverage and canonical storage hash checks.

### Runtime, Relay, and P2P

- Reduced cold open-account / hub-connect latency by prefetching counterparty
  P2P profiles and reducing missing-pubkey retry latency.
- Added P2P profile refresh when pending sends fail with missing pubkey.
- Rejected unsafe runtime input and unencrypted entity input over relay/direct
  transports.
- Hardened direct runtime socket duplicate handling and local relay entity
  rejection.
- Added runtime ingress receipts for pending enqueue tracking.

### Production Network and Deploy

- Fixed production reset ordering so market maker startup is not permanently
  orphaned by custody routeability failures.
- Added market-maker startup phase to production health output.
- Hardened production health classification and deploy checks.
- Added nginx routes for the official tower endpoint and made the deploy patcher
  safer for future deployments.
- Added reset/bootstrap timing stages to diagnose production health failures.
- Verified production health with `systemOk:true`, `degraded:[]`,
  `marketMaker.ok:true`, and `startupPhase:"offers-ready"`.

### Tests and Release Gates

- Added full browser E2E coverage for wiped-browser watchtower recovery and
  post-restore channel payments.
- Added restart-resilience coverage for restored tower state across tab/runtime
  restarts.
- Added watchtower live-chain last-resort tests, standalone service tests,
  encrypted remedy tests, and recovery config tests.
- Added full isolated browser E2E coverage across payments, custody, disputes,
  swaps, rebalancing, routing, and watchtower recovery.
- Added release gates for source checks, runtime core tests, frontend build,
  contract tests, RPC settlement parity, security audit pack, WAL persistence,
  watchtower smoke, and fast E2E.

### Runtime Readability and Maintenance

- Split large runtime, server, orchestrator, account, entity, P2P, storage, and
  cross-jurisdiction modules into narrower helper modules.
- Typed previously loose runtime boundaries, scenario inputs, public health
  redaction, signer crypto, relay sockets, and BrowserVM adapter paths.
- Reduced noisy happy-path logging while keeping diagnostics for failures.
- Added canonical docs/status surfaces and updated runtime architecture
  documentation.

### Verified for This Release

- `bun run gate:ci`
- `bun run test:e2e:full`
- `bun run test:e2e:prod:payment`
- `bun run prod:health`
- `GET https://xln.finance/api/health`
- `GET https://xln.finance/api/tower/healthz`
- `POST https://xln.finance/api/watchtower/sweep` returns `404`

### Mainnet Status

This release is not a real-money mainnet launch. It is the current production
demo/testnet-grade release. A real external mainnet rollout still requires
separate chain/RPC configuration, funded production keys, gas policy, incident
runbooks, and launch approval.

## [0.0.1] - 2025-10-11

### Added

- BrowserVM integration with `@ethereumjs/vm`.
- Panel system foundation with Dockview.
- WebGPU/WebGL renderer switching.
- Browser-only simulation network.

### Changed

- Repository structure aligned around runtime, jurisdictions, simulations, and
  validation tests.
- Initial docs and smoke tests for the foundation release.

# XLN TODO

Last updated: 2026-05-29

This is the only live TODO/NEXT file for the repository. Older planning notes
under `docs/archive/` are historical evidence, not active backlog. When this
file and older docs disagree, prefer code and tests first, then this file.

## Closed Or Removed

- Removed the stale testnet handoff whose old faucet/runtime notes were from a
  retired stack and are not active release blockers.
- Removed the broken root `next.md` symlink to a non-existent planning path.
- Removed duplicated live TODO/NEXT pages from frontend static docs. The app
  should not serve stale February/May planning snapshots as current status.
- Merged `ai/todo.md` into this file as auxiliary work, then removed the
  separate AI TODO source.
- Removed old agent scratchpads and top-level audit drafts from the live tree.
  Current consensus/signature/contract concerns are represented below instead
  of scattered through dated request documents.
- Removed obsolete jurisdiction contract-size consultation notes that referred
  to pre-refactor `Depository.sol` structure.
- Closed as `v0.1.5` work: official same-origin watchtower endpoint, scheduler,
  public sweep closure, encrypted active tower remedy payloads, body caps,
  health stats caching, tower GC, runtime backup send barrier, browser recovery
  restart survival, and prod health recovery.
- Confirmed in the `0.1.5` release pass: `bun run gate:ci`,
  `bun run test:e2e:full`, `bun run test:e2e:prod:payment`, and
  `bun run prod:health` passed.

## P0 - Release And Mainnet Readiness

1. **Publish the GitHub Release object for `v0.1.5`.**
   - Tag `v0.1.5` is pushed.
   - `gh release create` is blocked until `gh auth login` or `GH_TOKEN` is
     available in this workspace.

2. **Run the release-duration gates before any mainnet-candidate claim.**
   - Already passed for `0.1.5`: `gate:ci`, full browser E2E, prod payment E2E,
     prod health.
   - Still needed for a mainnet candidate: `bun run gate:release` and the
     multi-hour `bun run soak:release`.

3. **Make real mainnet ops explicit.**
   - Chain/RPC endpoints selected and documented.
   - Funded operator/tower accounts and gas policy documented.
   - Backup/restore and incident drills run against production-like data.
   - Monitoring and alert thresholds cover runtime, relay, storage, market
     maker, and watchtower.

4. **External audit handoff.**
   - Refresh `docs/security/external-audit-brief.md`.
   - Produce the current audit pack with `bun run security:audit-pack`.
   - Do not treat internal E2E success as a substitute for audit on real funds.

## P1 - Protocol And Runtime

1. **Peer State Refresh (PSR).**
   - Define and implement the live peer refresh wire flow from
     `docs/recovery-watchtower-protocol.md`.
   - Exit: a wiped client can recover from honest peer/hub state even when the
     tower is unavailable.

2. **Recovery coverage UX and receipts.**
   - Show local, tower backup, delayed-last-resort, and peer-refresh coverage
     per runtime/account.
   - Surface last successful tower upload height and failure reason.

3. **Runtime exception disposition.**
   - Classify hot runtime exceptions as `drop`, `defer`, `debug-assert`, or
     `fatal`.
   - Remove ambiguous exception paths from account/entity consensus code.

4. **Consensus and Hanko production review.**
   - Re-check current account commit semantics, settlement hankos,
     chain/contract domain separation, J-event finalization, and mempoolOps
     against the current code instead of old audit snapshots.

5. **Contract governance/access-control scan.**
   - Re-run a current pass over `EntityProvider`/`Depository` for permission
     checks, gas bounds, and public debug surfaces before external audit.

6. **RPC state commitment quality.**
   - Replace placeholder RPC `stateRoot` output with useful J-state commitment
     data or fail explicitly until it exists.

7. **Persistence inspect and repair tooling.**
   - Add operator commands to inspect frame DB, snapshots, WAL, tower receipts,
     and recovery bundle coverage.

8. **Destructive action guardrails.**
   - Keep `clearDB`, reset, and dev-only actions gated so normal users cannot
     accidentally erase recoverable state.

## P2 - Product And UI

1. **Token support boundary.**
   - Either prove multi-token collateral E2E or keep the product explicitly
     USDC/single-token for the current release line.

2. **Custody and fee UX.**
   - Make custody balance and auto-fee behavior read as one coherent flow.

3. **SettlementPanel consistency.**
   - Keep direct on-chain flows and entity/quorum flows visually and logically
     distinct.

4. **Activity/account-card context.**
   - Show routing, HTLC, swap, J-event, dispute, and recovery events clearly
     enough for demo and support/debug use.

## Auxiliary AI Work

These are useful local-product tasks but not XLN launch blockers.

- Finish GPT-OSS 120B MLX download at `~/models/gpt-oss-120b-heretic-mlx`.
- Install `piper` so `/api/synthesize` can produce voice locally.
- Fix the green visual speech indicator in `/ai`.

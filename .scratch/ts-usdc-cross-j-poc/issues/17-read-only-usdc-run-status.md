# 17: Inspect an interrupted one-USDC run from the execution CLI

Type: implementation
Category: enhancement
Completed: no
Status: ready-for-agent
Blocked by: 16 - Supervise the authorized one-USDC journey from the execution CLI

## Problem

The session progress command shows startup and J-watcher catch-up. After a financial process stops, the operator needs to reconcile the exact run even when its final report is missing or the spending authority has expired. `execution run` checks authority expiry before receipt reconciliation.

## Deliverable

Add one bounded read-only observation per call to the existing execution CLI. Reuse the stand descriptor from [16](16-supervised-one-usdc-cli-run.md).

```sh
bun jurisdictions/scripts/usdc-cross-j-preflight/execution/index.ts status \
  --stand stand.json --authority-file journey.approved.json --run-id demo-01
```

## Acceptance criteria

- [ ] Validate the run ID, original manifest, catalog, chain anchors, and participant identities. Return one observation with human output and the same facts under `--json`. Show the manifest digest, observed blocks and WAL frame, the last verified step, and the reason progress is blocked or unknown.
- [x] Reconcile the five fixed on-chain slots for the selected run. Verify a known transaction hash directly and use the canonical nonce lookup for a consumed slot without a known hash. Validate each receipt against the expected payer, nonce, authorized call, and canonical block. Distinguish confirmed success, revert, pending evidence, no observed transaction, and unavailable evidence. A consumed nonce with unavailable history is an unresolved slot.
- [x] Inspect a consistent committed WAL frame for the source reserve or collateral, both Cross-J legs, remaining amounts, and target cover or exit. Report the Runtime observation independently from the on-chain receipt when the watcher is behind. Preserve an explicit unknown when the required WAL or RPC evidence is unavailable. Establish completion from the five valid receipts, settled route with zero remainder, and the exact external payout.
- [x] Report authority expiry independently of the historical result. Use a read-only RPC provider and inspect the verified materialized WAL graph without applying the WAL tail or signing. WAL and verified chain receipts remain the sources of financial progress. Limit the output to observations and the outstanding prerequisites for continuing.
- [x] On two local Anvil chains, interrupt the run after the deposit receipt and observe it after authority expiry, without a final report. Assert the exact deposit hash, remaining principal, and zero new signatures, submissions, and WAL writes. Exercise a receipt ahead of WAL observation, an unresolved consumed nonce, a confirmed revert, and a completed run with five receipts and zero remainder.

## Local verification

One Anvil test stopped the user runner after the chain mined its deposit and
before the Runtime could observe it. After expiry, status verified the exact
deposit hash and reported 1,000,000 atomic units remaining with the watcher
behind and no final execution report. The guard blocks native secp256k1,
Noble, and ethers signing. RPC submission counters and hashes of the original
store files confirmed zero status side effects.

With the user store locked, the same deposit was verified from chain evidence
with WAL unavailable. When the archive returned HTTP 429, status resolved
the approval hash from the committed Runtime and the known deposit hash via the current RPC.
With the stores also absent, the consumed approval remained unresolved.
The supervised integration resolved the exact cover hash from the stopped
Hub WAL with HTTP 429 on the target archive. The direct hash path also
checks the payer's nonce at the approved anchor.
A mined source collateral revert was identified by exact nonce and receipt.
The completed case reported five successful receipts, zero remaining units,
and 899,801 units of external payout in both output formats.

An unmaterialized WAL tail produces explicit head and materialized heights
with unknown current Runtime progress. A read-only check of the saved
`fresh-UbkYJm` run, with the same signature guard active, verified all five
public receipts and the 899,801-unit payout. Its committed head is 52 and its
materialized graph is at 1. The execution CLI materializes each user frame
so new runs can show exact current Runtime progress after interruption.

The missing-store fixture recovered the exact confirmed deposit hash by nonce
with all three runtime store directories absent. It labeled WAL progress
unknown. The corrupted-store fixture changed a copy of the LevelDB manifest
pointer and verified that the command failed with its storage error.

```sh
bun run stand:status
bun run stand:run --reason ticket15-formatted-status --wait-ms 0 --timeout-ms 180000 -- \
  bun test core/__tests__/market/startup/usdc-session/status.test.ts \
  core/__tests__/market/startup/usdc-session/stop-report.test.ts
```

The locked run passed two tests and 31 assertions in 96.15 seconds. The
focused storage, fee, authority, quote, tariff and RPC suites passed 112 tests
and 549 assertions.
Deployment TypeScript and the aggregate `bun run check` passed. The aggregate
allowed system process inspection and disabled GPG signing for temporary test
commits via process-local Git configuration.

The final pre-commit status observation used base
`d00068e750788b2c77adf1d5bb5b27184baa2b66` and the formatted working-tree candidate digest
`5e12276b050a611b1bf70997e537c05d14c9240c583a2404f71e344ab2163ddc`.

The completed run resolved all five receipts by exact hash while both archive
endpoints returned HTTP 429. The verified retained WAL supplied the retired
user batch hashes and the Hub cover hash. The expired-run fixture then denied
account nonce reads at the original anchor on the current RPC. With the archive
on the same anchor, status verified the approval and deposit by hash. These
observations kept the signing guard active and left the original stores intact.

The [post-demo scope](../spec.md#scope-after-the-accepted-demo) defers the open
P3 review item. If a different transaction consumed an expected nonce, status
must surface that slot's conflict and preserve the independently verified slots.
The current validation ends the whole observation on this case.

## References

- [Supervised run and stop report](16-supervised-one-usdc-cli-run.md)
- [Inspect a stopped or completed run](../../../docs/runtime/usdc-poc-execution.md#inspect-a-stopped-or-completed-run)
- [Receipt lookup by payer and nonce](../../../jurisdictions/scripts/usdc-cross-j-preflight/execution/nonce-receipt.ts)
- [Materialized WAL inspection](../../../core/storage/recovery/journal/replay.ts)
- [Session startup and watcher progress](../../../docs/runtime/usdc-poc-session.md#observation-and-shutdown)

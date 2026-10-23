# H1 preserved-start reserve refill (2026-10-23)

- Base SHA: `b63204120990bc3fc11892d7ae21b40e921eb02f`.
- Public backend `a5075ad87`: `systemOk:false`, `RESET_NOT_READY`, reset in progress
  since 10:05:47Z. At 11:13Z H1 USDC reserve was `1997925307795` against target
  `2000000000000`. H1 `bootstrapProgress.step` stayed at `start`.
  `quiescence.pendingRuntimeWork=1` and `pendingAccountFrames=1`. One output was
  retained for offline Runtime `0xd567…6de2` (`deliverable:false`).

## Root cause

On restart, H1 republished its committed outbox to the offline user. The retained
entry in `pendingNetworkOutputs` made the mesh `drive()` gate
(`hasPendingRuntimeWork`) return true on every tick. Because of that,
`ensureHubMeshReserves`, the H1-owned refill on the dev chain, never ran. The
orchestrator's `waitForTsH1LocalReserves(requireTarget=true)` then waited forever.
The orchestrator ordering is correct: a concurrent orchestrator mint would race H1's
`HUB_RESERVE_STATE_MISMATCH` fail-stop.

## Fix

- `mesh-common.ts`: the new `hasLocalRuntimeWork` excludes the retained committed
  outbox. `hasPendingRuntimeWork` is now `local || pendingNetworkOutputs`, so
  quiescence reporting does not change.
- `hub-node.ts`: the mesh `drive()` gate now checks `hasLocalRuntimeWork`.
- A Runtime-committed outbox entry does not mean the bilateral Account
  `pendingFrame` it carries is final. That frame stays pending until the peer ACKs.
- No changes to quiesce drain, readiness criteria or nondev funding.

## Evidence

- L1: `bun test core/__tests__/orchestrator/topology/mesh-common-queued-work.test.ts
  core/__tests__/orchestrator/health/runtime-quiescence-health.test.ts`: 8 pass, 0 fail,
  17 expects, 2.20 s.
- L3: `bun run check` exited 0. It ran 11:17:27Z–11:20:43Z; `check:src` covered
  38 gates in 193946 ms.
- L2: new scenario `hub-preserved-reserve-refill`
  (`core/scenarios/payments/hub-preserved-reserve-refill.ts`). It reuses the
  real `htlc-recovery-network` fixture: three sovereign Runtimes, authenticated
  direct sockets, a real anvil J through the isolated scenario lease, and storage
  enabled. Steps:
  1. The Hub opens a credit Account with Alice. Alice goes offline through
     transport readiness. The Hub signs one `directPayment` of 1 unit. The
     Account `pendingFrame` is at h3 and the output is retained.
  2. The Hub closes and reopens from checkpoint plus ordered Runtime WAL
     (`loadEnvFromDB`).
  3. The old gate predicate, `hasPendingRuntimeWork`, stayed true for 20 of 20
     redelivery rounds: a bounded negative. `hasLocalRuntimeWork` was false.
  4. The real `ensureHubBootstrapReserves` (`deployTokens:true`, dev chain)
     funded on-chain. Tokens 1, 2 and 3 reached their exact targets
     (`2000000000000`, `2000000000000000000000` and `2000000000000`), and chain
     reserves equal local reserves.
  5. After the reopen, the redelivery rounds and the refill, the following stayed
     unchanged: the pending frame (`height:stateHash:prevFrameHash`), the Hub
     Account height, and the byte-identical ordered outbox owed to Alice
     (8222 B). Alice did not commit while offline.
  6. Alice reconnects. The original frame commits exactly once on both sides at
     h3, both sides hold the same offdelta, and exactly 1 unit moved. The Hub
     outbox drains to empty.
- Observed during recovery: the WAL reopen also re-originated one empty Hub
  self-targeted output (`hub:0`). It drained in the first rounds and is outside the
  outbox owed to Alice.
- Command: `XLN_RUNTIME_SEED=<random> bun run stand:run --reason=h1-preserved-reserve-l2
  --timeout-ms=60000 -- bun core/scenarios/run.ts hub-preserved-reserve-refill`
  exited 0 in 20–22 s. Two runs passed on the final source.
- Not covered by this L2:
  - the full orchestrator `completeResetStartup`;
  - a pending Account with another Hub peer, where planner skipping was not
    exercised;
  - a full clean shutdown or quiesce;
  - the public deploy.

## Next

1. Public deploy still faces the known quiesce `work_drain_timeout` on the same
   offline-peer pending frame (`node-runtime-quiesce.ts:89`). This change does not
   alter drain or readiness.

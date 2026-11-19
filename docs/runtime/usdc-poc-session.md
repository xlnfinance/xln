# Restore the headless USDC PoC session

The restore launcher owns separate user, Hub and MM processes and their
explicitly selected existing stores. It uses the canonical Runtime
checkpoint/WAL replay and committed outbox. Host locks and session reports
contain no financial recovery authority.

## Inputs

- Keep the three original private vaults under the preparation directory's
  `user/`, `hub/` and `mm/` directories. Missing vaults are rejected; restore
  never generates a replacement seed.
- Select each exact Runtime root from the retained operator invocation's
  `databasePath`, removing its final `/db`. The user invocation also records
  its Runtime root separately from its vault. Never select the newest attempt
  by timestamp or combine different preparation attempts implicitly.
- Each Runtime root must already exist inside its corresponding role directory
  and contain a committed WAL for the vault-derived Runtime identity.
- The selected `jurisdictions.json` must describe the same two USDC-only stacks
  as the stored Runtime: chain, contracts, deployment block, block time and
  token binding must agree. A new live RPC endpoint can be supplied through
  the existing trusted RPC binding mechanism without rewriting committed state.

## Start

Run from the repository root. Set `POC_HUB_STORE`, `POC_MM_STORE` and
`POC_USER_STORE` to the existing Runtime roots described above, then run:

```sh
bun run stand:status
bun run stand:run --reason poc-runtime-restore --timeout-ms 7200000 -- \
  bun jurisdictions/scripts/usdc-cross-j-preflight/operators/session/index.ts \
  --directory .logs/ts-usdc-cross-j-poc/public \
  --hub-store "$POC_HUB_STORE" \
  --mm-store "$POC_MM_STORE" \
  --user-store "$POC_USER_STORE"
```

The default gateway is `http://localhost:8080`; Hub/MM bind loopback ports
18081/18082. The gateway retains the existing read-only RPC allowlist. Load
RPC credentials through the protected environment as for the preflight guide;
the launcher does not forward a deployment private key to its children.

An explicitly managed external gateway can be selected with
`--external-gateway --api-base <loopback-http-origin>`. A leased local test stand
can also set `--api-base`, `--hub-port` and `--mm-port`; endpoint and role ports
must be distinct. This is an explicit connection choice, not an automatic
fallback after a failed gateway.

For a single Hub diagnosis, add `--hub-only` and set a short startup budget.
The launcher restores and locks the original Hub store and uses its managed
read-only gateway. It rejects an external gateway or an execution authority
in this mode. The MM and user store paths still identify the preparation, but
their databases and processes stay closed.

Set `POC_HEADER_BATCH_TIMING=1` when measuring a header stall. The managed
gateway records queue admission, cooldown, observed client cancellation,
upstream dispatch and completion in `gateway.log`. Each event uses a local
batch ID and chain ID. It excludes RPC credentials and request bodies.

Set `POC_RPC_READ_PACING=1` to pace reads. The gateway defaults to 500 ms
between header dispatches per upstream binding and 1000 ms between block-receipt
dispatches per history binding. `POC_RPC_HEADER_INTERVAL_MS` and
`POC_RPC_RECEIPT_INTERVAL_MS` set those intervals. Paced receipts use one
explicit read request to keep upstream retries in the watcher.

For a smaller EVM RPC watcher page, set
`XLN_J_WATCHER_RPC_MAX_BLOCKS_PER_POLL=31`. Append the chain ID to override
the page limit for one chain, for example
`XLN_J_WATCHER_RPC_MAX_BLOCKS_PER_POLL_421614=127`. Set
`XLN_J_WATCHER_RPC_HEADER_BATCH_CALLS=32` to split each header read into
sequential batches of at most 32 calls. A 127-block page and its predecessor
then require four batches per observation. Both complete header observations,
receipt authentication and finality checks still apply. The Runtime logs
completed authenticated ranges. Validator-local scan evidence can reach the
WAL before the Entity certifies a new financial cursor.

## What startup verifies

1. Kernel descriptor locks claim all selected Runtime roots. An active owner
   or an already-open canonical database causes a loud rejection. Lock files
   are never unlinked; process exit releases their kernel locks.
2. The existing WAL heads must be committed. Canonical replay then verifies
   each restored head, its Runtime/Entity identities, configuration and actual
   token registry before operator loops start.
3. Hub/MM use `--require-restore`; the user uses the same mandatory-restore
   option. Missing recovery state cannot become a fresh financial Runtime.
4. Hub starts first. The launcher waits for Hub `/api/info.deliveryReady`,
   which opens after authenticated J catch-up, and for the existing Hub health
   and reserve checks. Then it starts MM and waits for MM readiness. Support
   Accounts with MM can finish provisioning after MM starts.
5. User startup captures its restored proof before new events, catches up
   authenticated J observations, starts the canonical loop and reconnects
   authenticated relay transport.

Required reserves and market depth remain real readiness conditions. This
launcher does not fund a reserve or change operator credit/quote policy.
Use the separately authorized [operator-funding executor](usdc-poc-operator-funding.md)
before restoring these same stores to observe the new Hub reserves.

Public cold restore also requires archive state and receipts at the original
WAL frontier. The gateway uses the explicitly selected current RPC for chain
identity/headers and the protected archive for other reads. Header requests use
the canonical batch transport with shared backpressure; errors retain their
availability classification. `POC_RUNTIME_11155111_RPC` and
`POC_RUNTIME_421614_RPC` select the current/header roles explicitly.

For the measured Arbitrum HyperSync configuration, set
`POC_HYPERSYNC_ARBITRUM_HEADERS=1` and
`XLN_J_WATCHER_RPC_MAX_BLOCKS_PER_POLL_421614=2047` in the launch environment.
Supply `POC_HYPERSYNC_TOKEN` to the gateway from the protected environment.
The session enables complete range reads on the Arbitrum watcher and starts
the managed gateway with the same selection. When using an external gateway,
set the HyperSync flag on both the session and the gateway, and supply the
token only to the gateway.

The gateway reads each observation from HyperSync as a contiguous paginated
range. The watcher validates both fresh observations through the existing
header and receipt verifier. Current chain identity, finality and single
headers use the configured current RPC. Archive receipts and historical
`eth_getProof` retain the protected history binding. An unavailable range
uses the watcher's existing availability handling. The selected range source
does not fall back to another provider.

To use HyperRPC for Ethereum receipt catch-up, set
`POC_HYPERRPC_ETHEREUM_RECEIPT_BATCH_CALLS=32` and
`XLN_J_WATCHER_RPC_MAX_BLOCKS_PER_POLL_11155111=31`. Load
`POC_HYPERRPC_11155111_RPC` from the protected environment into the gateway.
For an external gateway, set the batch size on both the launcher and the
gateway. The gateway spaces HyperRPC requests by 12.5 s for the existing
five-request-per-minute quota. Each request covers up to 32 receipt-bearing
blocks. The watcher still verifies the complete receipt set per block and
reads fresh headers after the receipt work. Historical proofs and Arbitrum
receipts retain the archive binding.

`--startup-timeout-ms 600000` selects a ten-minute startup budget for a long
catch-up. The default is 60,000 ms. The launcher accepts safe integer
budgets of at least 60,000 ms per operator readiness wait. The stalled
drain guard and authenticated history checks remain active throughout.

For [ticket 12](../../.scratch/ts-usdc-cross-j-poc/issues/12-public-rpc-capacity-and-funded-catchup.md),
select `--operators-only` with the managed read-only gateway and use
`--startup-timeout-ms 21600000` to give each operator up to six hours.
Give the outer stand lease time for both operator waits plus startup and
shutdown. The launch stays on the existing Hub and MM stores. The user
store path identifies the preparation while its database stays closed.

## Observation and shutdown

The launcher prints `USDC_SESSION_DIRECTORY` and, after all roles are ready,
`USDC_SESSION_READY`. Its private `sessions/restore-*` directory contains a
fixed invocation catalog, per-role replay proofs and process logs. These are
retained startup observations; use process/HTTP health for current liveness.
They are never read as replacement financial state during recovery.

From the repository root, point the progress command at a job directory
containing `launcher.log`, or at the `restore-*` directory printed by the
launcher.

```sh
bun jurisdictions/scripts/usdc-cross-j-preflight/operators/session/progress.ts "$POC_SESSION_DIRECTORY"
bun jurisdictions/scripts/usdc-cross-j-preflight/operators/session/progress.ts "$POC_SESSION_DIRECTORY" --watch
```

The command reads local logs and startup proofs. For each operator and chain,
it shows the first scanned block, the latest authenticated height and
the certified cursor reported before that range. The WAL frame is the one
restored at startup. The authenticated height can advance ahead of durable
scan progress. `--watch` refreshes every 10 seconds. Press Ctrl+C to stop
watching. For managed jobs, the monitor also stops after reading `exit-status`.

SIGTERM/SIGINT stops every owned child before releasing store ownership. An
unexpected child exit stops the session. If the supervisor is killed, the
existing parent-liveness mechanism stops Hub/MM and also the user and gateway.
An external gateway remains owned by its external supervisor.

## Verification and scope

The [retained local evidence](../evidence/ts-usdc-cross-j-poc/local-evidence.md#funded-runtime-restorejson)
binds the tested source hashes, per-role replay proofs, three session starts,
identified chain observations and verification results. The owning scenario
passes 33 assertions; the related suite passes 69 tests and the existing
financial recovery matrix passes three cases with eight restores. The full
check and deployment TypeScript validation pass on the dirty local candidate.

The [funded restore scenario](../../core/__tests__/market/startup/usdc-funded-restore.test.ts)
uses two private Anvil chains with the selected public chain IDs. It funds a
user through real approval/E2R/R2C, crashes operators with live Pulls, compares
the user's exact restored roots, Account heads/Hankos and outbox digest, and
checks unchanged on-chain nonces and token/reserve balances across restarts.
Balance observations identify a chain height/hash and include the user's native
balance and wallet nonce, so a repeated failed transaction cannot hide behind
unchanged contract balances.
It also exercises a protected gateway with relocated RPC bindings, concurrent
owners, missing/foreign vaults, missing state and incompatible contract config.

For a financial campaign, use `--operators-only --authority-file <approved-file>`
and let the [financial CLI](usdc-poc-execution.md) exclusively own the existing
user store. This mode restores Hub/MM and starts the explicitly authorized
gateway. Stop the old Hub/MM session before replacing its relay; do not hot-swap
the relay underneath active operators. `--external-gateway` remains available
for a separately supervised gateway.

The default gateway stays read-only and will reject a restored effect requiring
submission. Such a failure is not permission to discard the effect or replace
the Runtime. The finite normal-flow authority implemented in ticket 08 is not
public spending approval. The capital packet, actual operator funding and full
journey/recovery preparation remain tickets 10, 11 and 05 respectively.

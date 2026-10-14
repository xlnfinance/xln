# Native Tron release boundary — 2026-09-18

## Latest: automatic native withdrawal and upgrade boundary

The received cross-chain claim now reaches the external native-Tron wallet:
10,000,000 base units (10 private-chain test tokens). The previously stranded,
already-signed workspace was executed through the existing wallet commands only
after confirming its exact hash on both peers, no pending batch, on-chain user
nonce zero, collateral 10,000,000 and external balance zero. No duplicate funding,
ledger rewrite or unsigned workspace cancellation occurred. This explicit
recovery is recorded separately from the subsequent automatic-path test.

The fresh test returns those same tokens through ordinary deposit → collateral
→ `settle_propose` with the wallet's external-withdrawal continuation. It never
sends a manual `settle_execute`. Real finalized `HankoBatchProcessed` receipts:

- Deposit: block 121, nonce 2.
- Collateral: block 124, nonce 3.
- Automatic withdrawal: block 127, nonce 4, transaction
  `0xebc5a00d5d22c94915777ecd1e1f40a2bf4e421384a4138ba01d4b1e76a601a0`.
- External balance returns to 10,000,000; reserves and collateral are zero.
  All four bilateral roots agree; no pending proposals, queued work, offers or
  pulls. Restart reproduces hub R220 / user R188 frame and post-state hashes.

Root cause: the production Entity stage queues local Account admissions until
the outbound stage. The continuation selector read the pre-admission Account
and discarded the newly signed instruction as `workspace_missing` at user R91.
R92/R93 subsequently certified the settlement with no instruction left to submit
it. The fix consults the existing frame-local admission list before discarding;
it adds no durable state or financial formula. The complete-Entity regression
passed inline but failed with real TS workers 1 and 4 before the fix. Afterward,
all 56 focused settlement tests pass (367 assertions).

**Upgrade gate still open:** latest-state restart is exact, but historical replay
under the corrected code rejects the old buggy R91. It reports
`RECOVERY_JOURNAL_REPLICA_META_DIGEST_MISMATCH`, expected
`0xb365e2c69e980d67c60ef8846c1e4bf9f04279d2206542745f0352bb1e899d3f`, actual
`0xb9f270f6faf4a0db03336ad4d399b4e69587cf99fb60a0f32b412920e503226c`.
No mismatch bypass or old-behavior fallback was added. An explicit offline
checkpoint migration and cold replay from that boundary must be proven before
upgrading an existing deployment. Do not treat the successful latest-head
restart as full historical replay compatibility or release readiness.

Compact evidence: [withdrawal-proof.json](withdrawal-proof.json). Raw successful
and rejected-run logs, both recovery reports and both automatic reports are
beside it. `bun run check` passes all 39 source gates (44.571 seconds); the focused
strict TypeScript check includes both withdrawal drivers. An initial full check
rejected the eleventh file in `scripts/tron`; drivers now live in `withdrawal/`.
No public deployment, physical-device test or rendered cross-chain UI is claimed.

Current latest-head verification command for the evolved ledger:

```sh
bun run stand:status
bun run stand:run --reason native-automatic-withdrawal-restart --timeout-ms 60000 -- \
  bun scripts/tron/native-stand.ts --automatic-withdraw-restore
```

Older restore commands below refer to superseded ledger heads and their archived
evidence. They must not be used to claim that today's state matches those heads.

## Ethereum ↔ native Tron bilateral swap

One real match between two opposing orders completes through the canonical
wallet command API, orderbook, Account consensus and WAL. Alice exchanges 10
six-decimal Ethereum test-token units for 10 native-Tron test-token units; Bob
provides the opposing order. These are bilateral credit claims, with zero
collateral, not issuer-backed USDC/USDT or an on-chain withdrawal.

- Two sovereign Runtimes communicate through authenticated direct sockets.
  Their hubs own separate Ethereum and native-TVM jurisdictions; four user
  Entities each have a signed bilateral Account with their jurisdiction's hub.
- Each Account begins with 100 units of credit in each direction. After the
  match, user outgoing capacities are 90 / 110 / 110 / 90 units. All four
  Account roots match their peers, at Account height 5. Pending frames, queued
  Account work, offers and pulls are zero.
- Both hub route copies mark both orders settled for exactly 10,000,000 base
  units on each leg. The user WAL contains four prepare commands: exactly one
  per owning user Entity, two per order. One match is not four economic swaps.
- Restart reproduces hub R71 and user R64 frame/root hashes, all four Account
  states, and both hubs' route records exactly. Final restore exits zero.

Compact proof: `cross-swap-proof.json`. Full reports: `cross-swap.json`,
`cross-swap-before.json`, and `cross-swap-restore.json`. Failed and successful
logs remain saved. The first attempt waited for user profiles before opening
the direct connection that delivers them; the driver now discovers the hubs,
then opens Accounts through the normal transport. No balances, certificates,
receipts or protocol transitions were mocked. No core implementation changed.

Current recovery command for this evolved dual-chain ledger:

```sh
bun run stand:status
bun run stand:run --reason native-cross-swap-restore --timeout-ms 60000 -- \
  bun scripts/tron/native-stand.ts --cross-swap-restore
```

The old `--cross-network-restore` driver lacks the new Entity signer setup.
Fresh execution rejects existing progress; resume only permits pre-submission
setup. An uncertain submitted intent requires WAL inspection, never a rebuilt
signed route with a new timestamp. The final driver passes a focused strict
TypeScript check. Full `bun run check` passes, 39 source gates / 40.864 seconds,
log `docs/evidence/archive-tmp/xln-cross-swap-final-check.log`. All 43 evidence hashes and whitespace
checks pass. Chain processes are stopped and the stand is free.

Still open: withdrawal of swapped claims, lending, rendered web/iOS acceptance
against native Tron, public-testnet recovery and physical iPhone installation.
This is private-chain semantic evidence, not public release or GDP attribution.

## Wallet-originated deposit and withdrawal

Earlier wallet-stage verification: full `bun run check` passes, 39 source
gates in 40.949 seconds; `git diff --check` and all 28 evidence file hashes pass.
Full-check log: `docs/evidence/archive-tmp/xln-tron-wallet-final-check.log`. No commit, push or public
deployment was performed.

`wallet-proof.json` ties the frontend's real `e2r` / `r2e` / `j_broadcast`
builders to the production `EmbeddedRuntimeAdapter`, Runtime WAL, native chain
receipts and exact restart recovery. The driver starts the actual Runtime loop;
it does not inject balances or call the low-level batch submitter directly.

- Deposit 1 XLNUSD (1,000,000 base units) at block 69, transaction
  `0x3e25acc74ebb49809cde1bda56e49b2c06fc1e16bcdf640a714399bd0e3621fe`.
  Entity frame 3 commits reserve 1,000,000 and nonce 3; the external balance
  decreases by exactly that amount.
- Withdrawal at block 72, transaction
  `0xe41df63c67d53c914b81e3e6e882c68a6a3172d97b333681b163ce1cf03ca742`.
  Entity frame 5 commits reserve zero and nonce 4, with no pending batch.
  The external token balance returns to 1,000,000,000,000 base units.
- Restart restores R22 with identical Runtime frame/root and Entity frame hash.
  Original WAL commands are exactly `e2r, j_broadcast, r2e, j_broadcast`; both
  committed submission-result hashes equal their observed receipt hashes.

The first driver attempt correctly failed `phase=booting` before sending any
transaction. Browser bootstrap starts the Runtime loop automatically; the Bun
driver now starts it explicitly through the same public lifecycle API. The
failed log remains saved. No financial/core production change was necessary.

Current reuse:

```sh
bun run stand:status
bun run stand:run --reason native-tron-wallet-restore --timeout-ms 60000 -- \
  bun scripts/tron/native-stand.ts --wallet-restore
```

The one-shot `--wallet-move` refuses an existing progress file. The earlier
`--entity-restore` stage expected nonce 2 and is no longer the recovery entry
point for this evolved ledger. Both successful processes exited zero and the
stand is free. This proof uses the actual command path, not a rendered iPhone
screen. The later section above proves one private ETH↔native-Tron credit swap;
lending and public-app acceptance remain open.

## Earlier receipt-ingestion milestone

Latest result: real native deposit/withdrawal receipts now pass through the
canonical TS Runtime and Entity consensus, and the same WAL restores the
financial state exactly. This remains a private-chain proof, not the physical
iPhone/public-testnet demo or an ETH↔Tron swap.

Receipt-ingestion validation: `bun run check` passed, 39 source gates in 40.288 seconds;
`git diff --check` passes. Log: `docs/evidence/archive-tmp/xln-tron-entity-final-check-retry.log`.
The first broad run failed in the unrelated advisor process-group cleanup test
with `EPERM`; the focused process suite passed 4/4, then the full unchanged
retry passed. That intermittent cleanup failure is recorded, not claimed fixed.
First log: `docs/evidence/archive-tmp/xln-tron-entity-final-check.log`.

## Entity financial ingestion and recovery

`entity-finance.json` records R7 importing the real Foundation board and R8
finalizing Entity frame 1 through native block 35. The signed J-prefix contains
the actual reserve updates at blocks 23/24, balances `1,000,000 → 0`, and batch
nonces `1 → 2`. The final Entity reserve is zero and its nonce is 2, both checked
against the native adapter. This is ordered receipt ingestion in one catch-up
frame; it does not claim two separately committed intermediate Entity states.

`entity-restore.json` and `entity-restore-passed.log` show recovery from the same
ledger and WAL. Entity frame hash remains
`0x29d0c9a58145e126afd7c740db52b8cee0a9bccc31275bdd54886de3f9a7c76e`.
The verifier reads original WAL inputs and requires both reserve receipts and
both nonces, in order, exactly once. It checks the saved Runtime frame/root
before polling again; the final successful run restores R10 and ends at R11.

The first restore failed because the harness registered the disposable
Foundation key after `main`, too late for WAL replay. It now registers that key
against the runtime seed before bootstrap, using the existing signer API. Two
runs completed financial assertions but reached the process deadline: all
adapters and databases had closed, while crypto workers retained the process.
The bounded CLI now exits only after assertions, evidence writes and all closes
succeed, following the existing process-owned crypto worker lifecycle. Failed
logs are retained; no database reset, fabricated receipt, or consensus change
was used. The final run exits 0, stops java-tron and releases the stand.

Historical Entity-ingestion reuse command (before the wallet transactions):

```sh
bun run stand:status
bun run stand:run --reason native-tron-entity-restore --timeout-ms 60000 -- \
  bun scripts/tron/native-stand.ts --entity-restore
```

That stage used `--entity-restore`. The earlier authority-only driver
does not provision the Foundation signer and is no longer its recovery entry point.

The earlier `/tmp` native node and replay drivers no longer existed. This run
restored the exact recorded java-tron 4.8.2.1 ARM release and Temurin 17.0.20.1+1
from official release assets, verified both SHA-256 hashes, and booted a new
private ledger. It does not restore or rewrite the September 5 chain history.

Verified on actual TVM through the existing canonical contract deployer:

- Eight current XLN contracts deployed, plus the repository's local ERC20Mock
  token named `XLN Local Test USD` / `XLNUSD`. It is not Tether USDT; the deployer
  keeps it in its existing `registeredTokens.USDT` configuration slot.
- All nine cached artifact metadata source hashes match the current Solidity
  files. Exact artifact SHA-256 hashes are saved in `artifact-sources.json`.
- The canonical JAdapter selects `mode: tron` and reads the real six-decimal
  token registry after restarting the same ledger.
- Native deposit at block 23 and signed withdrawal at block 24: reserve
  `0 → 1,000,000 → 0`, external token balance exactly restored to `1,000,000,000,000`
  base units, and Entity nonce `0 → 1 → 2`. The test waits for the withdrawal's
  block to become solid. Exact events, hashes and balances are in `economic.json`.

The first deposit attempt stopped before broadcast because the node's supported
energy-estimation API was disabled. Enabling `vm.estimateEnergy` fixed the
configuration. No gas-estimate fallback or fabricated receipt was introduced.
Before retrying, the scenario required the untouched initial reserve, external
balance and Entity nonce; its original progress and failure log are preserved.

The private node disables P2P and sets the required peer count to zero, since
this fixture contains one producing SR. HTTP/native endpoints are 19090/19091;
JSON-RPC is `http://127.0.0.1:18545/jsonrpc`. The stock HTTP services are not
loopback-bind isolated. Only a public disposable test signer and private-chain
assets are used. Recognized feature flags come from the recorded September 5
parameter snapshot; this is not a current-mainnet parameter-parity claim.

## Reuse

Data: `db/native-tron-release-20260918`. Binaries and source-pinned configuration:
`~/.cache/xln/tron/4.8.2.1`. The helper rejects configuration drift and waits for
a newly produced block before constructing transactions.

```sh
bun run stand:status
bun run stand:run --reason native-tron-readback --timeout-ms 60000 -- \
  bun scripts/tron/native-stand.ts --verify-graph
```

`--verify-graph` revalidates the existing token deployment and reads the saved
graph; it does not redeploy or relist it. `--deploy-graph` rejects an existing
graph. `--economic` rejects any existing economic progress file, including a
failed or uncertain attempt; inspect its receipts and state before deciding a
new action. The successful economic run must not be repeated as an implicit reset.

Official pinned downloads:
[java-tron release](https://github.com/tronprotocol/java-tron/releases/tag/GreatVoyage-v4.8.2.1),
[Temurin release](https://github.com/adoptium/temurin17-binaries/releases/tag/jdk-17.0.20.1%2B1).
The JAR and JDK archive hashes are in `manifest.json`; detached GPG signatures
were not verified locally. Native chain setup follows the
[official private-network guide](https://tronprotocol.github.io/documentation-en/using_javatron/private_network/).

## Runtime authority and recovery

The current production Runtime imports this graph in native `tron` mode and
certifies the real Foundation registration at block 10 using the approved
RPC-attested authority model. The interrupted original import was recovered
from its existing WAL, never reset or replaced with a new database.

`runtime-proof.json` independently checks these saved artifacts:

- R4's original frame/root remains in the WAL. A failed intermediate assertion
  committed a valid duplicate observation at R5; that frame is also preserved.
- Restart from R5 retains the original signed authority hash
  `0x153f6d1fa99dac0399496e2393939162f7e637988f4767ee04a9249f48acf9aa`.
- R6 commits a fresh native observation through solidified block 35; its new
  evidence hash differs while the registration claim hash remains equal.
- Authenticated watcher scan reaches 35. The stored first authority proof retains
  observed height 25: duplicate authority is idempotent, not a mutable freshness oracle.

Two reporting/assertion failures were corrected in the harness: reading frames
from materialized storage instead of WAL, and expecting the immutable authority
store to advance its observation height. Both failed logs are retained. No
production consensus fallback or financial transition was changed.

Historical authority-only command, before the Entity import:

```sh
bun run stand:status
bun run stand:run --reason native-tron-wal-restored-scan --timeout-ms 60000 -- \
  bun scripts/tron/native-stand.ts --runtime-restore
```

The restore mode verifies the original saved anchor and unchanged certified
authority, then records subsequent actual observations. It preserves additional
WAL frames from interrupted prior verification. Do not use fresh import against
this existing database. Repeated restore reports in the data directory may be
replaced; the evidence copies here retain this run.

## Ethereum and native Tron in one Runtime

The preserved private TVM ledger and a separate real Anvil Ethereum ledger are
now imported into one canonical Runtime. Ethereum Foundation authority uses its
receipt-trie proof; native Tron uses the configured RPC attestation. Both stack
identities and registration claims survive restart: original R4 frame/root is
checked exactly before new observations commit R5. Reports are
`cross-network.json` and `cross-network-restore.json`; deployed Ethereum code
hashes are in `ethereum-graph.json` and verified by `ethereum-readback.json`.

Two harness failures remain recorded: stale Bun file metadata after creating a
file, and matching Ethereum evidence by a chainId field it does not contain.
The driver now reopens the file and matches the canonical stack key. Both
existing ledgers and the interrupted WAL were preserved, then explicit resume
and restore runs passed. No financial or consensus implementation changed.

Historical reuse was `--cross-network-restore` under the stand lock. Import and recovery prove
connectivity and authenticated authority, not an ETH↔Tron economic swap.
Both chain processes are stopped and the stand is free. The manifest now covers
36 verified evidence hashes.

Full repository check passes after this driver change: 39 source gates,
40.512-second source phase. Log: `docs/evidence/archive-tmp/xln-cross-network-final-check.log`.

At this earlier import milestone, cross-J financial execution was still open;
the later swap proof above now covers one credit-backed match. Rendered wallet
UI acceptance on native Tron, lending, and public-app acceptance remain open.
No public deployment, real USDT or complete release is claimed.

Previous authority-only verification: `bun run check` passed (39 source gates, 41.711-second source
phase), `git diff --check` passes, and the native process has stopped with the
stand lock released. Full-check log: `docs/evidence/archive-tmp/xln-release-recovery-final-check.log`.
Nothing was committed, pushed or publicly deployed.

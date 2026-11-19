# 05: Prepare the public execution inputs and native-gas budget

Type: implementation
Category: enhancement
Completed: yes
Status: ready-for-human
Blocked by: 03 - Cover the target claim and withdraw at least 0.85 USDC; 07 - USDC-only MM bootstrap; 08 - Public financial CLI; 09 - Funded Runtime restore; 10 - Operator capital and gas plan

## Owner-approved closure scope

On 2026-11-19 the owner limited completion to read-only preparation of one
public 1-USDC demo on the separately funded `fresh-UbkYJm` stand. This scope
uses the original WALs and catalog of that demo stand. It retains separate
approval for public execution in [06](06-public-sepolia-arbitrum-proof.md).

## Acceptance criteria

- [x] Use the production TypeScript path and verify the chain IDs, deployed
      code, six-decimal USDC binding, user and Hub identities, and authenticated
      Account transport on both chains.
- [x] Observe ready operators, an executable quote for all 1,000,000 source
      units, the signed tariff, exact gross target credit and payout backing.
      Check the quoted net payout against the accepted 850,000–1,000,000 range.
- [x] Verify native and token balances, reserves, debts, initial Account
      positions and payer nonces at identified blocks. Keep operator
      prefunding separate from the user's 1-USDC journey.
- [x] Record an exact approval gas estimate, receipt-based gas evidence for
      the remaining calls and the prerequisites for exact estimation.
      Bind normal-flow caps to the three payers and five nonce slots.
- [x] Produce an unsigned manifest bound to the actual executable/configuration,
      catalog, anchors, identities, calls and limits. Verify that the execution
      guard rejects unsigned authority and retain the blocked preparation evidence.

## Verified result

`fresh-ubkyjm-1usdc-20261119` used maker depth for the full 1 USDC. The
recorded quote required 0.999900 USDC of target credit and applied the
signed 0.100099 USDC Hub fee, yielding 0.899801 USDC of projected payout.
Separate funding and authenticated WAL replay established the Hub reserves.
The exact approval estimate was 140,018 gas. The unsigned five-slot grant
reserved 0.001800 ETH for the source user, 0.000050 ETH for the target Hub
and 0.000070 ETH for the target user. Each dependent call required its
own Hanko and exact estimation after the preceding receipt. Preparation
created zero public transaction signatures and broadcasts.

- [Funded reserve and quote evidence](../../../docs/evidence/ts-usdc-cross-j-poc/fresh-ubkyjm-reserves-and-quote.json)
- [Read-only preflight and gas evidence](../../../docs/evidence/ts-usdc-cross-j-poc/fresh-ubkyjm-journey-preflight.json)
- [Unsigned manifest](../../../docs/evidence/ts-usdc-cross-j-poc/fresh-ubkyjm-journey-authority-unsigned.json)
- [Earlier blocked preparation](../../../docs/evidence/ts-usdc-cross-j-poc/local-evidence.md#public-preflightjson)

The cumulative five-run and recovery budget is tracked in
[14](14-five-run-and-recovery-gas-plan.md). The original stand funding and
restore remain tracked in [11](11-separate-operator-funding.md) and
[12](12-public-rpc-capacity-and-funded-catchup.md).

## Recovery evidence for follow-up

The following records describe the earlier `fresh-w4vGds` demo and its
recovery work retained for [14](14-five-run-and-recovery-gas-plan.md).

### Reusing the fresh demo Accounts

The follow-up direct RPC observations were pinned to these blocks. The
previous preflight and receipt observations remain the evidence of what
was true when the demo started and settled.

| Chain            | Block number | Block hash                                                           | Original Hub reserve | Demo Hub reserve | Demo user wallet | Demo bilateral collateral |
| ---------------- | -----------: | -------------------------------------------------------------------- | -------------------: | ---------------: | ---------------: | ------------------------: |
| Ethereum Sepolia |   12,164,043 | `0x55ffb0d13a691389d20c2ae5331c56971f466d13650ff11b7945e938651bc725` |        1.000000 USDC |    0.000001 USDC |    0.000000 USDC |             1.000000 USDC |
| Arbitrum Sepolia |  330,535,304 | `0x2bbc8230ac1fd6f6960ef1c4b173d128779a80d75517538f9185315c6c2fc79c` |        5.000000 USDC |    0.100199 USDC |    0.899801 USDC |             0.000000 USDC |

Both demo user reserves were zero. Ticket 12 requires the original reserves
to be observed, committed to the original WALs and matched after restore.

Offline replay of copied demo stores recovered user Runtime frame 67 and Hub
Runtime frame 221. Their signed Account roots and cached Hankos matched on
both chains. At source Account frame 6, the collateral was 1,000,000 atoms,
all assigned to the Hub by the committed Account delta. The user's
collateral and unsecured claims were zero. Both sides had zero holds and
Pulls, with empty settlement workspaces and no pending Account frame.
The target Account had zero collateral and zero unsecured claims on both sides.
[Historical replay summary](../../../docs/evidence/ts-usdc-cross-j-poc/fresh-public-demo-executed.json)

The current `prepare` would reject a new manifest for those Accounts with
`USDC_EXECUTION_EXISTING_POSITION_REQUIRES_ORIGINAL_AUTHORITY`. All five
slots from the old one-run manifest were consumed. The earlier five-run
local test reused the Accounts inside a single manifest and verified each
previous run's settlement before proceeding. A repeat after a consumed
manifest crosses the new-campaign admission boundary.
[Preparation guard](../../../jurisdictions/scripts/usdc-cross-j-preflight/execution/prepare.ts#L48)
· [Five-run test](../../../core/__tests__/market/startup/usdc-public-journey.test.ts)

1. **Cooperative source C2R.** To reuse the current `prepare` guard, the source
   Hub can propose C2R of its 1 USDC with the user's agreement. The canonical
   diff compiler projected zero Account collateral, zero unsecured claims on
   both sides and an exact 1 USDC increase in the source Hub reserve. This was
   a calculation against the replayed frame. An executable settlement still
   needs fresh bilateral state, signatures, the current Account nonce and a
   separately authorized source Hub transaction. The default auto-C2R threshold
   is 500 USDC, so the 1-USDC collateral alone will leave the Account unchanged.
   Confirm the settlement receipt and its authenticated WAL observation before
   preparing the new campaign. [Canonical C2R compilation](../../../core/protocol/settlement/operations.ts#L160)
2. **Admission after a proven prior campaign.** A CLI change could retain the
   existing collateral. Reconcile the previous campaign's exact receipts,
   both terminal route legs and matching signed Account heads. Check the
   user reserve, effective spendable collateral, debts, workspaces, Pulls
   and pending Account/J work. Anchor the observed raw collateral as the
   starting amount and revalidate before the new approval. Fix the
   `requireSourcePrincipal` check for freshly opened runs too: it currently
   treats any raw collateral as accepted ingress. A two-manifest local test
   should prove a new exact 1-USDC debit and a separate payout, plus rejection
   before approval when funds or completion evidence are missing.
   [Source principal check](../../../jurisdictions/scripts/usdc-cross-j-preflight/execution/flow/run.ts#L122)

Both approaches need 1 new source USDC in the user's wallet. At the old
quote, the target Hub's 0.100199 USDC left a 0.799602 USDC cover shortfall.
Refresh the quote and free backing before setting the top-up amount.
The [funding CLI](../../../docs/runtime/usdc-poc-operator-funding.md#prepare-without-signing)
supports a separately approved single-chain top-up against the manifest's
anchored reserve. Source C2R credits the source Hub on Ethereum Sepolia.
Target cover uses the target Hub on Arbitrum Sepolia.

### Local repeat after C2R

Two private Anvil chains reproduced the one-run balances. The first journey
paid 0.899801 USDC through the canonical Runtime commands. The production
`prepare` rejected the next campaign while the source collateral remained.

- The source Hub proposed cooperative C2R through the authenticated Runtime
  adapter. One successful compressed C2R moved 1 USDC from collateral into
  the source Hub reserve. User and Hub observed matching signed Account heads,
  the on-chain collateral fell to zero and the user wallet was unchanged.
- The local sponsor used an exact approval and signed E2R to add 0.799602 USDC
  to the target Hub reserve. The reserve went from 0.100199 to 0.899801 USDC,
  and the helper reconciled the sponsor debit and Depository backing change.
- The same production `prepare` then emitted a new unapproved one-run manifest
  for the same entities and payers. Its source-user window started at nonce 3.
  The target Hub and user each started at nonce 1. The production financial CLI
  restored the same stores and executed the locally approved copy. Five
  successful receipts prove a fresh 1-USDC deposit and a second 0.899801-USDC
  payout. The target wallet balance increased from 0.899801 to 1.799602 USDC.

The C2R command and sponsor top-up ran through the local fixture. A public
repeat requires separately bounded settlement and top-up packets, refreshed
quote and balance checks, and a separately approved normal-flow manifest.
[Local receipts and candidate binding](../../../docs/evidence/ts-usdc-cross-j-poc/local-c2r-repeat.json)

The subsequent [funding CLI test](../../../docs/evidence/ts-usdc-cross-j-poc/funding-target-topup.json)
verified the same reserve top-up through the bounded prepare/run interface.
Manifest version 2 records the declared opening reserve against the chain
anchor. Approval and E2R consumed exactly two Arbitrum slots. Recovery after
interruption and reconfirmation reused their receipt hashes.

### Unsigned source C2R packet

The [review packet](../../../docs/evidence/ts-usdc-cross-j-poc/fresh-public-demo-source-c2r-unsigned.json)
scopes one compressed C2R for 1 USDC to the existing source Hub on Ethereum
Sepolia. Two read-only RPCs agreed at block 12,164,210 on contract code,
collateral, reserve, debt, dispute and signer state. The Hub payer's
confirmed and pending EOA nonce was 0. Hub Entity batch nonce 1 and
Account settlement nonce 8 are the next values derived from the chain
and the retained bilateral WAL respectively. Recheck the Account nonce
and cooperative hash after the new workspace is committed.

The proposed cap is 600,000 gas, 1 gwei max fee and 0.1 gwei priority
ceiling, for at most 0.0006 native ETH. The Hub payer had 0.001 ETH at
the recorded block. The packet leaves the two Hankos, final calldata
and exact gas estimate unset. The first execution prerequisite is a
bounded source-Hub C2R authorization. Use read-only RPC while validating
the restored Accounts, then estimate the exact signed batch before
submission.

### Gateway authorization for one source C2R

The [execution guide](../../../docs/runtime/usdc-poc-execution.md#release-the-existing-source-collateral)
records the separate `--source-c2r-authority-file` mode. It binds one Ethereum
Sepolia payer nonce to the existing source Hub and user Account, one compressed
1-USDC C2R, the opening chain state and the approved gas ceilings. Both Hankos
must verify before forwarding. A duplicate can recover only the original
pending hash or the same exact successful settlement receipt.

The local regression passed 17 tests and 125 assertions, including the
existing five-run campaign. The C2R moved 1 USDC into the source Hub reserve
with one receipt. Pending replacement, mined replacement and a second nonce
were rejected. Deployment TypeScript and `bun run check` passed.
[Local C2R evidence](../../../docs/evidence/ts-usdc-cross-j-poc/source-c2r-gateway.json)

The [unsigned gateway manifest](../../../docs/evidence/ts-usdc-cross-j-poc/fresh-public-demo-source-c2r-authority-unsigned.json)
binds the current candidate to Ethereum Sepolia block 12,164,312, Hub EOA
nonce 0, Hub batch nonce 1, and Account settlement nonce 8. Its proposed
expiry is 23:14 UTC on 2026-11-18. Two RPCs agreed on the opening position,
and offline replay recovered the same Account frame 6 from both retained WALs.
The gateway rejected the unsigned manifest with `USDC_EXECUTION_AUTHORITY_MISSING`.
[Manifest preflight](../../../docs/evidence/ts-usdc-cross-j-poc/fresh-public-demo-source-c2r-manifest-preflight.json)

The read-only observation restored copies of the original Hub and user WALs
with delivery fenced and authenticated Ethereum Sepolia through blocks
12,164,348 and 12,164,374 respectively. Both copies retained the same Account
frame 6, cached Hankos and next settlement nonce 8. Two RPCs confirmed the
manifest's opening position and Hub payer nonce at block 12,164,378. The
original stores remained untouched. [Runtime observation](../../../docs/evidence/ts-usdc-cross-j-poc/fresh-public-demo-source-c2r-runtime-readiness.json)

The owner authorized one C2R under the manifest. The original Hub and user
Runtimes restored and agreed on the settlement workspace. The first attempt
stopped before `j_broadcast` when the local runner tried to convert the absent
initial Entity batch nonce. Replay recovered the existing signed workspace,
and the runner resumed its one queued C2R using the canonical initial nonce 0.

The signed `processBatch` estimated 718,231 gas with the enabled 100% gas
factor. The gateway rejected the signed wire against the 600,000-gas cap
before forwarding it. Two RPCs showed confirmed and pending EOA nonce 0,
1 USDC still in collateral, and 0.000001 USDC still in the Hub reserve at
block 12,164,522. Account frame 10 matches in both WALs. The Hub retained its
prepared wire at Runtime frame 236 and the batch record at frame 237.
[Stopped execution and WAL evidence](../../../docs/evidence/ts-usdc-cross-j-poc/fresh-public-demo-source-c2r-execution-stopped.json)

The [new unsigned manifest](../../../docs/evidence/ts-usdc-cross-j-poc/fresh-public-demo-source-c2r-saved-wire-authority-unsigned.json)
matches the saved wire's exact 718,231 gas limit and 0.000718231 ETH maximum
fee. Two RPCs agreed at block 12,164,599 and returned no transaction or
receipt for the saved hash. WAL replay recovered that hash at Hub frame 236
and matched Account frame 10 on both sides. The proposed expiry is
00:13 UTC on 2026-11-19. [Saved wire and RPC evidence](../../../docs/evidence/ts-usdc-cross-j-poc/fresh-public-demo-source-c2r-saved-wire-preflight.json)

The terminal J-submit result leaves the active outbox empty. On a copy of the
original WAL, normal broadcast, automatic retry and `j_rebroadcast` each
blocked the existing attempt. The historical prepared transaction record is
accepted only from Runtime-owned processing or WAL replay.

The existing `j_abort_sent_batch` with `requeueToCurrent: true`, followed by
`j_broadcast`, rebuilt the same single C2R draft in memory. It preserved the
user's Hanko, encoded batch, batch hash, Account nonce 8 and Hub batch nonce 1.
It advanced the local broadcast generation from 1 to 2 and emitted a new
Hub certification intent with no prepared EVM transaction. This path needs
separate authorization for the local requeue and normal EVM preparation.
Preserving the already-signed EVM hash requires an explicit Runtime recovery
path that restores the verified historical wire to the active outbox.

Two Sepolia RPCs agreed at block 12,164,792 that the EOA nonce is still 0,
collateral is 1 USDC, and the prepared hash has no transaction or receipt.
The review produced no signatures, committed frames or broadcasts.
[Recovery proof](../../../docs/evidence/ts-usdc-cross-j-poc/fresh-public-demo-source-c2r-recovery-review.json)

The [requeue manifest](../../../docs/evidence/ts-usdc-cross-j-poc/fresh-public-demo-source-c2r-requeue-authority-unsigned.json)
pins the same settlement to Ethereum Sepolia block 12,164,807. Its proposed
800,000-gas ceiling includes 81,769 gas above the exact prior estimate. The
fee ceilings remain 1 gwei maximum and 0.1 gwei priority, with a maximum
native cost of 0.0008 ETH. The proposed expiry is 00:56 UTC on 2026-11-19.
The gateway rejected the unsigned manifest at the authority check.

The [requeue packet](../../../docs/evidence/ts-usdc-cross-j-poc/fresh-public-demo-source-c2r-requeue-packet.json)
specifies the local abort and recovery commands, the exact retained batch
and the conditions for one new EOA signature and one public C2R. The two RPCs
and a second reducer rehearsal on copied WALs confirmed the opening position.
Fresh exact gas estimation remains an execution prerequisite. Target top-up
and new user ingress retain their own funding and execution prerequisites.

The 00:56 UTC proposal expired. A [renewed unsigned manifest](../../../docs/evidence/ts-usdc-cross-j-poc/fresh-public-demo-source-c2r-requeue-202611191526-authority-unsigned.json)
anchors the same scope and fee ceilings at Ethereum Sepolia block 12,169,267
and proposes expiry at 17:26 UTC on 2026-11-19. Two RPCs confirmed the opening
position and free EOA nonce 0. Replay on copied WALs confirmed Account frame 10
and the same requeued batch. The retained Hub and user scan heights imply 309
receipt pages, with about 64 minutes of pacing at 12.5 seconds per page before
other startup or confirmation time. This estimate motivated the two-hour
window. [Renewed packet](../../../docs/evidence/ts-usdc-cross-j-poc/fresh-public-demo-source-c2r-requeue-202611191526-packet.json)

### C2R execution stopped after the retry

On 2026-11-19 the first execution stopped on a user watcher drain stall.
The retry used PublicNode headers and 96-call HyperRPC receipt batches.
Both Runtimes recovered through the captured Ethereum Sepolia target.
Hub frame 275 committed one `j_abort_sent_batch`, and frame 276 committed
one `j_broadcast`. Frame 277 retained generation 2 of the original batch.
Both Hankos passed verification, and the exact estimate was 718,231 gas.

After relay connection and delivery activation, Hub stopped with
`CROSS_J_PULL_CLOSE_PROPOSAL_FAILED` because a source close from the previous
Cross-J exceeded its deadline. Replay of the copied WALs found one pending
Hub outbox entry and zero new EOA preparations or replacements. Both Account
views still match at frame 10. Two RPCs confirmed payer nonce 0 for `latest`
and `pending`, no receipt for the prior hash, and 1 USDC still in collateral.
The stand was released. Recovery now starts from an already certified batch
and requires resolving the expired close before delivery activation.
[Execution and reconciliation evidence](../../../docs/evidence/ts-usdc-cross-j-poc/fresh-public-demo-source-c2r-requeue-202611191526-execution.json)

## Verification

- 74 owning tests passed, 0 failed, 1,264 assertions across 17 files.
- Full local recovery matrix: 3/3 cases, eight interrupted-process restores,
  with two full external payouts and one separately classified expired clear.
- `bun run check` passed after fixing the new CLI's folder-width placement;
  source profile 38/38, soundcheck 10/10, frozen core unchanged.
- `tsconfig.deployment.json` checks the preparation CLI, operator probe and its
  tests; deployment TypeScript check passed.
- The earlier public preparation probe accepted unfunded identities and
  rejected the funded deployment wallet before Runtime startup. The later
  one-run demo evidence and read-only chain recheck are listed above.

## Follow-up interview

On 2026-11-17 the owner requested a new grill-with-docs round.
The [current guide](../../../docs/runtime/usdc-poc-preflight.md#confirmed-software-blockers)
separates MM lifecycle, public financial CLI, restore startup, operator
credit/liquidity and authorized execution prerequisites. These software tasks
do not require funding to begin. The owner accepted Q8 and the narrow MM patch
in 07. The [decision map](../map.md#blocker-tickets) now links separate tickets
07-11, including a separate owner-approved funding step before final preflight.

## Comments

The owner requested explicit blocker tickets on 2026-11-17. On 2026-11-19
the owner closed this ticket for the one-run demo and deferred the five-run
and recovery budget to [14](14-five-run-and-recovery-gas-plan.md).

The [funded restore launcher](09-funded-runtime-restore.md) is used with
the original stores. The older `operators/local-operators.ts` probe uses
fresh attempt stores and rejects funded identities.

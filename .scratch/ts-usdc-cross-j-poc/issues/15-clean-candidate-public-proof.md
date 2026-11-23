# 15: Prove the public journey on a clean committed candidate

Type: implementation
Category: enhancement
Completed: yes
Status: ready-for-human
Blocked by: 04 - Interrupted journey recovery; 05 - Public single-run preparation; 06 - Public single-run demo

Produce a verified one-USDC public proof on a clean, committed candidate and
retain a self-contained signed Cross-J trace. The owner closed
[06](06-public-sepolia-arbitrum-proof.md) as an observed demo on 2026-11-19.
Its existing receipt and WAL evidence records the actual working-tree digest.

## Acceptance criteria

- [x] Verify the immutable SHA and its committed configuration on a clean tree
      with the owning financial/recovery checks and the applicable broad
      verification profile.
- [x] Bind the public run manifest to the verified SHA. Refresh operator
      funding, executable quote and tariff, balances, credit,
      chain bindings, nonce slots and payer limits for this candidate. Obtain
      explicit spending authority for the exact public run and any separate
      recovery obligations before submission.
- [x] Prove one full public deposit of 1 USDC, signed Cross-J execution and
      external payout in the accepted range with zero source remainder and
      no unresolved Pull or pending Account ACK. Bind the receipts and WAL
      evidence to the exact tested SHA and manifest.
- [x] Retain the maker order, signed route authorization, actual fill sequence,
      both Account commitments, deadline and reveal evidence. Preserve raw
      receipts, pinned balance snapshots and payer costs by chain, including
      applicable Arbitrum fee components, in durable evidence. Keep vault seeds
      and private keys out of the package.
- [x] Report the scope of this public proof and the separate whole-product
      acceptance gates under AGENTS.md.

## Evidence

The [completed proof](#completed-public-proof-on-1ce560d95) closed the ticket.
The artifacts from earlier attempts are in the
[local archive](../../../docs/evidence/ts-usdc-cross-j-poc/local-evidence.md#ticket-15-earlier-attempts).

- [Clean candidate `c77866445` and local verification](../../../docs/evidence/ts-usdc-cross-j-poc/local-evidence.md#ticket-15-clean-candidate-verification)
- Public read-only preflight on `c77866445`. On 2026-11-20 two RPCs agreed that
  `fresh-UbkYJm` had zero USDC in the source user's EOA, 1 USDC in the source
  Account collateral and 0.100199
  USDC in the target Hub reserve. `prepare` rejected the existing position
  and produced no manifest. The old offer had expired. A repeat requires new
  source principal, quote-based target backing and resolution of the source
  collateral, or a separately funded stand.
- Fresh stand preparation on `c77866445`.
  `ticket15-fresh-R6LBjJ` opened two authenticated user Accounts and passed
  replay across 101 WAL frames. The unsigned funding manifest bound the nine
  calls to the stand and candidate. Its SHA-256 is
  `09e566a79f6f846031db6989020d4d86685ff45c489460ce73b738cb51f47fdb`.
- Confirmed fresh stand funding.
  On 2026-11-20 all nine authorized calls succeeded with at least 12
  confirmations. The source user received 1 USDC, the source Hub reserve is
  0.000001 USDC, and the target Hub reserve is 1 USDC.
- Authenticated reserve observation and fresh quote.
  Both E2R receipts match committed events in the original Hub WAL. Replay
  recovered both reserves at Hub frame 87. The observed quote covered the full
  1 USDC principal and projected a 0.899801 USDC payout under signed tariff
  version 1.
- User journey manifest and read-only preflight. The manifest bound one run
  and five nonce slots to `c77866445`. Its SHA-256 is
  `af4ac59ca06145e5bf080904693300635f8cf2486bb8bc79d501626313b173de`.
  Current and archive RPCs agreed on both anchors. The exact unsigned approval
  estimate was 140,018 gas. The remaining four estimates required their authorized Hanko
  and preceding receipts. The owner authorized this manifest. Execution
  revalidated the quote, signed tariff and payout backing before approval.
- Stopped public journey. Two RPCs agreed on receipts and balances.
  All three authorized Ethereum Sepolia calls succeeded. The contract holds
  1 USDC in the source Account collateral, and both Arbitrum Sepolia nonce
  slots remain unused. Source gas cost was 13,252,016 wei.
  The 10-minute collateral wait expired after the user watcher authenticated
  block 12177004. The collateral receipt is in block 12177005. Hub finalized
  that block and has a pending Account proposal. The user WAL still shows the
  sent R2C batch and 1 USDC in reserve, with no committed bilateral collateral
  claim. The stopped WALs contain no Cross-J admission. The stand is stopped
  and all 313 WAL frames passed the integrity check.
  This evidence covers source ingress on the clean TypeScript candidate.
  This attempt ended before signed Cross-J or payout. Whole-product
  acceptance follows the owning financial, recovery and browser release gates
  in [AGENTS.md](../../../AGENTS.md#verification-scope).
- [Completed public demo and its recorded candidate](../../../docs/evidence/ts-usdc-cross-j-poc/fresh-ubkyjm-journey-executed.json)
- [Canonical nonce-based receipt report](13-public-report-exact-nonce-receipts.md)
- [Five-run and recovery budget](14-five-run-and-recovery-gas-plan.md)

## Continuation from the existing collateral

Keep `ticket15-fresh-R6LBjJ`, run ID `ticket15-r6lbjj-1usdc-20261120`,
candidate `c77866445`, the original catalog and all three Runtime stores.
The independent receipt snapshot at 19:07:37 UTC on 2026-11-20 showed exactly
1 USDC in source Account collateral and zero in the user reserve. Sepolia
source nonce was `3/3` (latest/pending) and both Arbitrum payers were at
`0/0`. Recheck these positions, the three original receipt hashes, the
contract code, disputes, debts, target backing and payer balances against
current and archive RPC before a live step.
[Read-only status](../../../jurisdictions/scripts/usdc-cross-j-preflight/execution/status/report.ts)
compares the original manifest and copied WAL with chain observations.

| Ethereum Sepolia step | Confirmed transaction hash                                           |
| --------------------- | -------------------------------------------------------------------- |
| Approve               | `0x56aad405abd84f1045bff05e21f6061e84102450c11da6ab48570f9f79f251cb` |
| Deposit               | `0x2ac2cbedca56f7e81e354c7c54aad1e5d8312dd3c6caf5a5b0da7de1d34471ef` |
| Collateral            | `0xe234617183d7a16092f1df66e85d1eeccfd7b6e97b7732fad0fd2b1c97961975` |

1. **Finish observing the existing transfer. Completed on 2026-11-20.**
   With owner approval for WAL writes and ordinary Account/Entity consensus
   signatures, restore the
   original Hub, MM and user through the managed session and authenticated
   relay. Run the gateway without either execution authority file. Verify
   that all Runtime RPC traffic uses this read-only gateway and that the
   restored child configuration disables EVM fee replacements. Confirm the
   exact mined R2C on each configured RPC read path and check that the
   original WAL has no other queued J submissions before enabling delivery.
   Let the watcher authenticate from its restored cursor to a captured safe
   head. It must include the receipt at block `12177005` and the matching
   `AccountSettled` event. A recent watcher height is only a progress
   indicator. Require the same committed Account root on the user and Hub,
   user `outCollateral = 1_000_000`, user reserve zero, the R2C batch cleared,
   and no outstanding Account proposal, ACK or Cross-J route for this run.
   Save the verified positions and stop the observation session cleanly.
   [User restore](../../../jurisdictions/scripts/usdc-cross-j-preflight/operators/session/user.ts)
   · [Read-only RPC](../../../jurisdictions/scripts/usdc-cross-j-preflight/provider.ts)
   · [Bilateral J claim](../../../core/account/tx/handlers/j-events/claim.ts)

   The final session started Hub and user in parallel after MM's Arbitrum
   catch-up stalled on RPC limits. Both active Runtimes verified both chains
   before exchanging the Account update. MM stayed at the same WAL height
   during this session. The two Runtimes certified source Account frame 4
   for the existing receipt at block 12177005. User collateral is 1 USDC,
   user reserve is zero, and the R2C batch has cleared. Replay verified both
   certified claims and found no pending Account work or Cross-J admission.
   The supervisor forced the user process to stop after its 10-second grace
   period. The stand was released and all 519 WAL frames passed integrity
   verification. Two RPCs confirmed the original three receipts and unchanged
   public balances and nonces.

2. **Authorize and continue the same run.** Preserve the original anchors,
   source nonce base and three mined source slots as history. The v1 authority
   schema still contains five slots, and `prepare` rejects an existing
   position. Prepare an unsigned continuation packet with a new expiry and
   explicit public write scope limited to Arbitrum Sepolia Hub nonce `0`
   (cover, 500,000 gas, 0.000050 ETH cap) and user nonce `0` (settle and
   withdraw to the same target user's wallet, 700,000 gas, 0.000070 ETH cap).
   Both max fee and priority fee remain capped at 0.1 gwei. Verify that the
   gateway rejects Ethereum sends before arming it. The stock writer uses
   nonce checks and opens writers for both chains. The original spending
   grant expired at 20:18 UTC. Keep the approval preflight bound to its
   original digest, since the renewed authority uses a new report namespace.
   [Authority schema](../../../jurisdictions/scripts/usdc-cross-j-preflight/execution/authority.ts)
   · [Gateway writer](../../../jurisdictions/scripts/usdc-cross-j-preflight/operators/execution-writer.ts)

   Prepared the unsigned continuation packet
   for the same two Arbitrum calls, with a proposed expiry of 23:30 UTC on
   2026-11-20. Its SHA-256 is
   `dbd11684e692b28782ce835942d6bcdcb7ddb85e82703217746013c39c2f8b15`.
   It bound the unsigned v1 execution manifest, the three original receipts
   and the synchronized Account root. Two RPCs confirmed both Arbitrum payer
   and Entity nonces at zero and the 1 USDC
   Hub reserve. The approved scope must be bound to the continuation packet
   hash. The gateway guard, live quote and exact Hanko gas checks remain
   prerequisites for execution.

   The host gateway passed offline verification on the same candidate.
   It rejected the three original Sepolia wires
   across 15 HTTP route probes, signing aliases, mixed write batches and
   startup with the unsigned authority. The gateway keeps original receipt
   and authority-digest reads. The target writer requires the exact payout
   and a confirmed cover before withdrawal. Its armed path and exact target
   Hanko remain unverified.

3. **Recheck the economics and collect final proof.** Under the new grant,
   start the same financial runner against the restored stores. It reuses
   the original approval receipt and the committed collateral. Confirm a
   live maker quote for all 1 USDC, signed tariff, target credit and backing,
   and net payout of 0.850000–1.000000 USDC before dispatching Cross-J.
   Verify each target batched call's exact Hanko and gas after its prerequisite
   is confirmed. Record both target receipts, the wallet balance change,
   signed Cross-J evidence and final Account positions. Stop on any changed
   receipt, unexplained nonce, unavailable proof, expired terms, or
   out-of-range payout. Any C2R recovery requires separate authorization.
   [Canonical run](../../../jurisdictions/scripts/usdc-cross-j-preflight/execution/flow/run.ts)

   The quote handoff passed eight offline checks.
   The host continuation runner confirms the existing source Account and
   approval receipt. It publishes the exact net payout immediately before
   canonical Cross-J submission, after checking the full-lot maker quote,
   both Account Hanko, unchanged signed tariff and verified backing. The
   packet, authority and run identify a single handoff record that the
   gateway reads for both calls. The offline reference quote produced
   899,801 atoms. Live Hub/MM readiness, signing guards and the current
   executable quote are prerequisites on the original stand.

   The live read-only preflight on 2026-11-20 at 22:06 UTC confirmed Hub and
   MM readiness, original
   source Account frame 4, all three exact Ethereum receipts and unused
   Arbitrum EOA and Entity slots. The signed tariff yielded a payout of
   899,801 atoms on the full 1 USDC, covered by 1 USDC in the target Hub
   reserve. The session ran with EVM signing denied and a gateway without
   writers.

   The owner authorized the continuation packet until 23:30 UTC. The
   guarded continuation stopped at 23:17:12 UTC
   when the MM Arbitrum watcher stalled at block 331129028 after repeated
   `RPC_BATCH_TIMEOUT:5000` errors. The first startup was restarted during
   catch-up with the same authority after confirming both target nonce
   slots were unused. The second used batch receipts on Ethereum and kept
   the canonical Runtime verification. Neither startup reached a fresh
   bound quote or Cross-J admission.

   Two-RPC reconciliation confirmed the original three Ethereum receipts, 1 USDC in source
   collateral, 1 USDC in the target Hub reserve and both Arbitrum payer
   nonce slots at `0/0` (latest/pending).
   Stopped WAL evidence covers 782 frames and contains no Cross-J admission or new Arbitrum
   signed attempt. The original source Account remains at frame 4.
   The stand stopped without a signed Cross-J trace or payout.

## Fresh funded stand on 2026-11-21

The owner authorized a single fresh stand and one public journey on
`c77866445`. `ticket15-warm-FadKvT` created two authenticated user Accounts
and reached Hub and MM J-readiness in 21.843 s and 40.366 s. The funding and
journey manifests bound the original actors and nonce slots. Both RPCs
confirmed all nine funding receipts.

The initial warm session stopped before the user journey. Ethers batches a
single signed send with block-number and chain-ID reads. A local relay
replacement added handling for that request. The development transport
policy halted the three original Runtime loops on disconnect.
Post-stop verification confirmed zero journey broadcasts, all three journey payers at `0/0`
(latest/pending), 1 USDC in the source user's wallet and 1 USDC in the target
Hub reserve. WAL verification covered 164 frames with zero signed user
journey attempts and zero user Cross-J admissions.

The owner authorized one restart of the same three Runtime stores.
The restore expired before user readiness at the 17:33 UTC spending cutoff.
Hub and MM completed the startup drain.
The restored user authenticated 8,762 Arbitrum blocks, through
`331414596`, and was still processing its startup
range. The PublicNode header path recorded 177 HTTP 429 responses.
The user journey gate remained closed. Independent RPCs confirmed no
effect from the five journey slots and 1 USDC still in the source wallet.
WAL verification covered 502 frames with no signed journey attempt
or user Cross-J admission. The spending window expired with all journey
slots unused.

## Final public proof campaign

Commit `1ce560d954f4f59dc4e0bf5f9182dc1ad225711d` passed the full pre-push
profile in a clean checkout and was published to `origin/testnets_deploy`.
The same checkout passed 24 owning PoC tests, including 100 assertions in
the supervised journey on local Anvil. The previous warm-stand manifest
bound `7b92e63cc` and had expired before this candidate's public run.

At 15:21 UTC on 2026-11-22, read-only checks on Ethereum Sepolia block
`12189579` and Arbitrum Sepolia block `331711250` found 1 USDC in the warm
stand's source wallet, 1 USDC in the target Hub reserve, and zero user
reserve and Account collateral on both chains. All three journey payers
were at `0/0` (latest/pending). The five planned slots had no observed
transaction. The stopped user WAL matched its materialized head at frame
185, with finalized J heights `12182752` and `331405834` respectively.

The last measured warm recovery sample projected 2 h 07 min to 2 h 17 min
across the two networks. The public heads have advanced since that sample.
Reusing the warm stand reuses its funding and requires read-only catch-up
before requesting a new spending window. A fresh stand can use the canonical
anchor for eligible new Entities. Its funding requires a new unsigned
nine-call manifest and explicit authority before submission. The old funder
covered both previous testnet funding caps at 15:22 UTC, with nonces
`129/129` on Ethereum Sepolia and `49/49` on Arbitrum Sepolia. Both options
require a fresh executable quote, signed tariff and one authorized public
journey on the candidate selected for the proof.

### Fresh stand prepared on `1ce560d95`

`ticket15-fresh-pQmqWH` uses new Hub, MM and user vaults, the same existing
USDC deployments and a local read-only gateway. Hub and MM reached J
readiness in 16.892 s and 36.009 s. The user opened both authenticated
Accounts. The stopped stores restored 100 verified WAL frames across the
three Runtimes. Preparation produced zero public signatures or broadcasts.

The [unsigned nine-call funding manifest](../../../docs/evidence/ts-usdc-cross-j-poc/ticket15-fresh-pqmqwh-funding-unsigned.json)
has SHA-256 `16277245d2608e9aa8b043644b78ba52a2c345f8d89e3aa8ef09112b307313b0`
and expires at 17:29:23.512 UTC on 2026-11-22. Its [preparation and audit](../../../docs/evidence/ts-usdc-cross-j-poc/ticket15-fresh-pqmqwh-preparation.json)
verify unused funder nonce slots `129–133` and `49–52`, matching contracts
and recipients, seven estimates within the reviewed limits, and available
balances and fee headroom. Both E2R estimates still require the confirmed
allowance and authorized Hanko. Funding awaits explicit authority.

### Fresh stand funding confirmed

On 2026-11-22 the owner approved the exact nine-call manifest. All nine calls
succeeded with at least 12 confirmations. Two RPC paths matched each raw
receipt. The original funder nonce slots are consumed, with latest and pending
both at 134 on Ethereum Sepolia and 53 on Arbitrum Sepolia. The funding Entity
nonce is 8 on both chains.

| Chain            |   Hub reserve | Hub signer |          User wallet |        Actual gas fees |
| ---------------- | ------------: | ---------: | -------------------: | ---------------------: |
| Ethereum Sepolia | 0.000001 USDC |  0.001 ETH | 1 USDC and 0.002 ETH | 95,492,615,944,230 wei |
| Arbitrum Sepolia |        1 USDC | 0.0001 ETH |           0.0001 ETH |  4,967,595,756,000 wei |

The [execution report](../../../docs/evidence/ts-usdc-cross-j-poc/ticket15-fresh-pqmqwh-funded-public.json)
binds the receipts to the approved unsigned checksum. The [independent receipt
and balance reconciliation](../../../docs/evidence/ts-usdc-cross-j-poc/ticket15-fresh-pqmqwh-funding-receipts.json)
confirms all nine calls and credit amounts. Restore the original stores to
observe funding in Runtime and obtain an executable quote before requesting
authority for the user journey.

### Funded Runtime and fresh quote on `1ce560d95`

The original funded Hub, MM and user stores restored on 2026-11-22.
The read-only session verified both E2R receipts against Hub WAL
`ReserveUpdated` observations and checked 118 WAL frames. Both operators
reached readiness. At 15:57:04 UTC, the matching maker offer covered the
entire 1 USDC source amount at 0.999900 USDC gross. Signed tariff version 1
charged 0.100099 USDC, leaving a projected 0.899801 USDC payout. The target
Hub reserve is 1 USDC, both checked debt counts are zero, and all three
journey payers are at `0/0` with sufficient gas balances. The destination
Account starts with zero credit. The canonical journey requests the exact
0.999900 USDC credit before Cross-J. The read-only session stopped cleanly.

The [quote, account, and WAL evidence](../../../docs/evidence/ts-usdc-cross-j-poc/ticket15-fresh-pqmqwh-reserves-and-quote.json)
and [unsigned user journey manifest](../../../docs/evidence/ts-usdc-cross-j-poc/ticket15-fresh-pqmqwh-journey-unsigned.json)
bind `ticket15-pqmqwh-1usdc-20261122` to `1ce560d95`. The unsigned manifest
SHA-256 is `1d35072041c0b2ffb09a66fb449e86d2104b09fd4c1f335c3752ad310e17d0cb`.
It expires at 17:56:54.161 UTC and requires separate authority for all five
calls. Revalidate the fresh quote, tariff, backing and nonces before sending.

### Completed public proof on `1ce560d95`

On 2026-11-22, the canonical CLI completed `ticket15-pqmqwh-1usdc-20261122`
on `ticket15-fresh-pQmqWH` within the approved window. It restored the original
funded stores, revalidated Hub and MM readiness, the executable quote, signed
tariff, credit, backing, balances and nonces, then executed the five authorized
calls. The complete 1 USDC deposit filled in one Cross-J execution. Gross
output was 0.999900 USDC, the signed tariff charged 0.100099 USDC, and the
recipient `0x28360c2e06e220f2fd245f299db4661a538cef19` received 0.899801 USDC.

Two RPCs agreed on all five successful receipts, the block hashes used to pin
the balance snapshots, and the Arbitrum L1 gas fields. Payer ETH balance changes
matched the actual fees: 13,770,616 wei for the Ethereum Sepolia user,
3,725,734,272,000 wei for the Arbitrum Sepolia Hub and 5,636,343,414,000 wei
for the Arbitrum Sepolia user. Both Arbitrum receipts reported zero
`gasUsedForL1`.

The replay verified 237 WAL frames across user (59), Hub (115) and MM (63).
The signed trace binds the admitted maker order and its reciprocal fill at
Hub frame 84 to the authorized route. The two Account closes match their
bilateral Hanko certificates and the same verified reveal within their
signed deadlines. Both terminal Account roots agree across the Hub and user,
with zero available user balance, unresolved Pulls or pending Account ACKs.
The source on-chain Account still records the 1 USDC of collateral, which
the closed bilateral state assigns to the Hub. The public proof covers this
browserless EVM testnet journey on the verified candidate. Whole-product
acceptance is governed by [AGENTS.md](../../../AGENTS.md#verification-scope).

- [Execution report and approved manifest binding](../../../docs/evidence/ts-usdc-cross-j-poc/ticket15-fresh-pqmqwh-journey-executed.json)
- [Raw receipts, pinned balances, nonce windows and actual fees](../../../docs/evidence/ts-usdc-cross-j-poc/ticket15-fresh-pqmqwh-journey-receipts.json)
- [Signed route, maker fill, Account commitments, deadlines and reveal](../../../docs/evidence/ts-usdc-cross-j-poc/ticket15-fresh-pqmqwh-journey-signed-trace.json)
- [WAL integrity results](../../../docs/evidence/ts-usdc-cross-j-poc/ticket15-fresh-pqmqwh-journey-wal.json)

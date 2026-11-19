# Fresh public stand for the one-USDC demo

## Repeat stand on 2026-11-19

The `fresh-UbkYJm` stand uses the same two deployments and USDC registrations
as `fresh-w4vGds`. The three new vaults passed the unfunded identity check. Hub
reached Jurisdiction readiness after 16.794 seconds and MM after 37.934 seconds.
The new user opened two signed bilateral Accounts. WAL integrity checks covered
97 frames across Hub, MM and user. Restored Account roots and Hankos matched the
live views. The live user send queue had drained. Replay restored the one
output committed in the final WAL frame and matched its digest.
[Startup and replay evidence](../evidence/ts-usdc-cross-j-poc/fresh-ubkyjm-preparation.json)

The stand stopped after verification. The unsigned funding packet uses the
same funding EOA and one-run limits as the previous demo. It targets the new
Hub Entities and user signers. All seven simple estimates fit their limits.
The two E2R estimates require confirmed allowances and authorized Hankos.

| Chain            | Funder nonce slots | Hub reserve funding | User wallet funding  | ETH outflow ceiling |
| ---------------- | -----------------: | ------------------: | -------------------- | ------------------: |
| Ethereum Sepolia |            114–118 |       0.000001 USDC | 1 USDC and 0.002 ETH |        0.004600 ETH |
| Arbitrum Sepolia |              37–40 |       1.000000 USDC | 0.0001 ETH           |        0.000329 ETH |

The caps include ETH topups of 0.001 ETH to the source Hub signer and
0.0001 ETH to the target Hub signer. The manifest expires at 19:25:23.860 UTC
on 2026-11-19 and has SHA-256
`f7c4cedce67e0636da18055dbddf21ac3b11573427a73002339f8fc7ec40bcc5`.
Preparation produced zero public transaction signatures and zero broadcasts.
After funding, the same WALs need to observe the reserves and the financial
preflight needs a fresh executable quote for exactly 1 USDC.
[Unsigned funding manifest](../evidence/ts-usdc-cross-j-poc/fresh-ubkyjm-funding-authority-unsigned.json)

### Confirmed funding for the repeat stand

On 2026-11-19 the owner authorized the nine exact calls through 19:25 UTC.
Every receipt succeeded with at least 12 confirmations. Each E2R was sent
after its approval reached confirmation depth and the signed call passed
the Hanko and gas checks. The independent RPC matched all nine receipts.
Funder nonces advanced to 119 on Ethereum Sepolia and 41 on Arbitrum Sepolia.

| Chain            |   Hub reserve | ETH to Hub signer | User wallet credit   | Actual gas fees, ETH | Actual funder outflow, ETH |
| ---------------- | ------------: | ----------------: | -------------------- | -------------------: | -------------------------: |
| Ethereum Sepolia | 0.000001 USDC |         0.001 ETH | 1 USDC and 0.002 ETH | 0.000095495414680689 |       0.003095495414680689 |
| Arbitrum Sepolia |     1.00 USDC |        0.0001 ETH | 0.0001 ETH           |    0.000004959901574 |          0.000204959901574 |

[Receipts and accounting](../evidence/ts-usdc-cross-j-poc/fresh-ubkyjm-funded-public.json)

### Reserve restore and one-USDC quote

The read-only session recovered the original `fresh-UbkYJm` Hub, MM and user
stores. The Hub recorded the Ethereum Sepolia E2R in frame 51 and the Arbitrum
Sepolia E2R in frame 53. Both events match their funding receipt hashes and
block hashes. Independent replay at Hub frame 56 recovered 0.000001 USDC on
Ethereum and 1 USDC on Arbitrum. WAL integrity checks covered 110 frames.

At 17:52:47 UTC on 2026-11-19, both operators were ready and the best matching
MM offer covered the full 1 USDC at price ticks 9,999 with zero lot dust.
The gross target amount was 0.999900 USDC, the signed Hub tariff charged
0.100099 USDC, and the projected payout was **0.899801 USDC**. The target
Hub reserve covered the payout, and the Hub and user had zero active debts.
The Accounts still require the user's source deposit and 0.999900 USDC of
target Hub credit for execution. The offer carried an expiry at 00:00 UTC on
2026-11-20. Recheck it before preparing the separately authorized journey.

After the quote was recorded, the session forced Hub to stop at the
shutdown timeout. All owned processes exited, listeners closed, and the
stand lease released. The independent replay verified the final WAL head.
The session produced zero public signatures and broadcasts.
[Authenticated reserves, replay and quote](../evidence/ts-usdc-cross-j-poc/fresh-ubkyjm-reserves-and-quote.json)

### Unsigned repeat journey

The `fresh-ubkyjm-1usdc-20261119` manifest binds five fresh nonce slots,
three payer EOAs, and the original `fresh-UbkYJm` catalog. Current and archive
RPCs agreed on anchors 12,170,002 and 330,807,622. The source wallet holds
1 USDC, both user Accounts start with zero reserve and collateral, and the
target Hub retains 1 USDC of backing. Latest and pending payer nonces are zero.

| Chain and payer       | Operation                          | Nonce | Gas cap per call |        Fee ceiling |
| --------------------- | ---------------------------------- | ----: | ---------------: | -----------------: |
| Ethereum Sepolia user | Approve, E2R, R2C                  |   0–2 |          600,000 | 0.001800 ETH total |
| Arbitrum Sepolia Hub  | Cover R2C                          |     0 |          500,000 |       0.000050 ETH |
| Arbitrum Sepolia user | Settlement and external withdrawal |     0 |          700,000 |       0.000070 ETH |

The exact unsigned approval estimate was 140,018 gas. The other four stages
use prior confirmed receipts on the same deployed contracts as a baseline.
Each still requires estimation on its own Hanko after the preceding step
confirms. Recheck the live offer, signed tariff, backing and nonces before the
first broadcast, then recheck the net payout before Cross-J. The prior live
sample projected 0.899801 USDC, within the 0.850000–1.000000 USDC guard.

The manifest remains unapproved and expires at 19:59 UTC on 2026-11-19.
Its SHA-256 is `c8c674dcf210dd07ff580fcb0fa2712fab35dd4a6d6a3db4a55c87a4b7407fbe`.
Preparation signed and broadcast zero public transactions.
[Unsigned journey manifest](../evidence/ts-usdc-cross-j-poc/fresh-ubkyjm-journey-authority-unsigned.json) · [Read-only preflight and gas evidence](../evidence/ts-usdc-cross-j-poc/fresh-ubkyjm-journey-preflight.json)

### Repeat journey completed

On 2026-11-19 `fresh-ubkyjm-1usdc-20261119` deposited exactly 1 USDC on
Ethereum Sepolia, settled Cross-J for 0.999900 USDC gross, and paid
**0.899801 USDC** to `0xc610e84b42230a7294852f8f5d6cf2f6a181778a` on
Arbitrum Sepolia. The signed Hub tariff charged 0.100099 USDC. Current
and archive RPCs matched the exit receipt and exact wallet credit.

| Chain            | Operation              | Nonce |       Block | Gas used |
| ---------------- | ---------------------- | ----: | ----------: | -------: |
| Ethereum Sepolia | Approve 1 USDC         |     0 |  12,170,066 |  137,757 |
| Ethereum Sepolia | Deposit 1 USDC         |     1 |  12,170,068 |  347,118 |
| Ethereum Sepolia | Post source collateral |     2 |  12,170,073 |  234,776 |
| Arbitrum Sepolia | Cover the target claim |     0 | 330,810,860 |  165,412 |
| Arbitrum Sepolia | Settle and withdraw    |     0 | 330,810,954 |  321,132 |

The quote, signed tariff, backing, balances and nonces passed the final
check before the first broadcast. The user Runtime recalculated payout
before dispatching Cross-J. The gateway estimated each exact signed call
after the preceding receipt and verified all four batch Hankos. All five
receipts succeeded. Native fees were 12,234,067 wei on Ethereum Sepolia
and 9,761,708,672,000 wei on Arbitrum Sepolia, within all payer budgets.

Replay from user WAL frame 52 recovered both route legs as settled with
zero remainder and zero live Pulls. The integrity check covered 215 WAL
frames across the three Runtimes. The execution CLI and shutdown both
completed, and the stand lease was released.
[Receipts, payout and WAL replay](../evidence/ts-usdc-cross-j-poc/fresh-ubkyjm-journey-executed.json)

## Public execution result

On 2026-11-18 the run `fresh-w4vgds-1usdc-20261118-guarded` deposited
**1.000000 USDC** on Ethereum Sepolia, settled Cross-J for **0.999900 USDC**
gross, and paid **0.899801 USDC** to
`0xb77348f8f01e060934024fefc319c66653df6fa2` on Arbitrum Sepolia.
The signed Hub tariff charged 0.100099 USDC. An independent read of the
withdrawal receipt and the destination wallet confirmed the exact payout.

| Chain | Operation | Nonce | Block | Gas used |
| --- | --- | ---: | ---: | ---: |
| Ethereum Sepolia | Approve 1 USDC | 0 | 12,163,876 | 137,757 |
| Ethereum Sepolia | Deposit 1 USDC | 1 | 12,163,878 | 347,130 |
| Ethereum Sepolia | Post source collateral | 2 | 12,163,883 | 234,776 |
| Arbitrum Sepolia | Cover the target claim | 0 | 330,528,245 | 165,384 |
| Arbitrum Sepolia | Settle and withdraw | 0 | 330,528,364 | 321,104 |

All five receipts succeeded within the approved gas caps. Current and
archive RPCs agreed on each receipt. Native fees reconciled to the balance
changes for all three payers. Ethereum spent 13,438,821 wei. Arbitrum
spent 9,821,816,720,000 wei across Hub and user. Both Arbitrum receipts
recorded `gasUsedForL1: 0x0`. The target Hub retained 0.100199 USDC in
reserve. Both user Account positions cleared.
[Raw transactions and receipts](../evidence/ts-usdc-cross-j-poc/fresh-public-demo-raw-receipts.json)

The external gateway checked the original catalog. Its temporary read
profile selected header and receipt upstreams by range size. The first
startup reached operator readiness and stopped at an incorrect local
process-list check in the quote probe. The corrected preflight then
completed before the single financial invocation.

After financial finalization, the automated report's `eth_getLogs` read
requested 224 Arbitrum blocks. The archive provider allowed 10 per request
and returned HTTP 400. The receipt reconciliation used the five exact
payer nonces. User WAL replay at frame 67 confirmed both route legs
`settled` with zero remainder, and all 388 WAL frames passed integrity
checks. The stand stopped and all five authorized nonce slots were consumed.
[Public receipts, replay and accounting](../evidence/ts-usdc-cross-j-poc/fresh-public-demo-executed.json)

## Public funding result

On 2026-11-18 the owner authorized the exact nine-call packet for
`fresh-w4vGds`. A repeated preflight verified the executable and catalog
binding, chain anchors, unused nonce slots, balances and fee caps before
submission. All nine calls succeeded with at least twelve confirmations
each. The executor reconciled wallet balances, reserves, backing, debt
and funder nonces against the approved packet.

| Chain | Demo Hub reserve | ETH credited to Hub signer | User wallet credit | Actual gas fees | Total funder ETH outflow |
| --- | ---: | ---: | --- | ---: | ---: |
| Ethereum Sepolia | 0.000001 USDC | 0.001 ETH | 1 USDC and 0.002 ETH | 0.000095491414323710 ETH | 0.003095491414323710 ETH |
| Arbitrum Sepolia | 1 USDC | 0.0001 ETH | 0.0001 ETH | 0.000004947420708 ETH | 0.000204947420708 ETH |

The confirmed E2R receipts consumed 256,202 gas on Ethereum and 149,634
gas on Arbitrum. The funder nonces after the packet were 114 and 37.
Both chains' actual gas fees and total native outflows fit the approved
limits. The nine slots in this authorization are consumed.

The user received its source principal in its external Ethereum wallet.
[Exact funding evidence and receipt references](../evidence/ts-usdc-cross-j-poc/fresh-public-demo-funded.json)

## Funded WALs and quote

The read-only restore verified the exact two E2R receipts against the
Hub's committed `ReserveUpdated` inputs. A second restore loaded both
amounts from Hub frame 57.

| Chain | Public block | Hub Runtime frame | Committed reserve |
| --- | ---: | ---: | ---: |
| Ethereum Sepolia | 12,163,247 | 54 | 0.000001 USDC |
| Arbitrum Sepolia | 330,502,193 | 56 | 1.000000 USDC |

At 19:17:01 UTC on 2026-11-18, both operators were ready. The best live
committed MM offer covered exactly 1.000000 source USDC without lot
dust. It quoted 0.999900 USDC gross on Arbitrum and expired at 00:00
UTC on 2026-11-19. The signed target Account tariff specified a
0.100000 USDC base fee plus 1 basis point, rounded down to token
precision, and a zero gas surcharge. The total fee was 0.100099 USDC,
yielding an estimated external payout of **0.899801 USDC**. The target
Hub reserve covered that amount. At Arbitrum block 330,508,751, the
Depository held 6 USDC and both checked active debt counters were zero.

Hub and user matched both signed bilateral Account frames. Source
Account spendable capacity and destination credit were both zero. The
journey requires the user's 1 USDC deposit and 0.999900 USDC of exact
target Hub credit at this quote. Ethereum and Arbitrum network gas
require separate payer budgets.

Sharing HyperSync for Arbitrum headers led to HTTP 429 during MM
catch-up. The protected archive RPC passed a 128-header probe and also
rate-limited sustained catch-up. The successful restore used PublicNode
for Hub headers and HyperSync for MM headers. The session supervisor
exceeded its shutdown timeout after capturing the quote. All operator
processes stopped, the stand lock released, and the offline check
verified 96 Hub, 53 MM and 12 user WAL frames. This check sent zero
public transactions.
[Reserve proofs, quote and shutdown evidence](../evidence/ts-usdc-cross-j-poc/fresh-public-demo-reserves-and-quote.json)

## Current demo preparation

On 2026-11-18, the refreshed stand at
`.logs/ts-usdc-cross-j-poc/demo/fresh-w4vGds` reached Jurisdiction
readiness in 20.761 s for Hub and 42.012 s for MM. It kept the existing
deployed stacks and created separate unfunded Hub/MM vaults and stores.
The retained user vault supplied the same Ethereum and Arbitrum
signers through a local link to the protected seed. The user Runtime
opened two bilateral Accounts at frame 2 through the authenticated
relay. Hub and user agreed on both signed Account frames.

| Role | Ethereum Sepolia anchor | Arbitrum Sepolia anchor | Verified WAL head |
| --- | ---: | ---: | ---: |
| Hub | 12,163,169 | 330,496,209 | 52 |
| MM | 12,163,171 | 330,496,275 | 36 |
| User | | | 12 |

Canonical restore verified both operator heads. The user restore
matched its Runtime root, Entity roots and both Accounts. The live user
queue was empty at observation. The restored queue contained the single
Account input recorded in the committed WAL, and its digest matched the
committed payload. The operator startup probe and inspections exited.
The stand is available for the separately approved funding step.

The refreshed funding manifest binds the new Hub recipients, retained
user addresses, current executable digest and fresh chain anchors.
It contains five Ethereum and four Arbitrum calls. The seven simple
estimates fit the same caps. Both 600,000-gas E2R caps remain conditional
on confirmed allowances and authorized Hankos. The draft maximum funder
outflow, including topups, is 0.004600 ETH on Ethereum and 0.000329 ETH on
Arbitrum. The manifest expires at 18:21:49 UTC on 2026-11-19.
Its status is `approved: false`. The preparation created zero public
transaction signatures and broadcast zero transactions.
[Refreshed accounts, replay and funding packet](../evidence/ts-usdc-cross-j-poc/fresh-public-demo-refresh.json)

## Initial preflight

The read-only preflight reached Jurisdiction catch-up on the existing Sepolia
and Arbitrum Sepolia stacks with two new TypeScript operator Runtimes. Hub
reached this boundary after **16.052 s** and MM after **35.074 s** from probe
start. The new stores and vaults are distinct from the original funded stores
tracked by ticket 12. The retained test user's vault was used only to derive
the addresses for balance checks. [Public preflight evidence](../evidence/ts-usdc-cross-j-poc/fresh-public-demo-preflight.json)

## Verified startup and recovery

The probe used the existing USDC catalog, public header endpoints and the
protected history bindings. It checked that the new operator addresses and
Entities were unfunded before launch. The Hub reached J readiness before MM
started. Both operators committed a storage-proof-backed `j_anchor` per chain.

| Role | Ethereum Sepolia anchor | Arbitrum Sepolia anchor | Verified WAL head |
| --- | ---: | ---: | ---: |
| Hub | 12,157,354 | 330,228,635 | 36 |
| MM | 12,157,355 | 330,228,690 | 27 |

Hub reserve readiness and MM maker readiness were false at the end of the
unfunded probe. The session wrapper force-stopped Hub after its ten-second
shutdown wait. A separate canonical `requireRestore` inspection then loaded
both committed heads and verified the persisted state and both J finalities
for each Runtime. That inspection exited cleanly. The original and demo
operators are stopped, with zero public transaction broadcasts from the probe.

[Existing fresh-anchor code](../../core/jurisdiction/adapter/rpc/watcher/rpc-watcher-anchor-start.ts#L62) · [Startup, shutdown and replay evidence](../evidence/ts-usdc-cross-j-poc/fresh-public-demo-preflight.json)

## Draft token quantities for one run

| Chain | Recipient | USDC | Basis |
| --- | --- | ---: | --- |
| Ethereum Sepolia | Existing user signer `0x61ff…9446` | 1.000000 | Exact source principal. The signer had zero USDC and zero ETH at the observed block. |
| Ethereum Sepolia | New Hub Entity reserve | 0.000001 | One atomic unit is the minimum for the current positive-reserve readiness predicate. Test this size against the funded route. |
| Arbitrum Sepolia | New Hub Entity reserve | 1.000000 | Proposed funding for one cover. The retained local price and tariff yielded a 0.899801 USDC cover and payout. Refresh the executable public quote and check free backing. |

The observed funder inventory was 8 USDC on Ethereum Sepolia and 15 USDC on
Arbitrum Sepolia. The original Hub Entities still held 1 and 5 USDC respectively.
The selected setup uses MM bilateral credit and Hub reserves for backing the
cover. The payout recipient remains the selected user's Arbitrum signer
`0xb773…6fa2`.

The RPC estimated 139,993 gas units for the Ethereum Hub reserve approval,
154,151 for the source principal transfer and 140,018 for the user approval.
The Arbitrum Hub reserve approval estimate was 56,240 gas units. The exact
E2R deposits, signed cover, payout and recovery still need estimates to produce
numeric payer-specific ETH limits. Check source user, target user and target
Hub native balances against the resulting plan. The token quantities above
are a draft, with any broadcast subject to explicit approval.

[Capital and tariff projection](usdc-poc-capital-plan.md#credit-maker-depth-and-one-usdc-economics) · [Positive-reserve predicate](../../core/orchestrator/hub/node/hub-reserves.ts#L41)

## Unsigned funding proposal

The [one-run proposal](../evidence/ts-usdc-cross-j-poc/fresh-public-demo-funding-proposal.json)
binds the retained fresh Hub Entities, the selected user's two EOAs and funder
`0x42Da…fe25b` to verified chain snapshots. It records exact calldata for the
seven simple calls and encoded batches and Hanko digests for both E2R calls.
Funder nonce observations are 109 on Ethereum Sepolia and 33 on Arbitrum
Sepolia, with no pending funder transactions at the sampled points. Each E2R
would use funding Entity nonce 4 on its chain.

| Proposed payment or ceiling | Ethereum Sepolia | Arbitrum Sepolia |
| --- | ---: | ---: |
| USDC to new Hub reserve | 0.000001 | 1.000000 |
| USDC to user wallet | 1.000000 | 0 |
| ETH to new Hub signer | 0.001000 | 0.000100 |
| ETH to user signer | 0.002000 | 0.000100 |
| Funder gas-fee ceiling, ETH | 0.001600 | 0.000129 |
| Maximum funder ETH outflow including topups | **0.004600** | **0.000329** |

The proposal carries five calls on Ethereum and four on Arbitrum. All seven
measured calls fit the proposed gas limits. The E2R limit is 600,000 gas per
chain, conditional on estimation after the allowance is confirmed and the
authorized Hanko is available. Fee ceilings use the previous per-gas settings
of 1 and 0.1 gwei as proposal bounds. Initial native topups are provisional,
with separate measured cover, payout and recovery limits still required.

The same funding executor supports the three-slot operator grants and the
one-run demo grants. In the demo limits, each chain has a `userFunding` object
with the exact `signer`, `usdcAtoms`, `nativeTopupWei`, `principalTransfer` fee
cap and `nativeTopup` fee cap. Arbitrum has `usdcAtoms: "0"` and
`principalTransfer: null`. The selected vault must derive the listed signer on
each chain. Revalidate balances, allowances, gas and both nonce domains at
execution. The proposal remains `approved: false` and contains zero signatures
or broadcasts.

To refresh the one-run authority from reviewed limits, use `funding/index.ts
prepare` with the demo `--directory` and `--user-vault` pointing to the original
user vault directory. The latter binds the user without copying its key or
opening its Runtime store. The prepare command emits `approved: false` and
estimates each simple transfer, with the deposit cap still conditional. The
execution command requires an explicitly approved authority for the exact
scope and the same vault binding.

Both funding scopes passed the local two-chain scenario, including interrupted
submission, nonce recovery, receipt reconciliation and exact Hub WAL restore.
The refreshed public manifest uses the tested candidate and matches the nine
reviewed calls. It remains unsigned and unapproved. Its path, expiry, checksum
and fresh chain anchors are recorded with the validation results.

[Executor verification and unsigned manifest details](../evidence/ts-usdc-cross-j-poc/fresh-public-demo-funding-executor.json) · [Operator-only funding grant](usdc-poc-operator-funding.md#prepare-without-signing)

## One-run package

The CLI prepared the unsigned run `fresh-w4vgds-1usdc-20261118-guarded`
with `approved: false` and expiry at 23:30 UTC on 2026-11-18. The
execution candidate includes the payout-floor check before Cross-J
submission. Current and archive RPCs agreed on both refreshed anchors
and the three payer nonces. Current contract code and native balances
matched the five-slot reservation. The previous draft's candidate digest
is rejected for this code.
[Current unsigned manifest](../evidence/ts-usdc-cross-j-poc/fresh-public-demo-one-run-guarded-authority.json) · [Refreshed checks](../evidence/ts-usdc-cross-j-poc/fresh-public-demo-one-run-guarded-preparation.json) · [Original gas evidence](../evidence/ts-usdc-cross-j-poc/fresh-public-demo-one-run-preparation.json)

| Chain | Payer | Calls and EOA nonces | Gas cap per call | Fee cap per gas | Maximum ETH fee | Observed ETH |
| --- | --- | --- | ---: | ---: | ---: | ---: |
| Ethereum Sepolia | Source user | Approve, E2R, R2C at 0–2 | 600,000 | 1 gwei | 0.001800 | 0.002000 |
| Arbitrum Sepolia | Target Hub | Cover R2C at 0 | 500,000 | 0.1 gwei | 0.000050 | 0.000100 |
| Arbitrum Sepolia | Target user | Combined C2R/R2E at 0 | 700,000 | 0.1 gwei | 0.000070 | 0.000100 |

The public source approval estimated 140,018 gas. The four other caps
use the successful first-run Anvil receipts and their transaction gas
limits. The earlier Ethereum funding E2R used 256,202 gas with a different
payer and amount. The two Arbitrum calldata samples returned zero L1
posting gas at the sampled block. For the actual calls, apply the Runtime's
20% headroom to the exact `eth_estimateGas` with the authorized Hanko after
the prerequisite state commits. The Arbitrum estimate already includes
the L1 posting component.
[Local financial receipts](../evidence/ts-usdc-cross-j-poc/local-evidence.md#public-financial-clijson) · [Arbitrum gas estimates](https://docs.arbitrum.io/arbitrum-essentials/how-to-estimate-gas)

The restored Hub book still quoted 0.999900 USDC gross and 0.899801 USDC
net at 19:26:19 UTC. Both signed bilateral frames matched and target
backing passed at block 330,510,705. Hub delivery was still catching up
and MM had yet to start. After the book check, the read-only stand stopped
and all 163 WAL frames passed integrity verification. Repeat the live
quote and backing checks with both operators ready before starting the
journey. The manifest binds the allowed calls and counterparties. After
preparing source collateral, the CLI requires the selected maker quote
to yield at least 0.850000 USDC under the signed effective Hub tariff
before it submits the Cross-J intent. A rejection leaves the source
collateral in place. The cover stage checks the effective tariff again.

For an interruption, restore the original WAL with the same manifest and
run ID. Reconcile receipts, allowance and nonces. Same-nonce replacements
must fit the existing caps and use the Runtime's minimum 12.5% bump.
A mined revert consumes its slot. A new-nonce retry, expired authority or
forced dispute requires separate preparation and authorization for the
remaining obligation. A 5,000,000-gas dispute batch at the normal per-gas
ceilings would cost up to 0.005 ETH on Ethereum or 0.0005 ETH on Arbitrum.
These are bounds for one batch. The actual public dispute gas and budget
depend on the signed proof and remaining state.
[Local recovery results](../evidence/ts-usdc-cross-j-poc/local-evidence.md#interrupted-recoveryjson)

## Guarded candidate readiness

On 2026-11-18 both restored operators reached readiness in a read-only
session. The authenticated scan passed every startup target.

| Runtime | Ethereum startup target | Arbitrum startup target | WAL frames verified after shutdown |
| --- | ---: | ---: | ---: |
| Hub | 12,163,567 | 330,514,309 | 117 |
| MM | 12,163,584 | 330,515,045 | 63 |
| User | | | 12 |

At 19:52:25 UTC the committed MM book had nine live matching offers.
The selected offer covered the entire 1 USDC at price ticks 9,999,
with 0.999900 USDC gross and 0.100099 USDC in signed Hub fees.
The CLI's payout guard accepted the **0.899801 USDC** projected payout.
The Arbitrum Hub held 1.000000 USDC in reserve at block 330,516,263,
with zero active debts for the Hub and user. Both signed Account frames
matched. Source Account capacity was zero and the target credit required
by this quote was 0.999900 USDC. Both manifest anchors, all three payer
nonces and the reserved native budgets passed the live recheck.

The first attempt hit PublicNode rate limits on large header ranges.
The successful observation used a temporary read-only gateway profile.
It routed Arbitrum ranges of more than 32 blocks to HyperSync and shorter
ranges to PublicNode. The Runtime used its existing header and receipt
proof checks. HyperSync returned 64 successful pages during this attempt.
Both operators were ready and the quote was captured after 570.455 s.

The observation supervisor exceeded its shutdown deadline after capture.
All owned processes and listeners stopped, the stand slot released and
all 192 WAL frames passed validation. The user WAL stayed at frame 12.
The session submitted zero public financial commands or transactions.
[Startup targets, live quote, payer checks and shutdown evidence](../evidence/ts-usdc-cross-j-poc/fresh-public-demo-guarded-live-readiness.json)

## Public execution startup stop

On 2026-11-18 the managed gateway rejected the approved run before Hub,
MM or the financial CLI started. The source catalog matched the manifest.
The launcher passed a decoded session copy to the gateway. The copy
omitted deployment metadata and had a different digest, which triggered
`USDC_EXECUTION_AUTHORITY_CANDIDATE_CHANGED`.

After shutdown, current and archive RPC observations confirmed zero
consumed nonce slots, no pending payer transactions and the full 1 USDC
still in the Ethereum user wallet. All 192 WAL frames passed validation.
The attempt's local authority copy was disabled. There are zero public
transaction signatures, broadcasts or receipts for this attempt.
[Startup failure and post-stop verification](../evidence/ts-usdc-cross-j-poc/fresh-public-demo-one-run-catalog-mismatch.json)

The documented external-gateway mode can bind the independently managed
gateway to the original catalog and give the Runtime launcher its decoded
session copy. The local financial journey test uses this launch mode.
[Execution guide](usdc-poc-execution.md#start-operators-and-execute-one-run) · [Local journey test](../../core/__tests__/market/startup/usdc-public-journey.test.ts#L163)

The separate gateway passed a read-only startup on the original catalog
at 20:06 UTC. Both anchors and all three payer nonces matched again.
The source wallet had 1 USDC with zero allowance. The exact public
approval estimate was 140,018 gas. The target Hub still held 1 USDC
and the native balances covered all five remaining nonce slots.
The retry uses the same unsigned manifest and run ID.
[External gateway retry preparation](../evidence/ts-usdc-cross-j-poc/fresh-public-demo-external-gateway-retry.json)

## Before the public demo

1. Obtain explicit authority for the one-USDC deposit, Cross-J execution
   and payout under the reviewed manifest.
2. Restore the same operator stores with the authorized gateway. Wait for
   both operators and refresh the live offer, signed tariff, exact credit,
   backing, native balances and payer nonces. Verify exact per-stage gas as
   each prerequisite commits.
3. Retain the source debit, Cross-J execution and external Arbitrum payout
   receipts under the single run ID.

[Financial CLI](usdc-poc-execution.md) · [Original funded restore ticket](../../.scratch/ts-usdc-cross-j-poc/issues/12-public-rpc-capacity-and-funded-catchup.md)

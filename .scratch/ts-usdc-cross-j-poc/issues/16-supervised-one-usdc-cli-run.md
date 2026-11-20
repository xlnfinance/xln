# 16: Supervise the authorized one-USDC journey from the execution CLI

Type: implementation
Category: enhancement
Completed: yes
Status: ready-for-agent
Blocked by: 04 - Interrupted journey recovery; 05 - Public single-run preparation; 08 - Public financial CLI; 09 - Funded Runtime restore; 13 - Exact nonce-based receipt reporting

## Problem

The operator starts the gateway and Hub/MM supervisor separately from `execution run`. The managed gateway once received a decoded catalog copy with a different digest, so the approved run stopped before startup. The financial CLI checks the quote and signed tariff before Cross-J, after the source approval, deposit, and collateral posting. The successful public demo also checked the executable payout and its backing before the first approval through an operator-run preflight.

## Deliverable

Extend the existing TypeScript `execution run` entry point for one approved run on an already funded stand. The stand descriptor selects the original preparation directory and the exact Hub, MM, and user WAL stores. The in-scope invocation is:

```sh
bun jurisdictions/scripts/usdc-cross-j-preflight/execution/index.ts run \
  --stand stand.json --authority-file journey.approved.json \
  --run-id demo-01 --output result.json
```

## Acceptance criteria

- [x] Own one stand lease and reuse the existing gateway, session supervisor, and exclusive store ownership. Check the original catalog digest against the approved authority, restore Hub/MM from the selected WALs, and require their live readiness. The financial runner owns the user store. Release owned children and the lease on completion or stop.
- [x] Before the first approval of a fresh run, verify the exact approved candidate and nonce slots, payer balances and pending nonces, an executable maker quote for all `1_000_000` source units, the effective signed Hub tariff, and free target Hub backing for the projected payout. Require `850_000–1_000_000` USDC atomic units of net payout. Record the quote, signed tariff version, backing, and the chain blocks used for this decision.
- [x] Recheck the executable net payout before dispatching Cross-J. Use the canonical execution and gateway path for the five authorized calls. Preserve the existing per-call and cumulative ceilings, exact Hanko checks, and dependent calldata estimation after the prerequisite confirmation.
- [x] Derive progress for an interrupted run from the original WAL and exact nonce receipts. A valid authority and the same run ID can continue the accepted position without another deposit. If payout deteriorates after collateral posting or the authority expires, report the last confirmed step, known hashes, and remaining position. C2R, a replacement transaction, and additional funding each require their own grant for this run.
- [x] On success retain the existing exact receipt report, the recorded preflight, and the signed Cross-J evidence available from canonical execution and replay. Bind the evidence to the candidate, manifest, and run ID. Reports support inspection, while WAL and verified chain evidence determine financial progress.
- [x] Exercise the supervised entry point with the existing two-Anvil fixtures. Show exactly three source and two target receipts and the expected `899_801`-unit payout at the fixture terms. Invalid catalog or insufficient preflight economics must leave payer nonces unchanged with zero submissions. A degraded quote after collateral must stop before Cross-J. Interrupt after deposit and after withdrawal, then verify that the same run ID reconciles the existing receipts and never debits a second principal. Expired authority must stop before a new submission.

## Local verification

The supervised integration test held the stand lease on two local Anvil chains.
With 500,000 USDC atomic units of target backing, it recorded zero source
submissions and unchanged payer nonces. A later reduction to 800,000 units
after preflight made the quote unexecutable. The runner stopped before Cross-J
with three verified source receipts and 1,000,000 units in collateral.
Restoring the backing and reusing the same authority and run ID delivered
899,801 units to the target wallet. The final record contained three source and
two target receipts, both settled route legs, and three total source submissions.

The tariff regression holds the signed Account frame fixed while the next frame
crosses the tariff's effective timestamp. The earlier quote yields 899,801
units and the signed increase yields 799,801. Pricing rejects the increase
when it applies at the next frame or during the authorized payout window.

The supervisor fixture paused the financial child at deposit and withdrawal,
waited for each receipt, then killed that child. Each restart used the same
stand, manifest, and run ID. The final report preserved both original hashes
and the approval preflight. Exactly three source and two target transactions
were submitted across the full exercise. A blocked output path also preserved
the original insufficient-backing error.

With the first approval pending, the fixture interrupted the financial child
and dropped the transaction from Anvil. It hid the preflight report before
restarting. The same grant and run ID recovered the original hash from the
Runtime WAL, stopped with zero additional submissions, and reported a null
preflight while that file was absent. After the fixture confirmed the original
signed bytes, the runner resumed. The backing check rejected a fork that shared
the original anchor but had a different hash at the observed block. A quote with wall time two
milliseconds before expiry was rejected when the committed Hub reached expiry.

An RPC read failure after cover stopped the run with 899,801 units of target
collateral, zero target reserve and zero uncovered claim. Status resolved the
cover hash from the stopped Hub WAL while the archive returned HTTP 429.
After withdrawal, the resumed completion report recovered the original
Cross-J intent and both signed Account close certificates from the user WAL.
The history regression places a wrong-signer ACK before a valid ACK for the
same frame and verifies that the close certificate uses the valid signature.
It also checks rejection of a changed Hanko and a missing retained WAL frame.
The fixed-fee regression verifies exact-byte retries and refuses to send an
unmined sibling.

A separate fixture let the grant expire while approval remained in the Anvil
mempool. The stop report retained its exact hash and preflight record, with
the four dependent slots still unobserved.

- Supervised integration test, 80 assertions in 125.06 seconds.
- Pending approval and read-only status regressions, 31 assertions in 96.15 seconds.
- Existing five-run recovery regression, 70 assertions in 120.65 seconds.
- The focused storage, fee, authority, quote, tariff and RPC suites passed
  112 tests and 549 assertions.
- Deployment TypeScript validation, folder-width check, and `bun run check`
  passed. The latter ran 3 short, 38 source, and 10 soundcheck gates.

The final pre-commit supervised run identifies base `d00068e750788b2c77adf1d5bb5b27184baa2b66`
and the formatted working-tree candidate digest
`5e12276b050a611b1bf70997e537c05d14c9240c583a2404f71e344ab2163ddc`.

The regression held the cover broadcast at the RPC boundary. An authenticated
read returned its exact prepared hash from the live Hub WAL before the chain
endpoint could see it. The stop report later identified that same transaction
by hash. The Hub returns only the requested payer and nonce's known hashes.

During the cover backing check, the Hub committed tariff version 2 with the
same fee. The Account rejected the version 1 request before debiting its fee.
The committed rejection identified the exact request digest. After the queues
drained, the CLI reverified the signed version 2 terms and backing. One cover
and one withdrawal completed with the expected payout.

The supervisor also tested a reserve reduction during approval gas estimation.
The final backing check stopped before the first source submission. In the
stop after cover, the source archive was unavailable through report construction.
The verified materialized WAL supplied both positions and the retired source
attempts. The current RPC confirmed all three source slots by exact hash.

## Related work

- [15](15-clean-candidate-public-proof.md) records separately authorized public execution on a verified clean candidate. The local test result for 16 supplies implementation evidence.
- [17](17-read-only-usdc-run-status.md) tracks read-only run inspection after the supervised runner exits.
- [Current execution order](../../../jurisdictions/scripts/usdc-cross-j-preflight/execution/flow/run.ts)
- [Managed gateway catalog mismatch](../../../docs/runtime/usdc-poc-fresh-demo.md#public-execution-startup-stop)
- [Successful public preflight and five receipts](../../../docs/evidence/ts-usdc-cross-j-poc/fresh-ubkyjm-journey-executed.json)
